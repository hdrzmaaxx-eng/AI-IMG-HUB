#!/usr/bin/env node
'use strict';

/* ============================================================================
 * 批量修图 · 本地服务（零第三方依赖）
 *   Node 18+（推荐 20 / 22）
 *
 * 它做三件事：
 *   1) 托管前端页面（public/）
 *   2) 代理调用上游图像模型 API（默认 banana-2，Gemini 兼容协议）
 *      —— 放服务端走是因为浏览器直连会被 CORS 拦
 *   3) 扫描本地文件夹 → 并发批量处理 → 结果写回磁盘
 *
 * 启动：node server.js           （默认 http://127.0.0.1:8788）
 *       node server.js 9000      （指定端口）
 *       node server.js --no-open （不自动打开浏览器）
 * ========================================================================== */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { spawn } = require('child_process');

const APP_DIR = __dirname;
const PUBLIC_DIR = path.join(APP_DIR, 'public');
// 配置文件位置。用 APP_CONFIG 环境变量可以指向别处 —— 自动化测试必须用它，
// 否则测试写配置会把使用者真实的 API Key 覆盖掉（这个坑已经踩过一次）。
const CONFIG_PATH = path.resolve(process.env.APP_CONFIG || path.join(APP_DIR, 'config.json'));

const HOST = '127.0.0.1';
const argv = process.argv.slice(2);
const NO_OPEN = argv.includes('--no-open');
const PORT = Number(argv.find((a) => /^\d+$/.test(a)) || process.env.PORT || 8788);

// 每次启动生成的一次性口令：页面会拿到它，其它来源的请求拿不到（跨域读不到页面）
const APP_TOKEN = crypto.randomBytes(16).toString('hex');

/* ------------------------------------------------------------------ 常量 */

/**
 * 生图记录落盘位置：thumb 由前端 canvas 生成后传上来，服务端不做图像处理。
 *
 * 布局（按对话分组，一个对话一个目录）：
 *   records/<conv_xxx>/index.json     这个对话的生图记录清单
 *   records/<conv_xxx>/jobs.json      这个对话的批量任务历史
 *   records/<conv_xxx>/<recordId>/    单条记录的原图 / 缩略图
 *   records/_legacy/…                 没有 convId 的老记录 / 老任务
 *   records/.cache/dir-cache.json     「文件夹名 → 绝对路径」速查表（不是记录，只是缓存）
 *   records/AI-IMG-HUB-手机端.html    作者放这儿的单文件手机端，跟记录无关，别清
 *
 * 为什么按对话分：一个对话的东西聚在一个目录里，肉眼能看、能整包拷走、能整包删；
 * 各对话的清单也各自写各自的文件，不会再出现「写着写着把别处的记录覆盖掉」。
 */
const RECORD_DIR = path.join(APP_DIR, 'records');
/** 每个对话各留多少条生图记录 */
const RECORD_LIMIT = 60;
/** 最多保留多少个对话目录（按最近一条记录的时间淘汰，防老对话无限堆积） */
const RECORD_CONV_LIMIT = 30;
/** 没有 convId 的记录 / 任务归到这个目录 */
const RECORD_LEGACY_DIR = '_legacy';
/** 旧版「全局一份」的落盘文件名：只在一次性迁移时用来认旧布局，迁完就删 */
const RECORD_INDEX_LEGACY = path.join(RECORD_DIR, 'index.json');
const BATCH_HISTORY_LEGACY = path.join(RECORD_DIR, 'jobs.json');
const DIR_CACHE_LEGACY = path.join(RECORD_DIR, 'dir-cache.json');

/**
 * 批量任务历史：只存「记录」，图仍然留在用户自己的输出目录里。
 * 注意它和 index.json 的区别：这里的 inputDir / outputDir / items[].abs / items[].out
 * 是使用者自己选的**外部绝对路径**，天然跟着机器走，没法相对化 ——
 * 换台电脑后这些路径就算不出来（界面会显示「图片读不到」），
 * 但提示词、参数、逐张状态、耗时这些文字信息仍然完整，重跑一次即可。
 * 生图记录（index.json）不一样：图就存在 records\ 里，所以那边存的是相对路径，整个目录可以搬走。
 */
/** 每个对话各留多少条批量任务历史 */
const BATCH_HISTORY_LIMIT = 20;

// 比例与分辨率档：按平台文档（jc.lk888.ai/apidoc）取并集 ——
// banana-2 支持 0.5K 与 1:4/4:1/1:8/8:1 超宽比例，tt-image-2 的 size 表里没有这两项，
// 遇到模型不支持的取值由 pickEnum / nearest* 吸附到最接近的合法值，并把替换写进提示。
const ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '1:4', '4:1', '1:8', '8:1'];
const IMAGE_SIZES = ['0.5K', '1K', '2K', '4K'];

// 默认支持的格式（能被模型正常吃下）
const EXT_CORE = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'];
// 非常规格式：默认不扫，勾选后尝试直传（可能被上游拒绝）
const EXT_EXTRA = ['.tif', '.tiff', '.avif', '.heic', '.heif'];

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif'
};

/* --------------------------------------------------- 接口来源与调用协议 */
//
// 两个「接口来源」，各自独立域名、独立 Key：
//   聚合引擎  api.lk888.ai   兼容 Gemini / OpenAI 两套协议，且自带平台原生的媒体异步协议
//   ALAPI     v3.alapi.cn    只有 gpt-image-2，参数自成一套
//
// 五个「调用协议」，决定请求打到哪个路径、是同步还是异步轮询。
const Catalog = require(path.join(PUBLIC_DIR, 'model-catalog.js'));

const PROVIDERS = {
  agg: {
    label: '聚合引擎',
    baseUrl: 'https://api.lk888.ai',
    baseUrlAliases: ['https://api.lk888.ai', 'https://api.lk666.ai', 'https://api.lingkeai.ai'],
    keyField: 'apiKey',
    keyHint: 'sk- 开头，在聚合引擎后台创建',
    docUrl: 'https://jc.lk888.ai/apidoc'
  },
  alapi: {
    label: 'ALAPI',
    baseUrl: 'https://v3.alapi.cn',
    baseUrlAliases: ['https://v3.alapi.cn'],
    keyField: 'alapiKey',
    keyHint: '在 ALAPI「token 管理」里生成的 token',
    docUrl: 'https://www.alapi.cn/api/107/api_document'
  }
};

const PROTOCOLS = {
  media: {
    label: '媒体异步',
    provider: 'agg',
    async: true,
    path: '/v1/media/generate',
    statusPath: '/v1/skills/task-status',
    statusPathLegacy: '/v1/media/status',
    nativeN: false,
    note: '平台原生协议，19 个图片模型全支持。提交后拿 task_id，轮询到 is_final 再取图。'
  },
  gemini: {
    label: 'Gemini 兼容',
    provider: 'agg',
    async: false,
    path: '/v1beta/models/{model}:generateContent',
    nativeN: false,
    note: 'banana 系的原生协议，同步返回。字段与 Google 官方 generateContent 一致。'
  },
  openai: {
    label: 'OpenAI 兼容',
    provider: 'agg',
    async: false,
    path: '/v1/images/generations',
    editPath: '/v1/images/edits',
    nativeN: true,
    note: 'tt-image / gpt-image 系可走；官方建议直接改用媒体异步。带参考图时自动切 images/edits 的 multipart 上传。'
  },
  alapi: {
    label: 'ALAPI 同步',
    provider: 'alapi',
    async: false,
    path: '/api/ai/images/generations',
    nativeN: true,
    note: '一次请求等到底。生成慢容易把连接挂死，官方推荐用异步。'
  },
  alapi_async: {
    label: 'ALAPI 异步',
    provider: 'alapi',
    async: true,
    path: '/api/ai/images/generations_sync',
    statusPath: '/api/ai/images/generations/task',
    nativeN: true,
    note: '提交后拿 task_id，轮询任务查询接口取图。免费的任务查询接口，推荐。'
  }
};

/**
 * 配置边界：config.json 只放三类东西 —— 凭据、接口、参数默认值。
 *
 * 不放界面状态。凡是「记住上次选了什么」的东西（提示词、上次的目录、各种勾选框）
 * 一律不进这里：它们改由前端 localStorage 持有，服务端不关心、也不读。
 * 想加新的持久化字段前先问一句「服务端执行任务时真的需要它吗」——
 * 答案是「不需要，只是想让页面下次打开还记得」的话，就不该加到这个对象里。
 *
 * 注意这里同时是 saveConfig 的写入白名单：不在这个对象里的键，
 * 从接口传上来也会被静默丢掉，落不到 config.json。
 */
const DEFAULT_CONFIG = {
  // —— 凭据 · 接口 ——
  provider: 'agg', // agg | alapi
  baseUrl: 'https://api.lk888.ai',
  apiKey: '', // 聚合引擎的 Key
  alapiKey: '', // ALAPI 的 token
  model: 'banana-2',
  protocol: 'gemini', // media | gemini | openai | alapi | alapi_async
  geminiPath: '/v1beta/models/{model}:generateContent',
  openaiPath: '/v1/images/generations',
  openaiEditPath: '/v1/images/edits',
  mediaPath: '/v1/media/generate',
  // 媒体异步的任务查询路径。必须在白名单里，否则设置面板改了也存不下来
  mediaStatusPath: '/v1/skills/task-status',
  alapiPath: '/api/ai/images/generations',
  alapiAsyncPath: '/api/ai/images/generations_sync',
  alapiTaskPath: '/api/ai/images/generations/task',
  authStyle: 'both', // both | goog | bearer
  imageFirst: true, // Gemini 请求里参考图是否放在提示词之前（Google 官方编辑示例的顺序）
  timeoutSec: 300,
  maxRetries: 2,
  // 异步协议的轮询节奏与总时限
  pollIntervalSec: 5,
  taskTimeoutSec: 900,

  // —— 提示词优化（调用文本模型改写提示词）——
  // 聊天类模型的默认端点是 POST /v1/chat/completions（OpenAI 兼容），见文档组件源码
  optimizerModel: 'gem-3.8-flash',
  optimizerProtocol: 'auto', // auto | openai | gemini
  optimizerPath: '/v1/chat/completions',
  optimizerBaseUrl: '', // 留空 = 跟随聚合引擎的地址（文本模型只在聚合引擎上）
  optimizerTimeoutSec: 180,

  // —— 参数默认值 ——
  // 请求体里带了就用请求体的，没带才回落到这里（见 /api/batch/start 等处的 body.X || cfg.X）
  aspectRatio: '1:1',
  imageSize: '2K',
  count: 1, // 生图数量 1~4：支持原生 n 的协议直接传 n，其余协议并发发多次请求
  concurrency: 3,
  suffix: '_修图'
};

/* ------------------------------------------------------------------ 配置 */

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return Object.assign({}, DEFAULT_CONFIG, raw);
  } catch {
    return Object.assign({}, DEFAULT_CONFIG);
  }
}

function saveConfig(patch) {
  const current = loadConfig();
  const next = Object.assign({}, current, patch || {});
  /**
   * Key 保护：绝不用空值把已经填好的 Key 覆盖掉。
   * 这不是假设出来的问题 —— 这个项目已经因此丢过两次 Key：
   * 只要某个客户端在 state.keys 为空时点了「保存」（或任何会把整份设置回写的路径），
   * 整份配置就会带着空 Key 落盘，而 Key 是找不回来的。
   * 真要清空 Key，就手改 config.json。
   */
  ['apiKey', 'alapiKey'].forEach((k) => {
    if (patch && Object.prototype.hasOwnProperty.call(patch, k) && !String(patch[k] || '').trim()) {
      next[k] = current[k] || '';
    }
  });
  // 来源换了、地址却还停在另一个来源上 —— 这个组合必然 404
  // （典型：从聚合引擎切到 ALAPI，ALAPI 的路径打到了 api.lk888.ai 上）。
  // 只要之前填的是「认识的地址」，就顺手纠正成当前来源的官方地址；
  // 用户自己填的中转地址（不认识）原样保留。
  const owner = providerForBaseUrl(next.baseUrl);
  if (next.baseUrl && owner && owner !== resolveProvider(next)) {
    next.baseUrl = PROVIDERS[resolveProvider(next)].baseUrl;
  }
  // 白名单，避免写入乱七八糟的字段
  const clean = {};
  for (const k of Object.keys(DEFAULT_CONFIG)) clean[k] = next[k];
  // 配置目录可能不存在（例如用 APP_CONFIG 指到临时路径），先建出来
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  } catch {
    /* 建不出来就让下面的写入自然报错 */
  }
  // 写之前把上一版留一份：万一还是写坏了，config.json.bak 里能找到上一次的内容
  try {
    if (fs.existsSync(CONFIG_PATH)) fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + '.bak');
  } catch {
    /* 备份失败不拦主流程 */
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(clean, null, 2), 'utf8');
  seedImageRoots();
  return clean;
}

/** 合并「本次请求临时覆盖」的配置：只认 DEFAULT_CONFIG 里有的键，不落盘 */
function mergeConfig(patch) {
  const next = loadConfig();
  for (const k of Object.keys(DEFAULT_CONFIG)) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, k)) next[k] = patch[k];
  }
  return next;
}

/* ------------------------------------------------------- 纯 JS 图片编解码 */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

/** rgba(Buffer, w*h*4) -> PNG Buffer */
function encodePNG(rgba, w, h) {
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/** 解 BMP（8/24/32 位、非压缩）→ {rgba, width, height} */
function decodeBMP(buf) {
  if (buf.length < 54) throw new Error('BMP 文件过小');
  if (buf.readUInt16LE(0) !== 0x4d42) throw new Error('不是有效的 BMP 文件');
  const dataOffset = buf.readUInt32LE(10);
  const headerSize = buf.readUInt32LE(14);
  const width = buf.readInt32LE(18);
  let height = buf.readInt32LE(22);
  const planes = buf.readUInt16LE(26);
  const bpp = buf.readUInt16LE(28);
  const compression = buf.readUInt32LE(30);

  if (planes !== 1) throw new Error('BMP 格式异常（planes≠1）');
  if (compression !== 0 && compression !== 3) throw new Error('暂不支持压缩 BMP（RLE 等）');
  if (![8, 24, 32].includes(bpp)) throw new Error(`暂不支持 ${bpp} 位 BMP`);
  if (width <= 0) throw new Error('BMP 宽度异常');

  const bottomUp = height > 0;
  height = Math.abs(height);

  // 头部里的宽高是文件自己声明的，不校验就能用一张假 BMP 申请几十 GB 内存。
  // 上限按「RGBA = 4 字节/像素」算：30M 像素 ≈ 120MB 单张，并发 3 也不至于把进程撑爆。
  const MAX_BMP_PIXELS = 30e6;
  if (height <= 0 || width * height > MAX_BMP_PIXELS) {
    throw new Error(`BMP 尺寸异常（${width}×${height}）`);
  }

  const rowStride = Math.floor((bpp * width + 31) / 32) * 4;
  const rgba = Buffer.alloc(width * height * 4);

  let palette = null;
  if (bpp === 8) {
    const palOffset = 14 + headerSize;
    const count = Math.min(256, Math.floor((dataOffset - palOffset) / 4));
    palette = [];
    for (let i = 0; i < count; i++) {
      const o = palOffset + i * 4;
      palette.push([buf[o + 2], buf[o + 1], buf[o]]); // BGR -> RGB
    }
  }

  for (let y = 0; y < height; y++) {
    const srcRow = dataOffset + (bottomUp ? height - 1 - y : y) * rowStride;
    if (srcRow + rowStride > buf.length) break;
    for (let x = 0; x < width; x++) {
      const dst = (y * width + x) * 4;
      if (bpp === 8) {
        const idx = buf[srcRow + x];
        const c = (palette && palette[idx]) || [0, 0, 0];
        rgba[dst] = c[0];
        rgba[dst + 1] = c[1];
        rgba[dst + 2] = c[2];
        rgba[dst + 3] = 255;
      } else if (bpp === 24) {
        const o = srcRow + x * 3;
        rgba[dst] = buf[o + 2];
        rgba[dst + 1] = buf[o + 1];
        rgba[dst + 2] = buf[o];
        rgba[dst + 3] = 255;
      } else {
        const o = srcRow + x * 4;
        rgba[dst] = buf[o + 2];
        rgba[dst + 1] = buf[o + 1];
        rgba[dst + 2] = buf[o];
        rgba[dst + 3] = 255;
      }
    }
  }
  return { rgba, width, height };
}

// 本地单张素材体积上限。取 10MB 是为了和上游对齐：平台明确写了「参考图单文件解码后 ≤10MB」，
// 这里放宽到 40MB 只会让 10~40MB 的图白跑一趟再被上游拒掉。
const MAX_LOCAL_IMAGE = 10 * 1024 * 1024;
// 单次请求里所有参考图的合计上限（上游：base64 合计 ≤30MB、请求体总计 ≤50MB）
const MAX_REFS_TOTAL = 30 * 1024 * 1024;

/** 读一张图，归一化成接口能吃的形式 */
function normalizeImage(absPath) {
  const ext = path.extname(absPath).toLowerCase();
  let st = null;
  try {
    st = fs.statSync(absPath);
  } catch {
    /* 读不到就让下面的 readFileSync 报错 */
  }
  if (st && st.size > MAX_LOCAL_IMAGE) {
    throw new Error(`文件过大（${(st.size / 1048576).toFixed(1)}MB，单张上限 ${MAX_LOCAL_IMAGE / 1048576}MB），已跳过`);
  }
  const buf = fs.readFileSync(absPath);
  if (ext === '.bmp') {
    const { rgba, width, height } = decodeBMP(buf);
    return {
      mime: 'image/png',
      base64: encodePNG(rgba, width, height).toString('base64'),
      converted: true,
      bytes: buf.length,
      width,
      height
    };
  }
  const mime = MIME_BY_EXT[ext] || 'image/png';
  const size = readImageSize(buf) || {};
  return { mime, base64: buf.toString('base64'), converted: false, bytes: buf.length, width: size.width || null, height: size.height || null };
}

function guessExtFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg';
  if (m.includes('webp')) return '.webp';
  if (m.includes('gif')) return '.gif';
  if (m.includes('avif')) return '.avif';
  return '.png';
}

/** 读图片原始宽高（只解析文件头，不解码像素） */
function readImageSize(buf) {
  try {
    // PNG
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    // GIF
    if (buf.length > 10 && buf.slice(0, 3).toString('ascii') === 'GIF') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    // BMP
    if (buf.length > 26 && buf.readUInt16LE(0) === 0x4d42) {
      return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) };
    }
    // JPEG：扫 SOF 标记
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2;
          continue;
        }
        const len = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + len;
      }
    }
  } catch {
    /* 解析失败就当未知 */
  }
  return null;
}

/** 把任意宽高比吸附到接口支持的 10 种比例里最接近的那个 */
function nearestAspectRatio(width, height) {
  if (!width || !height) return null;
  const target = width / height;
  let best = null;
  let bestDiff = Infinity;
  for (const r of ASPECT_RATIOS) {
    const [w, h] = r.split(':').map(Number);
    const diff = Math.abs(w / h - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = r;
    }
  }
  // 差距过大（比如超宽全景图）就不硬套，交给用户设置
  return bestDiff <= 0.25 ? best : null;
}

/** 按文件头判断图片类型 */
function headKind(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpeg';
  if (buf.length > 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buf.length > 6 && buf.slice(0, 3).toString('ascii') === 'GIF') return 'gif';
  return '';
}

/** 从二进制头嗅探 mime */
function sniffMime(buf) {
  return { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[headKind(buf)] || 'image/png';
}

/* --------------------------------------------------------- 上游响应解析 */

/** 递归深挖，把各种中转平台的返回格式都捞出来 */
function deepCollect(node, out, depth) {
  if (node == null || depth > 8) return;
  if (typeof node === 'string') {
    if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(node)) {
      const m = node.match(/^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is);
      out.images.push({ mime: m[1], base64: m[2] });
    } else if (/^https?:\/\//i.test(node) && /\.(png|jpe?g|webp|gif)(\?|$)/i.test(node)) {
      out.urls.push(node);
    } else if (node.length > 1024 && /^[A-Za-z0-9+/=\s]+$/.test(node)) {
      // 裸 base64：确认真的是一张图，避免把长文本误判成图片
      try {
        const head = Buffer.from(node.replace(/\s/g, '').slice(0, 64), 'base64');
        if (head.length >= 4 && /^(png|jpe?g|webp|gif)$/i.test(headKind(head))) {
          out.images.push({ mime: '', base64: node.replace(/\s/g, '') });
        }
      } catch {
        /* 忽略 */
      }
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) deepCollect(v, out, depth + 1);
    return;
  }
  if (typeof node !== 'object') return;

  const inline = node.inline_data || node.inlineData;
  if (inline && inline.data) {
    out.images.push({ mime: inline.mime_type || inline.mimeType || '', base64: inline.data });
  }
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string') {
      if ((k === 'b64_json' || k === 'b64' || k === 'base64' || k === 'image_base64' || k === 'imageBase64') && v.length > 100) {
        out.images.push({ mime: '', base64: v });
        continue;
      }
      if ((k === 'url' || k === 'image_url' || k === 'imageUrl' || k === 'result_url' || k === 'resultUrl') && /^https?:\/\//i.test(v)) {
        out.urls.push(v);
        continue;
      }
      if (typeof k === 'string' && (k === 'text' || k === 'reason' || k === 'message' || k === 'msg')) {
        const s = v.trim();
        if (s && s.length < 2000) out.texts.push(s);
        continue;
      }
    }
    deepCollect(v, out, depth + 1);
  }
}

// 结果图下载的体积上限：上游返回的地址是本机服务去抓的，
// 不设限的话一个超大文件就能把进程内存吃满
const MAX_REMOTE_IMAGE = 40 * 1024 * 1024;
// 私有网段 / 本机地址：上游响应里出现这类地址一律不抓（SSRF）
const PRIVATE_HOST_RE =
  /^(localhost|127\.|0\.|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|\[::1\]$|\[?::ffff:)/i;

function assertSafeRemoteUrl(u) {
  let url;
  try {
    url = new URL(String(u));
  } catch {
    throw new Error('结果图地址不是合法 URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`拒绝下载非 http(s) 地址（${url.protocol}）`);
  }
  if (PRIVATE_HOST_RE.test(url.hostname)) {
    throw new Error(`拒绝下载内网/本机地址（${url.hostname}）`);
  }
  return url;
}

/** 结果图下载：手动跟随跳转，每一跳都重新校验，避免上游用 302 把请求引到内网/本机 */
const MAX_REDIRECT_HOPS = 4;

async function fetchToBuffer(u, signal) {
  let url = assertSafeRemoteUrl(u);
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop++) {
    if (hop === MAX_REDIRECT_HOPS) throw new Error(`结果图地址跳转次数过多（超过 ${MAX_REDIRECT_HOPS} 次）`);
    // redirect:'manual'：跟随后不再校验等于给了上游一个绕过 SSRF 白名单的口子
    const r = await fetch(url, { redirect: 'manual', signal });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      if (!loc) throw new Error(`下载结果图失败 HTTP ${r.status}（未给出跳转地址）`);
      url = assertSafeRemoteUrl(new URL(loc, url).toString());
      continue;
    }
    if (!r.ok) throw new Error(`下载结果图失败 HTTP ${r.status}`);
    const declared = Number(r.headers.get('content-length') || 0);
    if (declared > MAX_REMOTE_IMAGE) {
      throw new Error(`结果图过大（${(declared / 1048576).toFixed(1)}MB，上限 ${MAX_REMOTE_IMAGE / 1048576}MB）`);
    }
    const ab = await r.arrayBuffer();
    if (ab.byteLength > MAX_REMOTE_IMAGE) {
      throw new Error('结果图过大，已丢弃');
    }
    return Buffer.from(ab);
  }
  throw new Error('结果图下载失败');
}

/**
 * 解析上游响应 → { images:[{mime,base64}], texts:[], raw }
 * signal 要一路传下去：结果图是本机服务去抓的，不传就等于它不受单张超时约束。
 */
async function parseUpstream(json, signal) {
  const bag = { images: [], urls: [], texts: [] };
  deepCollect(json, bag, 0);

  for (const u of [...new Set(bag.urls)].slice(0, 8)) {
    try {
      const buf = await fetchToBuffer(u, signal);
      bag.images.push({ mime: '', base64: buf.toString('base64') });
    } catch (e) {
      bag.texts.push(`[结果图下载失败] ${u} :: ${e.message}`);
    }
  }

  // 去重（有些平台 base64 同时出现在两三处）
  return { images: dedupeImages(bag.images), texts: bag.texts, raw: json };
}

/* ------------------------------------------------------------- 上游调用 */

function buildGeminiBody(prompt, images, cfg) {
  const textPart = prompt ? [{ text: prompt }] : [];
  const imgParts = images.map((im) => ({ inline_data: { mime_type: im.mime, data: im.base64 } }));
  // Google 官方的图像编辑示例是「参考图在前、指令文字在后」；部分中转对顺序敏感，做成可切换
  const imgFirst = cfg.imageFirst !== false;
  const parts = imgFirst ? [...imgParts, ...textPart] : [...textPart, ...imgParts];
  const g = {
    responseModalities: ['TEXT', 'IMAGE'],
    imageConfig: {
      aspectRatio: cfg.aspectRatio,
      imageSize: cfg.imageSize
    }
  };
  // 思考等级在 Gemini 原生协议里叫 thinkingConfig.thinkingLevel；
  // quality 这种名字在这个协议下没有对应字段，就不塞了（会在诊断里说明）。
  const q = resolveQuality(cfg, cfg.quality);
  if (q.value && q.param && q.param.name === 'thinkingLevel') g.thinkingConfig = { thinkingLevel: q.value };
  return {
    contents: [{ role: 'user', parts }],
    generationConfig: g
  };
}

function authHeaders(cfg) {
  const h = {};
  const key = cfg.apiKey || '';
  const style = cfg.authStyle || 'both';
  if (style === 'both' || style === 'goog') h['x-goog-api-key'] = key;
  if (style === 'both' || style === 'bearer') h['Authorization'] = `Bearer ${key}`;
  return h;
}

/** 受支持的比例 → [宽, 高] */
const RATIO_TABLE = {
  '1:1': [1, 1],
  '2:3': [2, 3],
  '3:2': [3, 2],
  '3:4': [3, 4],
  '4:3': [4, 3],
  '4:5': [4, 5],
  '5:4': [5, 4],
  '9:16': [9, 16],
  '16:9': [16, 9],
  '21:9': [21, 9],
  '1:4': [1, 4],
  '4:1': [4, 1],
  '1:8': [1, 8],
  '8:1': [8, 1],
  // ALAPI 的 size 枚举额外有这几个（聚合引擎的模型没有）
  '2:1': [2, 1],
  '1:2': [1, 2],
  '9:21': [9, 21]
};

/** 分辨率档 → 长边目标像素（通用兜底，只在模型没有文档表时用） */
const SIZE_TO_LONG_SIDE = { '0.5K': 512, '1K': 1024, '2K': 2048, '4K': 3840 };

/**
 * 该模型的分辨率表（model-catalog.js 里按「模型@来源」固化的 RESOLUTION）。
 * 三个模型的 1K/2K/4K 不是一个东西，取值一律以这张表为准。
 */
function resTableOf(cfg) {
  return typeof Catalog.resTableOf === 'function' ? Catalog.resTableOf(cfg.model, resolveProvider(cfg)) : null;
}

/** 文档里「比例 × 档位」写死的像素写法（没有这张表 / 没这个组合 → 空串） */
function docPixelSize(cfg, aspectRatio, imageSize) {
  if (typeof Catalog.pixelOf !== 'function') return '';
  return Catalog.pixelOf(modelKeyOf(cfg), aspectRatio, imageSize) || '';
}

/** 比例 + 分辨率 → OpenAI 系模型的像素尺寸：先认模型自己的文档表，认不到才按长边估算 */
function toPixelSize(cfg, aspectRatio, imageSize) {
  const doc = docPixelSize(cfg, aspectRatio, imageSize);
  if (doc) return doc;
  const [rw, rh] = RATIO_TABLE[aspectRatio] || [1, 1];
  const target = SIZE_TO_LONG_SIDE[imageSize] || 1024;
  if (rw === rh) return `${target}x${target}`;
  let w = rw >= rh ? target : Math.round((target * rw) / rh);
  let h = rh >= rw ? target : Math.round((target * rh) / rw);
  const round = (n) => Math.max(256, Math.round(n / 16) * 16);
  return `${round(w)}x${round(h)}`;
}

/** 把请求体里的 base64 换成体积摘要，便于人看 */
function summarizeBody(bodyText) {
  try {
    const j = JSON.parse(bodyText);
    const walk = (n) => {
      if (Array.isArray(n)) return n.map(walk);
      if (n && typeof n === 'object') {
        const o = {};
        for (const [k, v] of Object.entries(n)) {
          if (typeof v === 'string' && (k === 'data' || k === 'b64_json' || k === 'image_base64' || k === 'imageBase64')) {
            o[k] = `<base64 约 ${((v.length * 3) / 4 / 1024).toFixed(1)} KB>`;
          } else {
            o[k] = walk(v);
          }
        }
        return o;
      }
      return n;
    };
    return JSON.stringify(walk(j), null, 2);
  } catch {
    return String(bodyText).slice(0, 800);
  }
}

/* ------------------------------------------- 协议解析 · 参数归一化 */

function resolveProvider(cfg) {
  return PROVIDERS[cfg.provider] ? cfg.provider : 'agg';
}

/** 协议必须与来源匹配，否则请求会打到错的域名上；不匹配就退回该来源的第一个协议 */
function resolveProtocol(cfg) {
  const p = resolveProvider(cfg);
  const want = String(cfg.protocol || '');
  if (PROTOCOLS[want] && PROTOCOLS[want].provider === p) return want;
  return Object.keys(PROTOCOLS).find((k) => PROTOCOLS[k].provider === p) || 'gemini';
}

/** 取域名（小写），地址不合法时原样返回 */
function hostOf(base) {
  try {
    return new URL(String(base)).host.toLowerCase();
  } catch {
    return String(base || '').toLowerCase();
  }
}

/** 这个地址属于哪个来源？不认识的自定义地址返回 null */
function providerForBaseUrl(base) {
  const h = hostOf(base);
  if (!h) return null;
  for (const k of Object.keys(PROVIDERS)) {
    const p = PROVIDERS[k];
    if ([p.baseUrl, ...(p.baseUrlAliases || [])].some((u) => hostOf(u) === h)) return k;
  }
  return null;
}

function baseUrlOf(cfg) {
  const p = resolveProvider(cfg);
  const custom = String(cfg.baseUrl || '').replace(/\/+$/, '');
  if (!custom) return PROVIDERS[p].baseUrl;
  const owner = providerForBaseUrl(custom);
  // 地址属于别的来源（配置被人手改过）→ 用当前来源的官方地址，避免把路径打到错误域名上
  if (!owner || owner === p) return custom;
  return PROVIDERS[p].baseUrl;
}

function keyOf(cfg) {
  return String(cfg[PROVIDERS[resolveProvider(cfg)].keyField] || '').trim();
}

/** 模型目录按「模型名@来源」索引：同一个 gpt-image-2 在聚合引擎和 ALAPI 上参数完全不同 */
function modelKeyOf(cfg) {
  return `${cfg.model}@${resolveProvider(cfg)}`;
}

function modelInfoOf(cfg) {
  return Catalog.BY_KEY[modelKeyOf(cfg)] || null;
}

function schemaOf(cfg) {
  return (modelInfoOf(cfg) || {}).params || [];
}

/** 参考图上限单独存在 maxRefs 里（不占 params 位） */
function maxRefsOf(cfg) {
  return Number((modelInfoOf(cfg) || {}).maxRefs) || 0;
}

/** 该模型是否支持这个协议？不在内置表里的模型不做判断，交给上游 */
function protocolSupported(cfg, proto) {
  const m = modelInfoOf(cfg);
  if (!m || !Array.isArray(m.protocols) || !m.protocols.length) return true;
  return m.protocols.includes(proto);
}

/** 从枚举里挑值：先精确、再忽略大小写，挑不到返回 null（绝不编造取值） */
function pickEnum(values, want) {
  if (!Array.isArray(values) || !values.length) return null;
  const w = String(want == null ? '' : want).trim();
  if (!w) return null;
  const exact = values.find((v) => String(v) === w);
  if (exact) return exact;
  return values.find((v) => String(v).toLowerCase() === w.toLowerCase()) || null;
}

const RE_PIXEL = /^(\d{3,5})\s*[x×]\s*(\d{3,5})$/i;
const RE_TIER = /^\d+(\.\d+)?\s*k$/i;

function sizeKind(values) {
  if (!Array.isArray(values) || !values.length) return 'none';
  if (values.some((v) => RE_PIXEL.test(String(v)))) return 'pixel';
  if (values.some((v) => RE_TIER.test(String(v)))) return 'tier';
  return 'ratio';
}

/** 在「具体像素尺寸」枚举里挑最接近的一个：比例优先，其次清晰度 */
function nearestPixelSize(values, aspectRatio, imageSize) {
  const [rw, rh] = RATIO_TABLE[aspectRatio] || [1, 1];
  const want = rw / rh;
  const target = SIZE_TO_LONG_SIDE[imageSize] || 1024;
  let best = null;
  let bestScore = Infinity;
  for (const v of values) {
    const m = RE_PIXEL.exec(String(v).trim());
    if (!m) continue;
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (!w || !h) continue;
    const ratioDiff = Math.abs(Math.log(w / h / want));
    const sizeDiff = Math.abs(Math.log(Math.max(w, h) / target));
    const score = ratioDiff * 4 + sizeDiff;
    if (score < bestScore) {
      bestScore = score;
      best = v;
    }
  }
  return best;
}

const RE_RATIO = /^(\d{1,3})\s*[:：]\s*(\d{1,3})$/;

/** 请求的比例不在该模型的枚举里时，吸附到最接近的那个（而不是随手换成一个） */
function nearestRatioValue(values, aspectRatio) {
  const [rw, rh] = RATIO_TABLE[aspectRatio] || [1, 1];
  const want = rw / rh;
  let best = null;
  let bestScore = Infinity;
  for (const v of values) {
    const m = RE_RATIO.exec(String(v).trim());
    if (!m) continue;
    const r = Number(m[1]) / Number(m[2]);
    if (!r) continue;
    const score = Math.abs(Math.log(r / want));
    if (score < bestScore) {
      bestScore = score;
      best = v;
    }
  }
  return best;
}

/** 必填但没被我们映射到的参数，挑一个「不极端」的合法值，别默认给最低档 */
function defaultEnumValue(name, values) {
  const prefer = {
    quality: ['medium', 'standard', 'high', 'auto', 'xhigh', 'max', 'low'],
    resolution: ['2K', '2k', '1K', '1k', 'high', 'medium'],
    size: ['2K', '2k', '1K', '1k', 'auto']
  };
  const order = prefer[name];
  if (order) {
    for (const want of order) {
      const hit = values.find((v) => String(v).toLowerCase() === want.toLowerCase());
      if (hit) return hit;
    }
  }
  return values.find((v) => String(v).toLowerCase() !== 'auto') || values[0];
}

/**
 * 「画质档」在平台上的字段名不统一：banana-2 叫 thinkingLevel（思考等级，minimal/high），
 * tt-image-2 叫 quality（图片质量，auto/high/medium/low）。前端只传一个值，
 * 由这里按模型表决定它落到哪个字段上 —— 名字对不上就不发，不做静默替换。
 */
const TIER_PARAM_NAMES = ['quality', 'thinkingLevel'];

/** 这个模型的画质档参数（模型表里没有就返回 null） */
function tierParamOf(cfg) {
  const schema = schemaOf(cfg);
  for (const n of TIER_PARAM_NAMES) {
    const p = schema.find((x) => x.name === n);
    if (p && Array.isArray(p.values) && p.values.length) return p;
  }
  return null;
}

/**
 * 校验前端传来的画质档：必须是该模型枚举里的原值，挑不到就当没传。
 * 返回 { param, value, note }，note 非空时说明这次为什么没用上。
 */
function resolveQuality(cfg, quality) {
  const want = String(quality == null ? '' : quality).trim();
  const param = tierParamOf(cfg);
  if (!want) return { param, value: '', note: '' };
  if (!param) return { param: null, value: '', note: `${cfg.model} 没有画质档参数，已忽略「${want}」` };
  const hit = pickEnum(param.values, want);
  if (!hit) return { param, value: '', note: `${cfg.model} 的 ${param.name} 没有「${want}」这一档，已按模型默认值发送` };
  return { param, value: hit, note: '' };
}

/**
 * 画质档在某个协议下能不能真正落地 —— 字段名对不上就没法发：
 *   media   → 直接进 params（字段名就是模型表里那个名字）
 *   openai  → 只认顶层 quality（OpenAI 的 images 接口就叫这个）
 *   gemini  → 只认 generationConfig.thinkingConfig.thinkingLevel
 *   alapi   → 自成一套参数，没有画质档
 */
function qualityFieldFor(protocol, paramName) {
  if (!paramName) return '';
  if (protocol === 'media') return paramName;
  if (protocol === 'openai') return paramName === 'quality' ? 'quality' : '';
  if (protocol === 'gemini') return paramName === 'thinkingLevel' ? 'generationConfig.thinkingConfig.thinkingLevel' : '';
  return '';
}

/** 画质档落地不了时的说明（没传、或协议带不动，都返回空串） */
function qualitySkipNote(cfg, protocol, quality) {
  const q = resolveQuality(cfg, quality);
  if (q.note) return q.note;
  if (!q.value) return '';
  if (!qualityFieldFor(protocol, q.param.name)) {
    return `${PROTOCOLS[protocol] ? PROTOCOLS[protocol].label : protocol} 协议没有 ${q.param.name} 字段，画质档没有写进请求`;
  }
  return '';
}

/** 该模型 size / imageSize 的枚举取值（没有则返回空数组） */
function sizeValuesOf(cfg) {
  const schema = schemaOf(cfg);
  const hit = schema.find((p) => p.name === 'size') || schema.find((p) => p.name === 'imageSize');
  return (hit && hit.values) || [];
}

/**
 * 前端在胶囊里直接选了模型文档里的 size 原值（tt-image-2 的 34 个像素尺寸、
 * ALAPI 的比例枚举都走这条）。命中枚举就原样下发，不再由「比例 + 分辨率」反推 ——
 * 用户看到什么就发什么，避免吸附带来的意外替换。没命中（或该模型没有 size）返回空串，
 * 交回原来的换算逻辑。
 */
function resolveSizePick(cfg, size) {
  const want = String(size == null ? '' : size).trim();
  if (!want) return '';
  const p = schemaOf(cfg).find((x) => x.name === 'size');
  if (!p || !Array.isArray(p.values)) return '';
  return p.values.find((v) => String(v).toLowerCase() === want.toLowerCase()) || '';
}

/**
 * size 是「像素枚举」的模型（tt-image-2 这类）：把比例 + 分辨率吸附到文档列出的
 * 合法取值上，别自己算一个可能落在规则外的像素（比如 3:2 · 1K 算成 1024x688 被上游拒）。
 * 模型没有像素枚举时返回 null，交给 toPixelSize 换算。
 */
function documentedPixelSize(cfg, aspectRatio, imageSize) {
  const vals = sizeValuesOf(cfg);
  if (!vals.length || sizeKind(vals) !== 'pixel') return null;
  // 先查模型自己的文档表：「这个比例 × 这个档位」文档写了什么就发什么。
  // （不能只靠下面的就近匹配：tt-image-2 的 2K 2:3 是 2048x3072，长边 3072 离
  //   1K/2K/4K 的通用长边 1024/2048/3840 都远，就近匹配会误选成长边 1536 的 1K 档。）
  const doc = docPixelSize(cfg, aspectRatio, imageSize);
  if (doc) return doc;
  // 表里没有这一格（模型不在表里，或该模型没有这个档位）→ 才退回就近匹配
  return nearestPixelSize(vals, aspectRatio, imageSize);
}

/**
 * 内部统一的「比例 + 分辨率 + 参考图」→ 该模型在 media 协议下真正认的 params。
 * 各模型的字段名和取值都不一样（aspectRatio/imageSize、aspect_ratio/resolution、
 * size 枚举像素 …），这里按语义映射，不硬编码模型名。
 * 最后再给「必填但没被覆盖」的参数补一个合法值，避免因缺参被上游拒。
 */
function buildMediaParams(cfg, { aspectRatio, imageSize, images, quality, size }) {
  const schema = schemaOf(cfg);
  const has = (n) => schema.some((p) => p.name === n);
  const valuesOf = (n) => (schema.find((p) => p.name === n) || {}).values || [];
  const params = {};

  // 画质档（quality / thinkingLevel）：字段名按模型表定，值必须是枚举里的原值
  const q = resolveQuality(cfg, quality);
  if (q.value && q.param) params[q.param.name] = q.value;

  if (images.length) {
    const maxRefs = maxRefsOf(cfg);
    const use = maxRefs ? images.slice(0, maxRefs) : images;
    // 平台明确支持 data:<mime>;base64,<data> 内联传入，所以不需要图床
    params.images = use.map((im) => `data:${im.mime || 'image/png'};base64,${im.base64}`);
  }

  // 比例：banana 系叫 aspectRatio，TT / Kling / Seedream 系叫 aspect_ratio
  for (const k of ['aspectRatio', 'aspect_ratio']) {
    if (!has(k)) continue;
    const vals = valuesOf(k);
    const v = pickEnum(vals, aspectRatio) || nearestRatioValue(vals, aspectRatio) || pickEnum(vals, 'auto');
    if (v) params[k] = v;
    break;
  }

  // 分辨率：imageSize / resolution / size（三种语义都出现过）
  if (has('imageSize')) {
    const vals = valuesOf('imageSize');
    params.imageSize = pickEnum(vals, imageSize) || nearestTierValue(vals, imageSize) || defaultEnumValue('imageSize', vals);
  } else if (has('resolution')) {
    const vals = valuesOf('resolution');
    const v = pickEnum(vals, imageSize) || pickEnum(vals, String(imageSize).toLowerCase()) || nearestTierValue(vals, imageSize);
    if (v) params.resolution = v;
  } else if (has('size')) {
    const vals = valuesOf('size');
    const kind = sizeKind(vals);
    // 前端直接把文档里的 size 选好了（像素尺寸 / 比例），原样下发
    const picked = resolveSizePick(cfg, size);
    if (picked) {
      params.size = picked;
    } else if (kind === 'pixel') {
      params.size = nearestPixelSize(vals, aspectRatio, imageSize) || 'auto';
    } else if (kind === 'tier') {
      params.size = pickEnum(vals, imageSize) || nearestTierValue(vals, imageSize) || defaultEnumValue('size', vals);
    } else if (kind === 'ratio') {
      const v = pickEnum(vals, aspectRatio) || nearestRatioValue(vals, aspectRatio) || pickEnum(vals, 'auto');
      if (v) params.size = v;
    }
  }

  for (const p of schema) {
    if (!p.required || p.name === 'images' || params[p.name] != null) continue;
    if (Array.isArray(p.values) && p.values.length) params[p.name] = defaultEnumValue(p.name, p.values);
  }
  return params;
}

/** 分辨率档枚举（1K/2K/4K 这类）里挑最接近的 */
function nearestTierValue(values, imageSize) {
  const target = SIZE_TO_LONG_SIDE[imageSize] || 1024;
  let best = null;
  let bestScore = Infinity;
  for (const v of values) {
    const long = SIZE_TO_LONG_SIDE[String(v).toUpperCase()];
    if (!long) continue;
    const score = Math.abs(Math.log(long / target));
    if (score < bestScore) {
      bestScore = score;
      best = v;
    }
  }
  return best;
}

/** 把请求体里的 base64 换成体积摘要后返回一段可读文本 */
function briefJson(obj) {
  return summarizeBody(JSON.stringify(obj));
}

/**
 * 我们请求的「比例 + 分辨率」和该模型实际认的取值不一定一致
 * （比如 gk-image-2.0 只支持 1:1/16:9/9:16/4:3/3:4，没有 3:2）。
 * 这里把发生的替换逐条写出来，界面上直接提示，不做静默替换。
 */
function describeParamNotes(cfg, params, aspectRatio, imageSize, pickedSize) {
  const notes = [];
  if (!params) return notes;
  // 前端直接把文档里的 size 选定后原样下发，没有任何吸附/替换，就不该再报「不支持」
  if (pickedSize) return notes;
  const [rw, rh] = RATIO_TABLE[aspectRatio] || [1, 1];
  const wantRatio = rw / rh;

  const ratioVal = ['aspectRatio', 'aspect_ratio'].map((k) => params[k]).find((v) => v != null)
    || (params.size != null && RE_RATIO.test(String(params.size)) ? params.size : null);
  if (ratioVal != null) {
    const m = RE_RATIO.exec(String(ratioVal));
    if (m && Math.abs(Math.log(Number(m[1]) / Number(m[2]) / wantRatio)) > 0.01) {
      notes.push(`${cfg.model} 不支持 ${aspectRatio}，比例已吸附为 ${ratioVal}`);
    }
  }

  if (params.size != null && RE_PIXEL.test(String(params.size))) {
    const px = String(params.size);
    // 这个像素就是文档给「该比例 × 该档位」写的值（三家的 4K 像素本来就不一样：
    // 同样是 16:9 的 4K，banana-2 是 5504×3072、tt-image-2 是 3840×2160）
    // → 说明命中了官方档位，不要报「没有这个档位」。
    const doc = docPixelSize(cfg, aspectRatio, imageSize);
    if (doc && doc.toLowerCase() === px.toLowerCase()) return notes;
    const long = Math.max(...px.split(/[x×]/i).map(Number));
    const target = SIZE_TO_LONG_SIDE[imageSize] || 1024;
    if (Math.abs(Math.log(long / target)) > 0.2) {
      notes.push(`该模型没有「${aspectRatio} · ${imageSize}」这个档位，实际按 ${px} 出图`);
    }
  }

  const tierKey = params.imageSize != null ? 'imageSize' : params.resolution != null ? 'resolution' : null;
  if (tierKey && String(params[tierKey]).toUpperCase() !== String(imageSize).toUpperCase()) {
    const m = String(params[tierKey]).toUpperCase();
    if (!RE_RATIO.test(m) && Math.abs(Math.log((SIZE_TO_LONG_SIDE[m] || 0) / (SIZE_TO_LONG_SIDE[imageSize] || 1))) > 0.2) {
      notes.push(`${cfg.model} 没有 ${imageSize} 档，清晰度取最接近的 ${params[tierKey]}`);
    }
  }
  return notes;
}

/**
 * ALAPI 的 size / resolution 取值自成一套。
 * 请求的档位不在它的枚举里就退回可得的档位，并把这次替换写进诊断，不做静默换掉。
 * 文档（alapi.cn/api/107）：resolution 有 1k / 2k / 4k，但 **4k 一栏只有
 * 16:9 / 9:16 / 2:1 / 1:2 / 21:9 / 9:21 六个比例有值**（其它比例标 ❌），
 * 所以「比例 × 清晰度」这个组合要按文档先退到该比例真正支持的档位，别等上游拒。
 */
function alapiShape(cfg, aspectRatio, imageSize, sizePickIn) {
  const params = (modelInfoOf(cfg) || {}).params || [];
  const valuesOf = (n) => ((params.find((p) => p.name === n) || {}).values || []).map(String);
  const notes = [];

  const resVals = valuesOf('resolution');
  let resolution = String(imageSize || '1k').toLowerCase();
  if (resVals.length) {
    const hit = resVals.find((v) => v.toLowerCase() === resolution);
    if (hit) resolution = hit;
    else {
      const fallback = resVals.find((v) => v.toLowerCase() === '1k') || resVals[0];
      notes.push(`ALAPI 这一档清晰度（${imageSize}）不在可选范围内，已改为 ${fallback}`);
      resolution = fallback;
    }
  }

  const sizeVals = valuesOf('size');
  // 前端在「比例」胶囊里选的就是 ALAPI size 的原值，直接用
  let size = resolveSizePick(cfg, sizePickIn) || aspectRatio || 'auto';
  if (sizeVals.length) {
    const hit = sizeVals.find((v) => v.toLowerCase() === String(size).toLowerCase());
    if (hit) size = hit;
    else {
      const fallback = sizeVals.find((v) => v.toLowerCase() === 'auto') || sizeVals[0];
      notes.push(`ALAPI 不支持 ${aspectRatio}，比例已改为 ${fallback}`);
      size = fallback;
    }
  }

  // 比例 × 清晰度：按文档的支持表退档（4k 只在这六个比例上存在）
  const table = resTableOf(cfg);
  if (table && RE_RATIO.test(String(size)) && typeof Catalog.degradeTier === 'function') {
    const want = String(resolution).toLowerCase();
    const deg = Catalog.degradeTier(modelKeyOf(cfg), String(size), want);
    if (deg && deg !== want) {
      const hit = resVals.find((v) => v.toLowerCase() === deg) || deg;
      notes.push(`文档里 ALAPI 的 ${size} 没有 ${resolution} 这一档，已按该比例的可用档改为 ${hit}`);
      resolution = hit;
    }
  }
  return { size, resolution, notes };
}

/**
 * ALAPI 出不了这一档时的退档次序（含当前档；末尾一定是文档里的最低档 1k）。
 * 文档：渠道限制，目前只保证 1k 能出 —— 2k / 4k 照发，出不了再逐档往下退：
 * 4k → 2k → 1k，2k → 1k。退到底还是不行才把错误抛出去。
 */
function alapiLadder(cfg, resolution) {
  const t = resTableOf(cfg);
  const tiers = (t && t.tiers) || ['1k', '2k', '4k'];
  const floor = (t && t.fallback && t.fallback.length) ? t.fallback[t.fallback.length - 1] : tiers[0];
  const start = String(resolution || '').toLowerCase();
  const i = tiers.indexOf(start);
  const out = [i >= 0 ? tiers[i] : (tiers.find((x) => x.toLowerCase() === start) || floor)];
  if (i > 0) {
    for (let k = i - 1; k >= 0; k--) {
      out.push(tiers[k]);
      if (tiers[k].toLowerCase() === String(floor).toLowerCase()) break;
    }
  }
  if (!out.some((x) => x.toLowerCase() === String(floor).toLowerCase())) out.push(floor);
  return out;
}

async function readJsonSafe(res) {
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { text, json };
}

/* ------------------------------------------------------------- 上游调用 */

function buildMediaBody(cfg, { prompt, images, aspectRatio, imageSize, quality, size }) {
  const body = { model: cfg.model, prompt: prompt || '' };
  const params = buildMediaParams(cfg, { aspectRatio, imageSize, images, quality, size });
  if (Object.keys(params).length) body.params = params;
  return body;
}

/**
 * 异步任务的统一轮询。
 *   fetchStatus(): 返回 { done, ok, url, error, progress, status }
 * 官方建议 5 秒一次；到点就停，不做无限等待。
 */
async function pollTask(cfg, dbg, fetchStatus) {
  const interval = Math.max(1, Number(cfg.pollIntervalSec) || 5) * 1000;
  const deadline = Date.now() + Math.max(30, Number(cfg.taskTimeoutSec) || 900) * 1000;
  const trail = [];
  dbg.poll = trail;
  let round = 0;
  for (;;) {
    if (Date.now() > deadline) {
      throw new Error(`任务超时：已等待约 ${Math.round((Number(cfg.taskTimeoutSec) || 900) / 60)} 分钟仍未完成`);
    }
    await new Promise((r) => setTimeout(r, interval));
    round++;
    const st = await fetchStatus();
    trail.push({ round, status: st.status, progress: st.progress, done: !!st.done, ok: !!st.ok });
    if (trail.length > 60) trail.shift();
    if (st.done) {
      if (st.ok && (st.url || (st.urls && st.urls.length))) return st;
      throw new Error(st.error || '上游返回任务失败');
    }
  }
}

/**
 * 「这个渠道其实只认 n=1」这件事，按 来源|协议|模型 记在内存里。
 *
 * 有些渠道是 OpenAI 兼容的皮，但 n 只接受 1：传 n>1 直接 400
 * （实测 api.lk888.ai 的 gpt-image-2 回「参数 n 当前仅支持 1」）。
 * 撞过一次就退化成并发发 N 次，下次不必再白试一轮。进程重启即清空，
 * 不落进 config.json —— 那里只放凭据、接口、参数默认值（见 DEFAULT_CONFIG 的约定）。
 */
const nativeNBlocked = new Map();

function nativeNKey(cfg) {
  return `${resolveProvider(cfg)}|${resolveProtocol(cfg)}|${String(cfg.model || '')}`;
}

/** 从上游报错里抠出一句人话，当作降级原因写进诊断 */
function briefRejectReason(err) {
  const raw = String((err && err.message) || '');
  const m = /"message"\s*:\s*"([^"]{1,200})"/.exec(raw);
  return (m ? m[1] : raw.replace(/^HTTP\s+\d+[^:]*::\s*/, '')).trim().slice(0, 120) || '上游拒绝 n>1';
}

/**
 * 上游「n 只支持 1」专用识别。
 *
 * 只有这个原因才允许把「一次出 N 张」降级成「并发发 N 次」；
 * 其他 400（Key 错、模型名错、内容审核、参数名不认）必须原样抛出去，
 * 否则真正的毛病会被降级悄悄盖住，反而更难查。
 */
function isNativeNRejected(err) {
  if (!err) return false;
  const status = Number(err.status);
  if (status !== 400 && status !== 422) return false;
  const msg = String(err.message || '');
  return (
    // 结尾的 (?![\w]) 不能省：「参数 n」要认，「参数 null 不合法」这种不能误伤
    /参数\s*[`"']?n[`"']?(?![\w])/i.test(msg) ||
    /[`"']?n[`"']?\s*(?:is\s+)?not\s+supported/i.test(msg) ||
    /(?:param(?:eter)?|field)\s*[`"']?n[`"']?[^,;}]{0,40}?(?:not\s+support|unsupported|invalid|must\s+be\s*1|only\s+support)/i.test(msg) ||
    // 中文「仅支持 1」必须能指回 n 这个参数：「该模型仅支持 1 张参考图」不能误判
    /(?:参数|param(?:eter)?|field|["'`]n["'`]|\bn\b)[^,;}]{0,60}?(?:仅|只)\s*支持\s*1(?![\d])/i.test(msg) ||
    /only\s+support(?:s|ed)?\s*(?:the\s+)?value\s*1\b/i.test(msg)
  );
}

/**
 * 一次上游调用（不含生图数量）。
 * 返回 { images, texts, raw }；诊断信息写在 dbg 上。
 */
async function callOnce(cfg, { prompt, images, aspectRatio, imageSize, quality, size, dbg, nativeN, signal }) {
  const provider = resolveProvider(cfg);
  const protocol = resolveProtocol(cfg);
  const proto = PROTOCOLS[protocol];
  const base = baseUrlOf(cfg);
  const key = keyOf(cfg);
  if (!base) throw new Error('未配置 Base URL');
  if (!key) {
    const p = PROVIDERS[provider];
    throw new Error(`未配置「${p.label}」的 ${p.keyField === 'alapiKey' ? 'token' : 'API Key'}，请到设置里填写`);
  }

  dbg.protocol = protocol;
  dbg.protocolLabel = proto.label;
  dbg.provider = provider;
  dbg.providerLabel = PROVIDERS[provider].label;
  // 配置里的地址和当前来源对不上时被自动纠正过，写进诊断里，别让人以为没写进去
  const configuredBase = String(cfg.baseUrl || '').replace(/\/+$/, '');
  if (configuredBase && configuredBase !== base) {
    dbg.baseUrlNote = `config.json 里的 ${configuredBase} 不属于「${PROVIDERS[provider].label}」，本次改用 ${base}（在设置里保存一次即可固定下来）`;
  }
  dbg.model = cfg.model;
  dbg.aspectRatio = aspectRatio;
  dbg.imageSize = imageSize;
  dbg.quality = String(quality || '');
  dbg.sizePick = resolveSizePick(cfg, size);
  dbg.params = null;
  dbg.poll = [];

  // 参考图合计体积上限（上游：单次请求所有 base64 合计 ≤30MB、请求体总计 ≤50MB）。
  // 拦在本机比让上游丢一个语焉不详的 413 更好定位。
  const refBytes = images.reduce((n, im) => n + Math.round((im.base64.length * 3) / 4), 0);
  if (refBytes > MAX_REFS_TOTAL) {
    throw new Error(
      `参考图合计约 ${(refBytes / 1048576).toFixed(1)}MB，超过上游 ${MAX_REFS_TOTAL / 1048576}MB 上限，请减少参考图数量或先压缩`
    );
  }

  const count = nativeN ? Math.max(1, Math.min(4, Number(cfg.count) || 1)) : 1;

  if (protocol === 'gemini') {
    const tpl = cfg.geminiPath || '/v1beta/models/{model}:generateContent';
    dbg.url = base + tpl.replace('{model}', encodeURIComponent(cfg.model));
    dbg.authHeader = (cfg.authStyle || 'both') === 'bearer' ? 'Authorization: Bearer <key>' : cfg.authStyle === 'goog' ? 'x-goog-api-key: <key>' : 'x-goog-api-key + Authorization: Bearer <key>';
    const bodyText = JSON.stringify(buildGeminiBody(prompt || '', images, Object.assign({}, cfg, { aspectRatio, imageSize, quality, size })));
    dbg.requestBody = summarizeBody(bodyText);
    const qNote = qualitySkipNote(cfg, protocol, quality);
    if (qNote) dbg.paramNotes = (dbg.paramNotes || []).concat(qNote);
    const res = await fetch(dbg.url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders(cfg)),
      body: bodyText,
      signal
    });
    return finishSync(dbg, res, signal);
  }

  if (protocol === 'openai') {
    const headers = { Authorization: `Bearer ${key}` };
    // 优先用前端在胶囊里选定的文档原值；没选时，模型表里 size 是「像素枚举」的
    // （tt-image-2 这类）吸附到文档列出的合法取值 —— 文档写明像素必须落在官方规则内
    // （16 的倍数、总像素 64 万～830 万、单边 ≤3840），照比例硬算出来的 1024x688 会被直接拒；
    // 没有枚举的模型仍按 toPixelSize 换算。
    const px = resolveSizePick(cfg, size) || documentedPixelSize(cfg, aspectRatio, imageSize) || toPixelSize(cfg, aspectRatio, imageSize);
    // 画质档：OpenAI 兼容协议只认顶层 quality 字段
    const q = resolveQuality(cfg, quality);
    const qValue = qualityFieldFor(protocol, q.param && q.param.name) ? q.value : '';
    const qNote = qualitySkipNote(cfg, protocol, quality);
    dbg.paramNotes = describeParamNotes(cfg, { size: px }, aspectRatio, imageSize, resolveSizePick(cfg, size));
    if (qNote) dbg.paramNotes.push(qNote);
    if (images.length) {
      const boundary = '----BatchRetouch' + crypto.randomBytes(12).toString('hex');
      const chunks = [];
      const push = (s) => chunks.push(Buffer.from(s, 'utf8'));
      const field = (name, value) => {
        push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
      };
      field('model', cfg.model);
      field('prompt', prompt || '');
      field('size', px);
      field('n', String(count));
      if (qValue) field('quality', qValue);
      field('response_format', 'b64_json');
      images.forEach((im, i) => {
        const ext = guessExtFromMime(im.mime);
        push(`--${boundary}\r\nContent-Disposition: form-data; name="image[]"; filename="ref${i + 1}${ext}"\r\nContent-Type: ${im.mime}\r\n\r\n`);
        chunks.push(Buffer.from(im.base64, 'base64'));
        push('\r\n');
      });
      push(`--${boundary}--\r\n`);
      const payload = Buffer.concat(chunks);
      dbg.url = base + (cfg.openaiEditPath || '/v1/images/edits');
      dbg.requestBody = `multipart/form-data（${(payload.length / 1024).toFixed(1)} KB）\nmodel=${cfg.model}\nprompt=${prompt || ''}\nsize=${px}\nn=${count}${qValue ? `\nquality=${qValue}` : ''}\nimage[]= ${images.length} 张`;
      const res = await fetch(dbg.url, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(payload.length) }, headers),
        body: payload,
        signal
      });
      return finishSync(dbg, res, signal);
    }
    dbg.url = base + (cfg.openaiPath || '/v1/images/generations');
    const payload = { model: cfg.model, prompt: prompt || '', size: px, n: count, response_format: 'b64_json' };
    if (qValue) payload.quality = qValue;
    const bodyText = JSON.stringify(payload);
    dbg.requestBody = summarizeBody(bodyText);
    const res = await fetch(dbg.url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
      body: bodyText,
      signal
    });
    return finishSync(dbg, res, signal);
  }

  if (protocol === 'alapi' || protocol === 'alapi_async') {
    const shape = alapiShape(cfg, aspectRatio, imageSize, size);
    // 用 concat 而不是直接赋值：callUpstream 可能已经往里写了「n 降级」这类说明，
    // 直接覆盖会把它抹掉
    dbg.paramNotes = (dbg.paramNotes || []).concat(shape.notes);
    const body = {
      token: key,
      model: cfg.model,
      prompt: prompt || '',
      n: count,
      size: shape.size,
      resolution: shape.resolution
    };
    if (images.length) body.image_urls = images.map((im) => `data:${im.mime || 'image/png'};base64,${im.base64}`);
    const submitPath = protocol === 'alapi' ? cfg.alapiPath || '/api/ai/images/generations' : cfg.alapiAsyncPath || '/api/ai/images/generations_sync';
    const submit = (resolution) => {
      const payload = Object.assign({}, body, { resolution });
      dbg.requestBody = briefJson(payload);
      return fetch(base + submitPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal
      });
    };
    dbg.url = base + submitPath;

    /**
     * 按某一档清晰度完整跑一次（异步协议含轮询）。
     * 返回 { ok, ret, reason }：ok=false 且还有下一档时调用方会退档重发。
     */
    const attempt = async (resolution) => {
      const res = await submit(resolution);
      if (protocol === 'alapi') {
        const r = await finishSync(dbg, res, signal);
        if (r.images.length) return { ok: true, ret: r };
        const raw = r.raw || {};
        return { ok: false, reason: `code=${raw.code == null ? res.status : raw.code} ${raw.message || raw.msg || ''}`.trim() };
      }
      const { text, json } = await readJsonSafe(res);
      dbg.httpStatus = res.status;
      dbg.httpStatusText = res.statusText;
      dbg.responseBytes = Buffer.byteLength(text, 'utf8');
      dbg.responseSnippet = text.length > 6000 ? text.slice(0, 6000) + `\n…（已截断，完整 ${dbg.responseBytes} 字节）` : text;
      if (!res.ok) throw httpError(res, json, text);
      const taskId = json && (json.task_id || (json.data && json.data.task_id));
      if (!taskId) {
        const apiCode = json && json.code;
        const msg = (json && (json.message || json.msg)) || '';
        // 渠道不认这一档时也可能只是「提交就报错」——这种能退档，不直接抛
        if (apiCode != null && Number(apiCode) !== 200) return { ok: false, reason: `code=${apiCode} ${msg}`.trim() };
        throw new Error(`提交任务失败：${text.slice(0, 300)}`);
      }
      dbg.taskId = taskId;
      const taskUrl = base + (cfg.alapiTaskPath || '/api/ai/images/generations/task');
      const st = await pollTask(cfg, dbg, async () => {
        const rr = await fetch(taskUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: key, task_id: taskId }),
          signal
        });
        const rd = await readJsonSafe(rr);
        if (!rr.ok) throw new Error(`任务查询异常：HTTP ${rr.status}`);
        if (!rd.json || rd.json.code !== 200) throw new Error((rd.json && (rd.json.msg || rd.json.message)) || '查询任务状态失败');
        const d = rd.json.data || {};
        const s = String(d.status || rd.json.status || '').toLowerCase();
        const list = (((d.result || {}).images) || []).map((x) => x && x.url).filter(Boolean);
        const one = list[0] || d.image_url || d.url || rd.json.image_url;
        if (['success', 'succeeded', 'finished', 'completed', 'done'].includes(s)) return { done: true, ok: true, urls: list.length ? list : one ? [one] : [], status: s };
        if (['failed', 'error', 'fail'].includes(s)) return { done: true, ok: false, error: d.error || rd.json.msg || '生成失败', status: s };
        return { done: false, status: s || 'unknown', progress: (d.result || {}).progress };
      });
      if (!st.ok) return { ok: false, reason: String(st.error || '任务失败') };
      dbg.resultUrl = (st.urls || [])[0];
      // n>1 时任务结果里会有多张图，全部取回来，不能只拿第一张
      const out2 = [];
      for (const u of (st.urls || []).slice(0, 4)) {
        if (!/^https?:\/\//.test(u)) continue;
        try {
          const buf = await fetchToBuffer(u, signal);
          out2.push({ mime: '', base64: buf.toString('base64') });
        } catch (e) {
          dbg.downloadErrors = (dbg.downloadErrors || []).concat(`${u} :: ${e.message}`);
        }
      }
      // 有些返回直接把图内联在任务结果里
      const harvested = await parseUpstream(json, signal);
      const got = dedupeImages(out2.concat(harvested.images));
      // 任务「成功」但一张图都没取到，也算这一档出不了（别把空结果当成成功）
      if (!got.length) return { ok: false, reason: '任务完成但没拿到结果图' };
      return { ok: true, ret: { images: got, texts: harvested.texts, raw: json } };
    };

    /**
     * 保留 2k / 4k：先按用户选的档发，**出不了再逐档往下退，最后退到 1k**
     * （文档：渠道限制，目前只保证 1k 能出）。提交被拒、任务失败、请求异常都算「出不了」；
     * 每一次降级都写进诊断，界面上看得见，不做静默替换。
     */
    const ladder = alapiLadder(cfg, shape.resolution);
    const pushNote = (s) => {
      shape.notes.push(s);
      // 只追加这一条：shape.notes 是累积的，整个数组再 concat 一遍会出现重复
      dbg.paramNotes = (dbg.paramNotes || []).concat(s);
    };
    let reason = '';
    for (let i = 0; i < ladder.length; i++) {
      const tier = ladder[i];
      const next = ladder[i + 1];
      let out;
      try {
        out = await attempt(tier);
      } catch (e) {
        // 超时 / 主动中止不算「这一档出不了」：任务可能还在上游跑着，这时候重发只是白等一轮。
        // 退到最后一档还失败，也把这一档真正的错抛出去（别拿上一档的原因顶包）。
        const timeout = e.name === 'AbortError' || /超时/.test(String(e.message));
        if (timeout || !next) throw new Error(`ALAPI ${cfg.model} 出图失败（清晰度 ${tier}：${e.message}）`);
        pushNote(`清晰度 ${tier} 请求异常（${e.message}），已自动改用 ${next} 重发`);
        continue;
      }
      if (out.ok) return out.ret;
      reason = out.reason || '上游没给图';
      if (!next) break;
      pushNote(`清晰度 ${tier} 出不了（${reason}），已自动改用 ${next} 重发`);
    }
    throw new Error(`ALAPI ${cfg.model} 出图失败（清晰度 ${shape.resolution}：${reason || '无具体说明'}；已试 ${ladder.join(' → ')}）`);
  }

  // media：平台原生异步协议
  const body = buildMediaBody(cfg, { prompt, images, aspectRatio, imageSize, quality, size });
  dbg.paramNotes = describeParamNotes(cfg, body.params, aspectRatio, imageSize, resolveSizePick(cfg, size));
  const mediaQNote = qualitySkipNote(cfg, protocol, quality);
  if (mediaQNote) dbg.paramNotes.push(mediaQNote);
  dbg.params = body.params ? Object.keys(body.params).reduce((o, k) => {
    o[k] = k === 'images' ? `<${body.params.images.length} 张参考图，内联 base64>` : body.params[k];
    return o;
  }, {}) : null;
  dbg.url = base + (cfg.mediaPath || '/v1/media/generate');
  dbg.requestBody = briefJson(Object.assign({}, body, body.params ? { params: dbg.params } : {}));
  const res = await fetch(dbg.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    signal
  });
  const { text, json } = await readJsonSafe(res);
  dbg.httpStatus = res.status;
  dbg.httpStatusText = res.statusText;
  dbg.responseBytes = Buffer.byteLength(text, 'utf8');
  dbg.responseSnippet = text.length > 6000 ? text.slice(0, 6000) + `\n…（已截断，完整 ${dbg.responseBytes} 字节）` : text;
  if (!res.ok) throw httpError(res, json, text);
  const taskId = json && json.data && json.data.task_id;
  if (!taskId) {
    const code = json && (json.code != null ? json.code : json.error && json.error.code);
    const msg = (json && (json.msg || json.message)) || '';
    if (code != null && Number(code) !== 200) {
      throw new Error(`上游拒绝（code=${code}）：${String(msg || text).slice(0, 300)}`);
    }
    // 少数模型可能直接同步返回图片，先按结果解析一次
    const direct = await parseUpstream(json, signal);
    if (direct.images.length) return direct;
    throw new Error(`未拿到 task_id：${text.slice(0, 300)}`);
  }
  dbg.taskId = taskId;

  let statusPath = cfg.mediaStatusPath || proto.statusPath;
  const st = await pollTask(cfg, dbg, async () => {
    const q = encodeURIComponent(taskId);
    let rr = await fetch(`${base}${statusPath}?task_id=${q}`, { headers: { Authorization: `Bearer ${key}` }, signal });
    if (rr.status === 404 && proto.statusPathLegacy && statusPath !== proto.statusPathLegacy) {
      statusPath = proto.statusPathLegacy;
      dbg.statusPathFallback = statusPath;
      rr = await fetch(`${base}${statusPath}?task_id=${q}`, { headers: { Authorization: `Bearer ${key}` }, signal });
    }
    const rd = await readJsonSafe(rr);
    if (!rr.ok) throw new Error(`任务查询异常：HTTP ${rr.status}`);
    const d = (rd.json && (rd.json.data || rd.json)) || {};
    const s = String(d.state || d.status || '').toLowerCase();
    if (d.is_final === true || d.is_final === 'true') {
      const ok = s === 'success' || s === 'succeeded' || d.status_group === '已完成' || (!d.error && d.result_url);
      return { done: true, ok: !!ok, url: d.result_url, error: d.error || rd.json.msg, status: d.status, progress: d.progress };
    }
    if (d.error) return { done: true, ok: false, error: String(d.error), status: d.status, progress: d.progress };
    return { done: false, status: d.status || s || 'unknown', progress: d.progress };
  });
  dbg.statusPath = statusPath;
  dbg.resultUrl = st.url;
  const out = [];
  if (st.url && /^https?:\/\//.test(st.url)) {
    const buf = await fetchToBuffer(st.url, signal);
    out.push({ mime: '', base64: buf.toString('base64') });
  }
  if (!out.length) throw new Error('任务完成，但没有拿到结果图地址');
  return { images: dedupeImages(out), texts: [], raw: json };
}

function httpError(res, json, text) {
  const detail = json ? JSON.stringify(json).slice(0, 600) : String(text).slice(0, 600);
  const err = new Error(`HTTP ${res.status} ${res.statusText} :: ${detail}`);
  err.status = res.status;
  return err;
}

function dedupeImages(list) {
  const seen = new Set();
  const out = [];
  for (const im of list) {
    if (!im || !im.base64 || im.base64.length < 200) continue;
    const b64 = im.base64.trim();
    let mime = im.mime;
    if (!mime) {
      try {
        mime = sniffMime(Buffer.from(b64.slice(0, 64), 'base64'));
      } catch {
        mime = 'image/png';
      }
    }
    const key = b64.slice(0, 96) + ':' + b64.length;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ mime, base64: b64 });
  }
  return out;
}

/** 同步协议：发一次、解析一次 */
async function finishSync(dbg, res, signal) {
  dbg.httpStatus = res.status;
  dbg.httpStatusText = res.statusText;
  const { text, json } = await readJsonSafe(res);
  dbg.responseBytes = Buffer.byteLength(text, 'utf8');
  dbg.responseSnippet = text.length > 6000 ? text.slice(0, 6000) + `\n…（已截断，完整 ${dbg.responseBytes} 字节）` : text;
  if (!res.ok) throw httpError(res, json, text);
  if (!json) throw new Error(`上游返回非 JSON：${text.slice(0, 400)}`);
  const parsed = await parseUpstream(json, signal);
  dbg.imageCount = parsed.images.length;
  dbg.texts = (parsed.texts || []).slice(0, 5);
  if (!parsed.images.length) {
    const apiCode = json.code ?? (json.error && json.error.code);
    const msg = (parsed.texts || []).slice(0, 2).join(' / ') || (apiCode ? `code=${apiCode}` : '上游未返回图片');
    throw new Error(`未取得图片：${msg}`);
  }
  return parsed;
}

async function callUpstream(cfg, { prompt, images, aspectRatio, imageSize, quality, size }) {
  const protocol = resolveProtocol(cfg);
  const proto = PROTOCOLS[protocol];
  const want = Math.max(1, Math.min(4, Number(cfg.count) || 1));

  // 同步协议按「单张超时」掐；异步协议自身有轮询总时限，外层只在它之上多留 60 秒兜底，
  // 否则会把 README 里说的「几分钟很正常」的正常任务提前打断。
  const outerSec = proto.async
    ? Math.max(60, Number(cfg.taskTimeoutSec) || 900) + 60
    : Math.max(20, Number(cfg.timeoutSec) || 300);
  const timeoutMs = outerSec * 1000;
  const timeoutNote = proto.async
    ? `异步任务超时（外层兜底 ${Math.round(outerSec / 60)} 分钟）`
    : `请求超时（${outerSec}s）`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const baseDbg = {
    model: cfg.model,
    aspectRatio,
    imageSize,
    quality: String(quality || ''),
    sizePick: resolveSizePick(cfg, size),
    promptLength: (prompt || '').length,
    promptPreview: String(prompt || '').slice(0, 300),
    refs: images.map((im) => ({ mime: im.mime, approxKB: Math.round((im.base64.length * 3) / 4 / 1024) })),
    httpStatus: null,
    httpStatusText: '',
    responseBytes: 0,
    responseSnippet: '',
    imageCount: 0,
    texts: [],
    tookMs: 0,
    requested: want
  };
  const t0 = Date.now();

  try {
    // 原生支持 n 的协议：一次请求就够，省连接、省额度。
    // 但「协议号称支持 n」不等于「这个渠道真的收 n>1」—— 收不收得到只有发出去才知道，
    // 所以这里留了一条退路：被上游明确拒了就改成并发发 N 次（见下面的 nFallback）。
    let nFallback = '';
    if (proto.nativeN) {
      const cacheKey = nativeNKey(cfg);
      const known = want > 1 ? nativeNBlocked.get(cacheKey) : '';
      if (known) {
        // 同一个 模型+协议 之前就因为 n>1 被拒过，这次直接走并发，省一轮必失败的请求
        nFallback = known;
      } else {
        const dbg = Object.assign({}, baseDbg);
        try {
          const r = await callOnce(cfg, { prompt, images, aspectRatio, imageSize, quality, size, dbg, nativeN: true, signal: controller.signal });
          dbg.tookMs = Date.now() - t0;
          dbg.imageCount = r.images.length;
          r.debug = dbg;
          return r;
        } catch (e) {
          // 只对「上游不收 n>1」降级；超时、Key 错、模型名错照旧抛出去
          if (want <= 1 || !isNativeNRejected(e)) throw e;
          nFallback = briefRejectReason(e);
          nativeNBlocked.set(cacheKey, nFallback);
        }
      }
      // 降级不能是静悄悄发生的：写进 paramNotes，界面上「参数已自动调整」会显示出来。
      // nativeNKey 一起带上，前端拿到就能把「一次出 N 张」这句提示改口，不用等刷新
      baseDbg.nativeNFallback = nFallback;
      baseDbg.nativeNKey = cacheKey;
      baseDbg.paramNotes = (baseDbg.paramNotes || []).concat(
        `上游不接受一次出多张（${nFallback}），已自动改为并发发 ${want} 次请求，按 ${want} 次计费`
      );
    }

    // 其余协议：并发发 want 次，每次固定产出 1 张
    const runs = [];
    for (let i = 0; i < want; i++) {
      const dbg = Object.assign({}, baseDbg);
      runs.push(
        (async () => {
          try {
            const r = await callOnce(cfg, { prompt, images, aspectRatio, imageSize, quality, size, dbg, nativeN: false, signal: controller.signal });
            dbg.tookMs = Date.now() - t0;
            dbg.imageCount = r.images.length;
            return { ok: true, r, dbg };
          } catch (e) {
            dbg.tookMs = Date.now() - t0;
            if (e.name === 'AbortError') dbg.responseSnippet = timeoutNote;
            else if (!dbg.responseSnippet) dbg.responseSnippet = `请求未完成：${e.message}`;
            return { ok: false, e, dbg };
          }
        })()
      );
    }
    const settled = await Promise.all(runs);

    const debug = settled[0].dbg;
    debug.parallel = want;
    const images2 = [];
    const texts = [];
    const errors = [];
    for (const s of settled) {
      if (s.ok) {
        images2.push(...s.r.images);
        texts.push(...(s.r.texts || []));
      } else {
        errors.push(s.e && s.e.name === 'AbortError' ? timeoutNote : String(s.e.message).slice(0, 300));
      }
      debug.texts = debug.texts.concat(s.dbg.texts || []);
    }
    const merged = dedupeImages(images2);
    if (!merged.length) {
      const e = new Error(errors[0] || '未取得图片');
      e.debug = debug;
      throw e;
    }
    debug.imageCount = merged.length;
    debug.failedRuns = errors.length;
    debug.errors = errors.slice(0, 3);
    if (errors.length) debug.texts.unshift(`${want} 张里有 ${errors.length} 张失败：${errors[0]}`);
    debug.texts = debug.texts.slice(0, 5);
    debug.tookMs = Date.now() - t0;
    return { images: merged, texts: texts.slice(0, 5), raw: null, debug };
  } catch (e) {
    if (!e.debug) {
      baseDbg.tookMs = Date.now() - t0;
      if (e.name === 'AbortError') baseDbg.responseSnippet = timeoutNote;
      else if (!baseDbg.responseSnippet) baseDbg.responseSnippet = `请求未完成：${e.message}`;
      e.debug = baseDbg;
    }
    // 超时给一句人话，别让界面上显示「This operation was aborted」
    if (e.name === 'AbortError') {
      const err = new Error(timeoutNote);
      err.debug = e.debug || baseDbg;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------ 提示词优化（文本模型） */

/**
 * 按任务类型选择改写策略。
 * t2i  —— 文生图：没有参考图，从零把画面构建完整
 * i2i  —— 图生图 / 基于参考图改：有原图，先锚定再写改什么、保留什么
 * batch—— 批量修图：同一段提示词要套用到一整批不同的图上，必须通用化
 */
function normalizeTask(t) {
  if (t === 't2i') return 't2i';
  if (t === 'batch') return 'batch';
  return 'i2i';
}

const TASK_RULES = {
  t2i: `本次任务：【文生图】没有参考图，你要从零把画面构建完整。
必须覆盖下面这些维度，用户没提的就按最合理的商业视觉审美补齐：
主体→ 环境与背景 → 布光（光源类型、方向、软硬、色温）→
镜头与构图（焦段、机位、景别、留白）→ 风格与质感（写实摄影 / 3D 渲染 / 插画 / 电影感等）→ 色彩基调。
长度 80 到 200 字。`,

  i2i: `本次任务：【图生图】用户会附一张原图，你的提示词是给图像编辑模型用的。
第一句必须锚定原图：基于我提供的这张照片修图。
然后写「改什么」，再写一段「保持不变」的清单，逐项列出：形状、结构、比例、角度、朝向、颜色、
材质、纹理、logo、可见的文字，以及在画面中的位置和大小。
接触阴影与反射必须真实存在，且与新的光线方向一致。
结尾必须加一句：不要添加任何文字、标注、水印、logo、边框、色块、拼贴或多图排列，不要做成前后对比图或说明图。
长度 150 到 350 字。`,

  batch: `本次任务：【批量修图】这段提示词会原封不动套用到同一个文件夹里几十上百张不同的图上。
只写对这一整批图都成立的通用画面要求；绝不写只适用于某一件的具体描述
（不要写具体颜色、具体形状、具体品牌名、具体文字内容，除非这批图确实都一样）。
必须包含一段「保持不变」的清单，逐项列出：形状、结构、比例、角度、朝向、颜色、材质、纹理、
logo、包装上的文字，以及在画面中的位置和大小。
结尾必须加一句：不要添加任何文字、标注、水印、logo、边框、色块、拼贴或多图排列，不要做成前后对比图或说明图。
长度 200 到 400 字。`
};

/**
 * 交给文本模型的系统指令。
 * 这里把「描述画面、不要描述流程」的全部经验固化成硬约束，
 * 包括风险词清单，以及「只有在否定句里、或用户明确要求时才允许出现」的例外。
 */
function buildOptimizerSystem(task) {
  const t = normalizeTask(task);
  return `你是一名资深商业视觉指导。用户会给你一段零散的想法或需求，你要把它改写成一段可以直接交给图像模型的「画面描述式」提示词。

通用铁律：

1. 只描述画面最终长什么样：主体、环境、光线方向与软硬、阴影、色彩、材质质感、构图、镜头、风格。
   绝对不要描述流程、步骤、分析、拆解、对比或标注 —— 图像模型会把这些东西照着画到图上。

2. 严禁出现下列词及其同义表达（图像模型会照着把它们画到图上）：
   分析、拆解、解析、诊断、流程、步骤、工序、before/after、前后对比、对比图、并排、
   标注、注释、箭头、引线、信息图、示意图、说明图、图解、色卡、配色卡、色板、矩阵、协议、
   排版、拼贴、拼图、四宫格、九宫格、多图、多角度展示、网格排版、报告、方案、规格书、参数表、
   remaster、protocol、matrix、palette、infographic、diagram、annotation。
   两个例外：① 写在「不要添加……」这类否定句里；② 用户明确要求就是要一张这种图（这时照做）。

3. 写具体名词，不写形容词堆砌。说「柔光箱从左前 45° 打过来，右后侧留一道轮廓光」，
   不要说「光影很高级、质感拉满」。

4. 用户原话里的所有具体诉求都要保留，不要遗漏，也不要添加用户没提过的改动。

5. 如果用户没有提供任何内容：文生图就写一段通用的高质量商业摄影画面；
   图生图与批量修图就写一段通用的电商精修提示词。

${TASK_RULES[t]}

输出要求：只输出改写后的提示词正文。不要解释、不要加标题、不要用 Markdown 代码块或任何标记符号。`;
}

function buildOptimizerUser(prompt, ctx) {
  const t = normalizeTask(ctx.task);
  const meta = [];
  if (ctx.aspectRatio) meta.push(`出图比例：${ctx.aspectRatio}`);
  if (ctx.imageSize) meta.push(`分辨率：${ctx.imageSize}`);
  if (t === 't2i') meta.push('任务：文生图，没有参考图，从零生成');
  else if (t === 'batch') meta.push('任务：批量修图，同一段提示词套用到一整批不同的图');
  else meta.push('任务：图生图，会附一张原图，在上面改');
  const head = meta.length ? `（${meta.join('；')}）\n` : '';
  const body = String(prompt || '').trim();
  return body ? `${head}用户的需求原文：\n${body}` : `${head}用户没有提供需求，请按第 5 条和任务类型生成一段通用提示词。`;
}

/** 从各种返回形态里把文本抠出来 */
function pickChatText(json) {
  const c = json && json.choices && json.choices[0];
  if (c) {
    const m = c.message || c.delta || {};
    if (typeof m.content === 'string' && m.content.trim()) return m.content;
    if (Array.isArray(m.content)) {
      const t = m.content.map((p) => (typeof p === 'string' ? p : p && p.text)).filter(Boolean).join('');
      if (t.trim()) return t;
    }
    if (typeof c.text === 'string' && c.text.trim()) return c.text;
  }
  if (typeof json.output_text === 'string' && json.output_text.trim()) return json.output_text;
  const cands = (json && json.candidates) || [];
  for (const cd of cands) {
    const parts = (cd.content && cd.content.parts) || [];
    const t = parts.map((p) => p && p.text).filter(Boolean).join('');
    if (t.trim()) return t;
  }
  if (typeof json.text === 'string' && json.text.trim()) return json.text;
  return '';
}

/** 去掉模型可能带上的代码块围栏和标题 */
function cleanOptimized(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '');
  t = t.replace(/^\s*#{1,6}\s*/gm, '');
  t = t.replace(/^\s*(优化后的?提示词|提示词|Prompt)\s*[:：]\s*/i, '');
  return t.trim();
}

/**
 * 调用文本模型改写提示词。
 * 聊天类模型支持 openai / gemini 两种协议，默认 openai（/v1/chat/completions）。
 * 遇到「路径或结构不对」的错误（400/404/405）就自动换另一种协议重试；
 * 认证、限流、服务端错误则不换，避免把问题掩盖掉。
 */
async function callOptimizer(cfg, { prompt, ctx }) {
  // 文本模型只存在于聚合引擎，所以这里不能用「当前图片来源」的地址 ——
  // 否则一旦把来源切成 ALAPI，优化请求就会打到 v3.alapi.cn 上。
  const providerBase = resolveProvider(cfg) === 'agg' ? String(cfg.baseUrl || '').replace(/\/+$/, '') : '';
  const base = String(cfg.optimizerBaseUrl || '').replace(/\/+$/, '') || providerBase || PROVIDERS.agg.baseUrl;
  if (!base) throw new Error('未配置 Base URL');
  if (!cfg.apiKey) throw new Error('提示词优化调用的是聚合引擎的文本模型，请先在设置里填聚合引擎的 API Key');

  const model = cfg.optimizerModel || 'gem-3.8-flash';
  const sys = buildOptimizerSystem((ctx || {}).task);
  const user = buildOptimizerUser(prompt, ctx || {});
  const pref = cfg.optimizerProtocol || 'auto';
  let order;
  if (pref === 'gemini') order = ['gemini'];
  else if (pref === 'openai') order = ['openai'];
  // auto：固定先试 openai。原来会记住上次成功的协议，但那是界面状态，
  // 已不落在 config.json 里了 —— 代价是 auto 模式下每次都从 openai 起手。
  else order = ['openai', 'gemini'];

  const attempts = [];
  let lastErr = null;

  for (const proto of order) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(20, Number(cfg.optimizerTimeoutSec) || 180) * 1000);
    const t0 = Date.now();
    try {
      let url;
      let init;

      if (proto === 'openai') {
        url = base + (cfg.optimizerPath || '/v1/chat/completions');
        init = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: sys },
              { role: 'user', content: user }
            ],
            temperature: 0.6,
            stream: false
          }),
          signal: controller.signal
        };
      } else {
        url = `${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`;
        init = {
          method: 'POST',
          headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders(cfg)),
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: sys }] },
            contents: [{ role: 'user', parts: [{ text: user }] }],
            generationConfig: { temperature: 0.6 }
          }),
          signal: controller.signal
        };
      }

      const res = await fetch(url, init);
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }

      if (!res.ok) {
        const detail = json ? JSON.stringify(json).slice(0, 400) : text.slice(0, 400);
        const err = new Error(`HTTP ${res.status} ${res.statusText} :: ${detail}`);
        err.status = res.status;
        err.proto = proto;
        throw err;
      }

      const out = cleanOptimized(pickChatText(json));
      if (!out) {
        const err = new Error(`模型没有返回可用文本（${proto}）：${text.slice(0, 300)}`);
        err.status = 200;
        err.proto = proto;
        throw err;
      }
      attempts.push({ proto, ok: true, ms: Date.now() - t0 });
      return { text: out, model, proto, url, ms: Date.now() - t0, attempts, raw: text.slice(0, 1500) };
    } catch (e) {
      attempts.push({ proto, ok: false, ms: Date.now() - t0, status: e.status || null, error: String(e.message).slice(0, 300) });
      lastErr = e;
      const switchable = e.name === 'AbortError' || [400, 404, 405].includes(e.status) || e.status === 200;
      if (!switchable) break;
    } finally {
      clearTimeout(timer);
    }
  }

  const detail = attempts.map((a) => `${a.proto}: ${a.ok ? 'ok' : a.error || a.status || '失败'}`).join(' | ');
  const err = new Error(`提示词优化失败（模型 ${model}）—— ${detail}`);
  err.attempts = attempts;
  throw err;
}

/* --------------------------------------------------------------- 工具函数 */

/**
 * 所有响应都带上的安全头。
 * 这是本机工具，但页面能被任意网站用 iframe 嵌进去诱导点击
 * （清空记录、保存、启动批量都能被点），所以至少要挡住嵌套与外链引用。
 */
const SEC_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin'
};

function json(res, code, obj) {
  // 请求体超限时连接可能已被销毁，这时再写会抛异常（还会变成未处理的 rejection）
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(
    code,
    Object.assign({}, SEC_HEADERS, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store'
    })
  );
  res.end(body);
}

// 单次请求体上限。前端的参考图总量按这个数卡住（单张 10MB、合计 30MB 见 app.js）
const BODY_LIMIT = 64 * 1024 * 1024;

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    // 先看声明长度：能直接拒就别让 socket 把几十 MB 读完再丢
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) {
      fail(new Error(`请求体过大（声明 ${(declared / 1048576).toFixed(1)}MB，上限 ${Math.round(limit / 1048576)}MB），请减少参考图数量或尺寸`));
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    function fail(e) {
      if (done) return;
      done = true;
      chunks.length = 0;
      // 光停止收集不够：剩下的数据还会被读完才触发 end。直接把连接掐掉。
      try {
        req.destroy();
      } catch {
        /* 已经断了就无所谓 */
      }
      reject(e);
    }
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        fail(new Error(`请求体过大（超过 ${Math.round(limit / 1048576)}MB），请减少参考图数量或尺寸`));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', fail);
  });
}

async function readJsonBody(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从 data URL / base64 写文件；返回落盘路径 */
function writeImageFile(dir, baseName, image) {
  fs.mkdirSync(dir, { recursive: true });
  const buf = Buffer.from(image.base64, 'base64');
  const ext = image.mime ? guessExtFromMime(image.mime) : guessExtFromMime(sniffMime(buf));
  let target = path.join(dir, baseName + ext);
  let i = 2;
  while (fs.existsSync(target)) {
    target = path.join(dir, `${baseName}-${i}${ext}`);
    i++;
  }
  fs.writeFileSync(target, buf);
  return target;
}

function isImageFile(name, includeExtra) {
  const ext = path.extname(name).toLowerCase();
  if (EXT_CORE.includes(ext)) return true;
  if (includeExtra && EXT_EXTRA.includes(ext)) return true;
  return false;
}

async function scanFolder(dir, { recursive = false, includeExtra = false, exclude = [] } = {}) {
  const out = [];
  const exSet = new Set(exclude.filter(Boolean).map((p) => path.resolve(p).toLowerCase()));
  const walk = async (d, rel) => {
    let entries = [];
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch (e) {
      throw new Error(`无法读取目录：${d}（${e.message}）`);
    }
    for (const ent of entries) {
      const abs = path.join(d, ent.name);
      if (ent.isDirectory()) {
        // 排除输出目录本身，避免把上次的成品当成新素材再修一遍
        if (exSet.has(path.resolve(abs).toLowerCase())) continue;
        if (recursive && !ent.name.startsWith('.') && ent.name !== '修图输出' && ent.name !== 'node_modules') {
          await walk(abs, path.join(rel, ent.name));
        }
        continue;
      }
      if (!ent.isFile()) continue;
      if (!isImageFile(ent.name, includeExtra)) continue;
      if (!includeExtra && EXT_EXTRA.includes(path.extname(ent.name).toLowerCase())) continue;
      if (exSet.has(path.resolve(abs).toLowerCase())) continue;
      let st = null;
      try {
        st = await fsp.stat(abs);
      } catch {
        continue;
      }
      out.push({ name: ent.name, abs, rel: path.join(rel, ent.name), size: st.size });
    }
  };
  await walk(dir, '');
  out.sort((a, b) => a.rel.localeCompare(b.rel, 'zh-CN'));
  return out;
}

/* ------------------------------------------- 允许读写的图片目录（白名单） */
//
// 缩略图 / 结果图 / 保存图片这些接口原本接受任意绝对路径，
// 等于给了一个「读任意文件、写任意文件」的口子。
// 这里维护一份运行期目录白名单：记录目录 + 用户实际用过的输入/输出目录，
// 只有落在这之内的图片路径才放行。

const IMAGE_EXTS = EXT_CORE.concat(EXT_EXTRA);
const imageRoots = new Set();

function allowImageRoot(dir) {
  if (!dir) return;
  try {
    imageRoots.add(path.resolve(String(dir)).toLowerCase());
  } catch {
    /* 非法路径直接忽略 */
  }
}

/**
 * 白名单的固定部分：记录目录永远可读。
 * 用户的输入/输出目录不再从配置里恢复（配置已不存界面状态），改为运行期登记 ——
 * 扫过目录（/api/scan）或启动过批量（/api/batch/start）就会自动放行，
 * 等价于「开一次页面，选一次文件夹」即可。
 */
function seedImageRoots() {
  allowImageRoot(RECORD_DIR);
}

/** 输入目录一旦被确认使用，连同它的默认输出子目录一起放行 */
function allowInputTree(dir) {
  allowImageRoot(dir);
  allowImageRoot(path.join(path.resolve(String(dir || '.')), '修图输出'));
}

function isAllowedImagePath(abs) {
  const low = path.resolve(String(abs || '')).toLowerCase();
  for (const root of imageRoots) {
    const rel = path.relative(root, low);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true;
  }
  return false;
}

function isImageExt(p) {
  return IMAGE_EXTS.includes(path.extname(String(p || '')).toLowerCase());
}

/* ------------------------------------------------- 桌面助手（常驻 PowerShell） */
/**
 * 为什么需要它：本机实测 powershell.exe 每起一次要 ~1.2s（进程启动）+ ~0.6s（装配 WinForms），
 * 也就是「点一下弹原生文件夹选择框」得等 1.8s 才开始出现 —— 感受上就是「点了没反应」。
 * 另外 explorer.exe 从后台进程拉起时，窗口经常开在浏览器后面，同样像「没反应」。
 *
 * 做法：常驻一个把 WinForms / WScript.Shell 预先装配好的 STA 进程，之后每次只走 stdin/stdout。
 * 实测（见 .workbuddy/memory/2026-09-25.md）：冷启动一次 1.39s，之后往返 10~40ms，
 * explore/activate 约 160ms 且能把窗口提到最前。
 * 空闲 10 分钟自动退出；任何一步失败都回退到原来的一次性 spawn —— 助手挂了也不至于点不动。
 */
const DESKTOP_TAB = '\t';
const DESKTOP_READY_TIMEOUT_MS = 20000;
const DESKTOP_IDLE_MS = 60 * 60 * 1000; // 空闲退出的代价是下一次点击要重付 1.4s 冷启动，所以放到一小时
const DESKTOP_ACTIVATE_TIMEOUT_MS = 3000;
const DESKTOP_PICK_TIMEOUT_MS = 10 * 60 * 1000; // 对话框可能被用户晾着，给足时间

let desktopWorker = null;
let desktopSeq = 0;

function desktopScript() {
  // JS 一律用双引号字符串，PS 内部一律用单引号字符串，两边不打架；
  // 整段以 UTF-16LE + base64 传进去（-EncodedCommand），中文与路径都不受过编码影响。
  return [
    "$ErrorActionPreference = 'Continue'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    'Add-Type -AssemblyName System.Drawing | Out-Null',
    '$TAB = [char]9',
    // 报 ready 之前先空跑一遍「建隐形 owner 窗体 + 建选择框 + 销毁」：
    // 这一趟把 WinForms 的类型加载和 JIT 都做完，用户真点「选择文件夹」时就是热的，
    // 否则第一下会比之后每一下多等几百毫秒，感受上就是「点了半天才弹」。
    'try {',
    '  $w0 = New-Object System.Windows.Forms.Form',
    '  $w0.TopMost = $true',
    '  $w0.ShowInTaskbar = $false',
    "  $w0.FormBorderStyle = 'None'",
    "  $w0.StartPosition = 'CenterScreen'",
    '  $w0.Size = New-Object System.Drawing.Size(1, 1)',
    '  $w0.Show()',
    '  $d0 = New-Object System.Windows.Forms.FolderBrowserDialog',
    '  $d0.Dispose()',
    '  $w0.Dispose()',
    '} catch { }',
    '$wsh = New-Object -ComObject WScript.Shell',
    // ready 之前是最贵的那一段（进程启动 + 装配），报出来之后调用方就知道可以走快路径了
    "[Console]::Out.WriteLine((0, 'ready', [System.Threading.Thread]::CurrentThread.GetApartmentState()) -join $TAB)",
    '[Console]::Out.Flush()',
    'while ($true) {',
    '  $line = [Console]::In.ReadLine()',
    '  if ($null -eq $line) { break }',
    '  $p = $line.Split($TAB)',
    '  $id = $p[0]',
    "  $op = if ($p.Length -gt 1) { $p[1] } else { '' }",
    "  $arg = if ($p.Length -gt 2) { $p[2] } else { '' }",
    "  if ($op -eq 'quit') { [Console]::Out.WriteLine(($id, 'ok', '') -join $TAB); [Console]::Out.Flush(); break }",
    '  try {',
    "    if ($op -eq 'ping') { [Console]::Out.WriteLine(($id, 'ok', 'pong') -join $TAB) }",
    "    elseif ($op -eq 'activate') {",
    '      $hit = $false',
    // 窗口可能还没建好，多试几次（AppActivate 认窗口标题，也就是文件夹名）
    '      for ($i = 0; $i -lt 8; $i++) { if ($wsh.AppActivate($arg)) { $hit = $true; break }; Start-Sleep -Milliseconds 120 }',
    "      [Console]::Out.WriteLine(($id, 'ok', $hit.ToString()) -join $TAB)",
    '    }',
    "    elseif ($op -eq 'pick') {",
    // 挂一个 TopMost 的隐形 owner 窗体，否则对话框会弹在浏览器窗口后面
    '      $owner = New-Object System.Windows.Forms.Form',
    '      $owner.TopMost = $true',
    '      $owner.ShowInTaskbar = $false',
    "      $owner.FormBorderStyle = 'None'",
    "      $owner.StartPosition = 'CenterScreen'",
    '      $owner.Size = New-Object System.Drawing.Size(1, 1)',
    '      $owner.Show()',
    '      $owner.Activate()',
    '      $d = New-Object System.Windows.Forms.FolderBrowserDialog',
    "      $d.Description = '选择文件夹'",
    '      $d.ShowNewFolderButton = $false',
    "      if ($arg -ne '') { try { $d.SelectedPath = $arg } catch { } }",
    '      $r = $d.ShowDialog($owner)',
    "      $out = if ($r -eq [System.Windows.Forms.DialogResult]::OK) { $d.SelectedPath } else { '' }",
    '      $d.Dispose()',
    '      $owner.Dispose()',
    "      [Console]::Out.WriteLine(($id, 'ok', $out) -join $TAB)",
    '    }',
    "    else { [Console]::Out.WriteLine(($id, 'err', 'unknown op: ' + $op) -join $TAB) }",
    '  } catch {',
    // 换行会破坏「一行一条」的协议，先压平
    "    [Console]::Out.WriteLine(($id, 'err', ($_.Exception.Message -replace '[\\r\\n]', ' ')) -join $TAB)",
    '  }',
    '  [Console]::Out.Flush()',
    '}'
  ].join('\n');
}

function killDesktopWorker(w, reason) {
  if (desktopWorker === w) desktopWorker = null;
  if (!w || w.dead) return;
  w.dead = true;
  clearTimeout(w.idleTimer);
  clearTimeout(w.readyTimer);
  try {
    w.proc.kill();
  } catch {
    /* 已经退出了 */
  }
  const err = new Error('桌面助手不可用：' + reason);
  if (w.inflight) {
    clearTimeout(w.inflight.timer);
    w.inflight.reject(err);
    w.inflight = null;
  }
  w.queue.splice(0).forEach((q) => q.reject(err));
  if (w.readyReject) {
    const rej = w.readyReject;
    w.readyReject = null;
    w.readyResolve = null;
    rej(err);
  }
}

function spawnDesktopWorker() {
  const w = {
    proc: spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(desktopScript(), 'utf16le').toString('base64')],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    ),
    buf: '',
    dead: false,
    ready: false,
    starting: null,
    inflight: null,
    queue: [],
    idleTimer: null,
    readyTimer: null,
    readyResolve: null,
    readyReject: null
  };
  w.proc.stdout.on('data', (d) => onDesktopData(w, d));
  // PowerShell 会往 stderr 写 CLIXML 之类的噪音，忽略
  w.proc.stderr.on('data', () => {});
  w.proc.on('error', (e) => killDesktopWorker(w, 'PowerShell 启动失败：' + e.message));
  w.proc.on('exit', () => killDesktopWorker(w, 'PowerShell 已退出'));
  return w;
}

/** 起进程（或复用已有的）。返回的 Promise 在助手报 ready 时兑现 */
function warmDesktopWorker() {
  if (desktopWorker) return desktopWorker.ready ? Promise.resolve(desktopWorker) : desktopWorker.starting;
  const w = spawnDesktopWorker();
  desktopWorker = w;
  w.starting = new Promise((resolve, reject) => {
    w.readyResolve = resolve;
    w.readyReject = reject;
    w.readyTimer = setTimeout(() => killDesktopWorker(w, '启动超时'), DESKTOP_READY_TIMEOUT_MS);
  });
  // 没人在 await 的时候别让它变成 unhandledRejection
  w.starting.catch(() => {});
  return w.starting;
}

function desktopReady() {
  return !!(desktopWorker && desktopWorker.ready);
}

function touchDesktopIdle(w) {
  clearTimeout(w.idleTimer);
  w.idleTimer = setTimeout(() => killDesktopWorker(w, '空闲超时'), DESKTOP_IDLE_MS);
}

function onDesktopData(w, chunk) {
  w.buf += chunk.toString('utf8');
  let i;
  while ((i = w.buf.indexOf('\n')) >= 0) {
    const line = w.buf.slice(0, i).replace(/\r$/, '');
    w.buf = w.buf.slice(i + 1);
    if (!line) continue;
    const p = line.split(DESKTOP_TAB);
    if (p.length < 2) continue; // PS 的杂项输出，丢掉
    if (p[0] === '0' && p[1] === 'ready') {
      if (w.ready) continue;
      w.ready = true;
      clearTimeout(w.readyTimer);
      w.readyTimer = null;
      const res = w.readyResolve;
      w.readyResolve = null;
      w.readyReject = null;
      touchDesktopIdle(w);
      if (res) res(w);
      continue;
    }
    const req = w.inflight;
    if (!req || req.id !== p[0]) continue; // 迟到的 / 别人的输出
    clearTimeout(req.timer);
    w.inflight = null;
    touchDesktopIdle(w);
    const status = p[1];
    const text = p.slice(2).join(DESKTOP_TAB);
    if (status === 'ok') req.resolve(text);
    else req.reject(new Error(text || '桌面助手返回错误'));
    drainDesktopQueue(w);
  }
}

function drainDesktopQueue(w) {
  if (w.dead || !w.ready || w.inflight || !w.queue.length) return;
  const req = w.queue.shift();
  w.inflight = req;
  req.timer = setTimeout(() => {
    // 卡住多半是模态框还没关，进程没法再用了，只能重建
    killDesktopWorker(w, '请求超时');
  }, req.timeoutMs);
  try {
    w.proc.stdin.write(req.id + DESKTOP_TAB + req.op + DESKTOP_TAB + req.arg + '\n');
  } catch (e) {
    killDesktopWorker(w, '写入失败：' + e.message);
  }
}

/** 往助手发一条指令（只允许一条在飞，其余排队） */
function desktopRequest(op, arg, timeoutMs) {
  const w = desktopWorker;
  if (!w || !w.ready) return Promise.reject(new Error('桌面助手未就绪'));
  // 弹选择框是用户正等着的操作。队列里那些「把资源管理器窗口提到最前」是锦上添花，
  // 一个最长要等 3s，排在它们后面就会让对话框肉眼可见地晚出来 —— 直接丢掉。
  if (op === 'pick' && w.queue.length) {
    for (let i = w.queue.length - 1; i >= 0; i--) {
      if (w.queue[i].op === 'activate') w.queue.splice(i, 1)[0].resolve('false');
    }
  }
  return new Promise((resolve, reject) => {
    w.queue.push({ id: String(++desktopSeq), op, arg: arg == null ? '' : String(arg), resolve, reject, timeoutMs, timer: null });
    drainDesktopQueue(w);
  });
}

/**
 * 让资源管理器把该文件夹的窗口提到最前。
 * 后台进程拉起的 Explorer 窗口常开在浏览器后面，用户看到的就是「点了没反应」。
 * 纯锦上添花：失败不报错、也不阻塞接口返回。
 */
function foregroundFolderWindow(target) {
  if (!desktopReady()) return;
  const title = path.basename(String(target).replace(/[\\/]+$/, '')) || String(target);
  desktopRequest('activate', title, DESKTOP_ACTIVATE_TIMEOUT_MS).catch(() => {});
}

/**
 * 用资源管理器打开文件夹 / 定位到文件。
 * 两个坑：
 *   1) 原来用裸名 'explorer.exe'，依赖 PATH；显式给绝对路径更稳。
 *   2) spawn 的 error 事件是异步的，原来的写法直接 unref 就走了，
 *      真失败了（ENOENT 等）也没人知道，接口照样返回 ok —— 用户看到的就是「点了没反应」。
 *      这里等一个很短的窗口把错误捞回来。
 */
function openInExplorer(target) {
  return new Promise((resolve) => {
    const exe = path.join(process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows', 'explorer.exe');
    const isDir = fs.statSync(target).isDirectory();
    // /select, 和路径拼成一个参数：拆成两个 token 时，带空格的路径会被 quote 到
    // 逗号后面，explorer 的解析就不稳
    const args = isDir ? [target] : ['/select,' + target];
    let child;
    try {
      child = spawn(exe, args, { detached: true, windowsHide: false, stdio: 'ignore' });
    } catch (e) {
      return resolve(e);
    }
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(err);
    };
    child.once('error', done);
    // 'spawn' 成功就说明进程起来了，不用再等
    child.once('spawn', () => {
      if (isDir) {
        // 助手热着就顺手把窗口提到最前；没热就预热一下，下次点了就有
        if (desktopReady()) foregroundFolderWindow(target);
        else warmDesktopWorker().catch(() => {});
      }
      done(null);
    });
    const timer = setTimeout(() => done(null), 800);
    child.unref();
  });
}

/* --------------------------------------------------------- 原生对话框 */

function runPS(script) {
  return new Promise((resolve, reject) => {
    // UTF-16LE + base64，彻底绕开中文路径的编码问题
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded], { windowsHide: true });
    let out = '';
    let err = '';
    ps.stdout.on('data', (d) => (out += d.toString('utf8')));
    ps.stderr.on('data', (d) => (err += d.toString('utf8')));
    ps.on('error', (e) => reject(e));
    ps.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

/**
 * 只把「本地盘符路径」交给对话框当初始位置。
 * 网络路径（\\server\share）一旦被系统框拿去枚举，会卡到 SMB 超时（十几秒起），
 * 表现就是「点选择文件夹之后半天没反应」——所以干脆不传。
 */
function pickInitialPath(p) {
  const s = String(p || '').trim();
  if (!s || s.length > 200) return '';
  if (s.startsWith('\\\\') || s.startsWith('//')) return '';
  return /^[A-Za-z]:[\\/]/.test(s) ? s : '';
}

/** 原生文件夹选择框：优先交给预热好的桌面助手（约 0.2s），失败再退回一次性 spawn（约 1.8s） */
async function pickFolderDialog(initial) {
  const arg = pickInitialPath(initial);
  // 助手可能刚好被空闲回收 / 上一次请求把它弄挂了：重建一次再试，
  // 别让用户第一次点击落在最慢的一次性 spawn 上。
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await warmDesktopWorker();
      return await desktopRequest('pick', arg, DESKTOP_PICK_TIMEOUT_MS);
    } catch {
      killDesktopWorker(desktopWorker, '选择文件夹失败，重建助手');
    }
  }
  return pickFolderDialogOneShot(arg);
}

/** 一次性 spawn 的兜底实现（桌面助手不可用时用） */
async function pickFolderDialogOneShot(initial) {
  const safe = String(initial || '').replace(/'/g, "''");
  // 关键点：挂一个 TopMost 的隐形 owner 窗体，否则对话框会弹在浏览器窗口后面，用户以为「点了没反应」
  const script = [
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    'Add-Type -AssemblyName System.Drawing | Out-Null',
    '$owner = New-Object System.Windows.Forms.Form',
    '$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.FormBorderStyle = "None"',
    '$owner.StartPosition = "CenterScreen"; $owner.Size = New-Object System.Drawing.Size(1,1)',
    '$owner.Show(); $owner.Activate()',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$d.Description = '\u9009\u62e9\u56fe\u7247\u6587\u4ef6\u5939'",
    '$d.ShowNewFolderButton = $false',
    safe ? `try { $d.SelectedPath = '${safe}' } catch { }` : '',
    '$r = $d.ShowDialog($owner)',
    '$owner.Dispose()',
    'if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }'
  ]
    .filter(Boolean)
    .join('; ');
  const r = await runPS(script);
  if (r.code !== 0) throw new Error(r.err || '文件夹选择器启动失败');
  return r.out;
}

/* ------------------------------------------------------------ 批量任务池 */

const sseClients = new Set();
let job = null;
let jobSeq = 0;

function emit(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      /* ignore */
    }
  }
  // 跑图过程中也顺手落盘（节流），这样即使服务被强杀，刷新后还剩大部分进度
  if (event.type === 'item' || event.type === 'progress') scheduleJobHistory();
}

/* ------------------------------------------- 批量任务历史（刷新 / 重启后还在） */

let jobHistory = [];

function countsOf(items) {
  const count = (s) => items.filter((i) => i.status === s).length;
  return {
    total: items.length,
    done: items.filter((i) => ['done', 'failed', 'skipped'].includes(i.status)).length,
    ok: count('done'),
    failed: count('failed'),
    skipped: count('skipped'),
    pending: count('pending'),
    inFlight: count('running')
  };
}

function jobToHistory(j) {
  const o = j.options || {};
  return Object.assign({}, countsOf(j.items), {
    id: j.id,
    running: !!j.running,
    inputDir: j.inputDir,
    outputDir: j.outputDir,
    convId: j.convId || '',
    model: j.model || '',
    protocol: j.protocol || '',
    options: {
      prompt: o.prompt || '',
      aspectRatio: o.aspectRatio || '',
      imageSize: o.imageSize || '',
      concurrency: o.concurrency || 0,
      suffix: o.suffix || ''
    },
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    items: j.items.map((i) => ({
      rel: i.rel,
      abs: i.abs,
      status: i.status,
      ms: i.ms || 0,
      error: i.error || '',
      out: i.out || ''
    }))
  });
}

/** 批量历史落盘位置：跟生图记录住同一个对话目录（records\<conv_xxx>\jobs.json） */
function saveJobHistory() {
  try {
    fs.mkdirSync(RECORD_DIR, { recursive: true });
    const byConv = new Map();
    jobHistory.forEach((j) => {
      const name = convDirName(j.convId);
      if (!byConv.has(name)) byConv.set(name, []);
      byConv.get(name).push(j);
    });
    byConv.forEach((rows, name) => {
      const dir = path.join(RECORD_DIR, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'jobs.json'), JSON.stringify(rows, null, 2), 'utf8');
    });
    // 磁盘上还留着、但已经不在内存里的那份 jobs.json：只删文件，不碰目录
    // —— 目录里可能还有这个对话的生图记录
    listConversationDirs().forEach((name) => {
      if (byConv.has(name)) return;
      try {
        fs.rmSync(path.join(RECORD_DIR, name, 'jobs.json'), { force: true });
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* 历史写不了不影响跑图 */
  }
}

/** 启动 + 结束时立刻写；跑图过程中按 4 秒节流写 */
let historyTimer = 0;
function scheduleJobHistory() {
  if (historyTimer) return;
  historyTimer = setTimeout(() => {
    historyTimer = 0;
    if (job) syncJobHistory();
  }, 4000);
}

function syncJobHistory() {
  if (!job) return;
  const snap = jobToHistory(job);
  const i = jobHistory.findIndex((j) => j.id === snap.id);
  if (i >= 0) jobHistory[i] = snap;
  else jobHistory.unshift(snap);
  // 每个对话各留 BATCH_HISTORY_LIMIT 条（以前是全局 20 条，现在是「每条对话各 20 条」）
  const name = convDirName(snap.convId);
  let n = 0;
  jobHistory = jobHistory.filter((j) => (convDirName(j.convId) === name ? ++n <= BATCH_HISTORY_LIMIT : true));
  saveJobHistory();
}

/**
 * 启动时读历史。
 * 两件事必须做：① 被重启打断的任务要标回「未在运行」，否则界面一直转圈；
 * ② 把历史任务的输入/输出目录重新登记进图片白名单，否则重启后缩略图全 403。
 */
function loadJobHistory() {
  jobHistory = [];
  // 每个对话目录各一份 jobs.json（旧版那份全局的已由 migrateRecordsLayout() 拆走）
  listConversationDirs().forEach((dirName) => {
    try {
      const list = JSON.parse(fs.readFileSync(path.join(RECORD_DIR, dirName, 'jobs.json'), 'utf8'));
      if (Array.isArray(list)) jobHistory.push(...list.filter((j) => j && j.id));
    } catch {
      /* 这个对话没有批量历史 */
    }
  });
  jobHistory.sort((a, b) => (Number(b.startedAt) || 0) - (Number(a.startedAt) || 0));
  let changed = false;
  jobHistory.forEach((j) => {
    if (j.running) {
      j.running = false;
      j.finishedAt = j.finishedAt || Date.now();
      changed = true;
    }
    (j.items || []).forEach((i) => {
      if (i.status === 'running' || i.status === 'pending') {
        i.status = 'failed';
        i.error = i.error || '服务重启，这一张没跑完';
        changed = true;
      }
    });
    if (changed) Object.assign(j, countsOf(j.items || []));
    allowInputTree(j.inputDir);
    allowImageRoot(j.outputDir);
  });
  if (changed) saveJobHistory();
}

/**
 * 只含计数的任务摘要。
 * 进度事件用它：原来每个事件都带上全部文件的绝对路径，500 个文件就是十万级字符串，纯浪费。
 */
function jobCounts() {
  if (!job) {
    return {
      id: null,
      running: false,
      inputDir: '',
      outputDir: '',
      model: '',
      protocol: '',
      options: null,
      startedAt: 0,
      finishedAt: null,
      stopRequested: false,
      total: 0,
      done: 0,
      ok: 0,
      failed: 0,
      skipped: 0,
      pending: 0,
      inFlight: 0
    };
  }
  const items = job.items;
  const count = (s) => items.filter((i) => i.status === s).length;
  return {
    id: job.id,
    running: job.running,
    inputDir: job.inputDir,
    outputDir: job.outputDir,
    model: job.model,
    protocol: job.protocol,
    options: job.options,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    stopRequested: job.stopRequested,
    total: items.length,
    done: items.filter((i) => ['done', 'failed', 'skipped'].includes(i.status)).length,
    ok: count('done'),
    failed: count('failed'),
    skipped: count('skipped'),
    pending: count('pending'),
    inFlight: count('running')
  };
}

function jobSnapshot() {
  if (!job) return { active: false, job: null };
  return {
    active: job.running,
    job: Object.assign({}, jobCounts(), {
      items: job.items.map((i) => ({
        rel: i.rel,
        abs: i.abs,
        status: i.status,
        ms: i.ms || 0,
        error: i.error || '',
        out: i.out || '',
        outRel: i.outRel || '',
        hasDebug: !!i.debug
      }))
    })
  };
}

async function processItem(cfg, outputDir, item, opts) {
  item.status = 'running';
  item.startedAt = Date.now();
  item.error = '';
  emit({ type: 'item', rel: item.rel, status: 'running' });

  const outBase = path.basename(item.rel, path.extname(item.rel)) + (opts.suffix || '_修图');
  const outDirForFile = path.dirname(path.join(outputDir, item.rel));

  const maxRetries = Math.max(0, Number(cfg.maxRetries) || 0);
  let lastErr = null;
  let lastImg = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const img = normalizeImage(item.abs);
      // 「跟随原图比例」：按这张图自己的宽高吸附到最接近的受支持比例，
      // 避免模型为了凑成别的比例而自行编造画面内容
      let ratio = opts.aspectRatio;
      let followed = null;
      if (opts.followSourceRatio) {
        followed = nearestAspectRatio(img.width, img.height);
        if (followed) ratio = followed;
      }
      lastImg = img;
      const parsed = await callUpstream(Object.assign({}, cfg, { count: 1 }), {
        prompt: opts.prompt,
        images: [{ mime: img.mime, base64: img.base64 }],
        aspectRatio: ratio,
        imageSize: opts.imageSize,
        quality: opts.quality,
        // 跟随原图比例时，比例是按每张图重算的，胶囊里选死的像素尺寸就不能再用了
        size: followed ? '' : opts.size
      });
      const first = parsed.images[0];
      const saved = writeImageFile(outDirForFile, outBase, first);
      item.status = 'done';
      item.out = saved;
      item.outRel = path.relative(outputDir, saved);
      item.ms = Date.now() - item.startedAt;
      item.extraText = (parsed.texts || []).join(' ').slice(0, 200);
      item.debug = enrichDebug(parsed.debug, item, img, saved, attempt, followed && followed !== opts.aspectRatio ? opts.aspectRatio : null);
      if (opts.saveDebug) writeDebugLog(outputDir, item);
      emit({
        type: 'item',
        rel: item.rel,
        status: 'done',
        ms: item.ms,
        out: item.out,
        outRel: item.outRel,
        attempts: attempt,
        text: item.extraText,
        hasDebug: true
      });
      return;
    } catch (e) {
      lastErr = e;
      if (attempt <= maxRetries && !jobStopRequested()) {
        emit({ type: 'log', level: 'warn', rel: item.rel, message: `第 ${attempt} 次失败，${2 * attempt}s 后重试：${e.message}` });
        await delay(2000 * attempt);
        continue;
      }
      break;
    }
  }

  const stopped = jobStopRequested();
  item.status = stopped ? 'pending' : 'failed';
  // 停止时保持「待处理」以便续跑，但把失败原因一起留下，别把问题掩盖掉
  item.error = (stopped ? '已停止，未完成：' : '') + (lastErr ? String(lastErr.message).slice(0, 800) : '未知错误');
  item.ms = Date.now() - item.startedAt;
  item.debug = enrichDebug(lastErr && lastErr.debug, item, lastImg, null, null, null);
  // 失败项一律留下调试日志，方便排查
  if (item.debug) writeDebugLog(outputDir, item);
  emit({ type: 'item', rel: item.rel, status: item.status, ms: item.ms, error: item.error, hasDebug: !!item.debug });
}

/** 往诊断信息里补上「本地这边」的事实 */
function enrichDebug(dbg, item, img, saved, attempt, overriddenFrom) {
  if (!dbg) return null;
  return Object.assign({}, dbg, {
    localFile: item.abs,
    localBytes: item.size || null,
    sourceWidth: img ? img.width : null,
    sourceHeight: img ? img.height : null,
    sentMime: img ? img.mime : null,
    sentApproxKB: img ? Math.round((img.base64.length * 3) / 4 / 1024) : null,
    convertedFromBmp: img ? !!img.converted : null,
    attempt: attempt || null,
    savedAs: saved || null,
    ratioOverriddenFrom: overriddenFrom || null,
    finishedAt: new Date().toISOString()
  });
}

function writeDebugLog(outputDir, item) {
  try {
    const dir = path.join(outputDir, '_调试日志');
    fs.mkdirSync(dir, { recursive: true });
    const name = item.rel.replace(/[\\/]/g, '__').replace(/\.[^.]+$/, '') + '.json';
    fs.writeFileSync(path.join(dir, name), JSON.stringify({ rel: item.rel, status: item.status, error: item.error || '', debug: item.debug }, null, 2), 'utf8');
  } catch {
    /* 调试日志写不了不影响主流程 */
  }
}

function jobStopRequested() {
  return !!(job && job.stopRequested);
}

async function runJob(cfg) {
  const items = job.items.filter((i) => i.status === 'pending');
  const concurrency = Math.min(Math.max(1, Number(job.options.concurrency) || 3), 10);
  let cursor = 0;

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        if (jobStopRequested()) return;
        const my = cursor++;
        if (my >= items.length) return;
        try {
          await processItem(cfg, job.outputDir, items[my], job.options);
        } catch (e) {
          items[my].status = 'failed';
          items[my].error = String(e.message).slice(0, 500);
          emit({ type: 'item', rel: items[my].rel, status: 'failed', error: items[my].error });
        }
        emit({ type: 'progress', ...jobCounts() });
      }
    })
  );

  job.running = false;
  job.finishedAt = Date.now();
  syncJobHistory();

  if (job.options.writeCsvLog) {
    try {
      const rows = [['原文件', '输出文件', '状态', '耗时(ms)', '错误']];
      for (const i of job.items) {
        rows.push([i.rel, i.outRel || '', i.status === 'done' ? '成功' : i.status === 'failed' ? '失败' : i.status, String(i.ms || 0), (i.error || '').replace(/[\r\n]+/g, ' ')]);
      }
      const csv = '\ufeff' + rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');
      // 全部失败时输出目录可能还不存在，先建出来再写日志
      fs.mkdirSync(job.outputDir, { recursive: true });
      fs.writeFileSync(path.join(job.outputDir, `_修图日志_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`), csv, 'utf8');
    } catch {
      /* 日志写不了不影响主流程 */
    }
  }

  emit({ type: 'done', ...jobSnapshot().job });
}

/* ------------------------------------------------------------------ 路由 */

const API = {
  async 'GET /api/bootstrap'(req, res) {
    const cfg = loadConfig();
    json(res, 200, {
      ok: true,
      token: APP_TOKEN,
      version: '1.1.0',
      defaults: {
        aspectRatios: ASPECT_RATIOS,
        imageSizes: IMAGE_SIZES,
        coreFormats: EXT_CORE,
        extraFormats: EXT_EXTRA,
        countOptions: [1, 2, 3, 4]
      },
      providers: Object.keys(PROVIDERS).map((k) => ({
        key: k,
        label: PROVIDERS[k].label,
        baseUrl: PROVIDERS[k].baseUrl,
        baseUrlAliases: PROVIDERS[k].baseUrlAliases,
        keyField: PROVIDERS[k].keyField,
        keyHint: PROVIDERS[k].keyHint,
        docUrl: PROVIDERS[k].docUrl,
        protocols: Object.keys(PROTOCOLS).filter((p) => PROTOCOLS[p].provider === k)
      })),
      protocols: Object.keys(PROTOCOLS).map((k) => ({
        key: k,
        label: PROTOCOLS[k].label,
        provider: PROTOCOLS[k].provider,
        async: !!PROTOCOLS[k].async,
        nativeN: !!PROTOCOLS[k].nativeN,
        note: PROTOCOLS[k].note
      })),
      // 已经被上游拒过 n>1 的「来源|协议|模型」组合（本次进程内实测到的）：
      // 前端拿它把「一次请求出 N 张」改成「并发 N 次」，免得提示和实际不符
      nativeNBlocked: Array.from(nativeNBlocked.keys()),
      models: Catalog.BY_KEY,
      // 三家模型的 1K / 2K / 4K 不是一回事（像素、可用的比例组合都不一样），
      // 界面靠这张表把「这一档在这个比例下是多少像素 / 能不能选」说清楚
      resolutions: Catalog.RESOLUTION,
      quickModels: Catalog.QUICK,
      config: cfg
    });
  },

  async 'GET /api/config'(req, res) {
    json(res, 200, { ok: true, config: loadConfig() });
  },

  async 'POST /api/config'(req, res) {
    const body = await readJsonBody(req);
    json(res, 200, { ok: true, config: saveConfig(body) });
  },

  /**
   * 模型参数预览：按「比例 + 分辨率」算出真正会发出去的字段，按协议分支返回。
   * 界面上那个「实际发出参数」面板已经去掉了（banana 系下它只是原样回显，没有新信息），
   * 这个接口保留着，供手动排查参数换算用：
   *   curl -X POST localhost:8788/api/preview-params -H "x-app-token: <token>" \
   *        -d '{"config":{"provider":"agg","protocol":"openai","model":"gpt-image-2"},"aspectRatio":"3:2","imageSize":"2K"}'
   */
  async 'POST /api/preview-params'(req, res) {
    const body = await readJsonBody(req);
    const cfg = mergeConfig(body.config || {});
    const ar = body.aspectRatio || cfg.aspectRatio;
    const sz = body.imageSize || cfg.imageSize;
    const q = String(body.quality || '');
    // 胶囊里按模型文档选定的 size 原值（tt-image-2 的像素尺寸 / ALAPI 的比例）
    const sizePick = String(body.size || '');
    const pickedSize = resolveSizePick(cfg, sizePick);
    const provider = resolveProvider(cfg);
    const proto = resolveProtocol(cfg);
    const count = Math.max(1, Math.min(4, Number(cfg.count) || 1));
    try {
      // 预览必须跟着「真正会发出去的那个协议」走：
      // 之前只要来源是聚合引擎就一律按媒体异步算，选 openai / gemini 时
      // 显示的字段和实际请求体完全不是一回事。
      let params;
      let notes = [];
      // 这个 模型+协议 被上游以「n 只支持 1」拒过：真正发出去的是 N 次并发、每次 n=1
      const nBlocked = count > 1 && nativeNBlocked.has(nativeNKey(cfg));
      const realCount = nBlocked ? 1 : count;
      if (provider === 'alapi') {
        // ALAPI 实际 body 的字段和 schema 不一样：size 传比例、resolution 传清晰度。
        // 2k / 4k 是保留的（文档：2k 计 2 次、4k 计 3 次），只有真的出不了才逐档退到 1k ——
        // 预览显示用户选的那一档，同时把「会怎么退」讲清楚，不再假装只发 1k。
        const shape = alapiShape(cfg, ar, sz, sizePick);
        params = { model: cfg.model, n: realCount, size: shape.size, resolution: shape.resolution };
        notes = shape.notes.slice();
        const ladder = alapiLadder(cfg, shape.resolution);
        if (ladder.length > 1) {
          notes.push(`按 ${shape.resolution} 发送；上游若出不了这一档，会自动按 ${ladder.join(' → ')} 退档重发（渠道目前只保证 1k）`);
        }
        if (nBlocked) notes.push(`该渠道的 n 只支持 1，出 ${count} 张会并发发 ${count} 次请求（按 ${count} 次计费）`);
      } else if (proto === 'openai') {
        // OpenAI 兼容：比例 + 分辨率先换算成像素尺寸，生图数量走原生 n。
        // 但「协议支持 n」不代表「这个渠道收 n>1」，被拒过的（nativeNBlocked）
        // 实际是按并发发的，预览就得跟着显示，不然又和真发出去的对不上
        const px = pickedSize || documentedPixelSize(cfg, ar, sz) || toPixelSize(cfg, ar, sz);
        params = { model: cfg.model, size: px, n: realCount, response_format: 'b64_json' };
        const qRes = resolveQuality(cfg, q);
        const qVal = qualityFieldFor(proto, qRes.param && qRes.param.name) ? qRes.value : '';
        if (qVal) params.quality = qVal;
        notes = describeParamNotes(cfg, { size: px }, ar, sz, pickedSize);
        const qNote = qualitySkipNote(cfg, proto, q);
        if (qNote) notes.push(qNote);
        if (nBlocked) notes.push(`该渠道的 n 只支持 1，出 ${count} 张会并发发 ${count} 次请求（按 ${count} 次计费）`);
        else if (count > 1) notes.push(`一次请求出 ${count} 张；若上游只收 n=1，会自动降级为并发发 ${count} 次`);
        notes.push(`带参考图时会改走 ${cfg.openaiEditPath || '/v1/images/edits'}，参考图放在 image[] 字段里`);
      } else if (proto === 'gemini') {
        // Gemini 兼容：比例/分辨率放在 generationConfig.imageConfig 下，同步返回，没有 n
        params = {
          'generationConfig.imageConfig.aspectRatio': ar,
          'generationConfig.imageConfig.imageSize': sz
        };
        const qRes = resolveQuality(cfg, q);
        if (qRes.value && qRes.param && qRes.param.name === 'thinkingLevel') {
          params['generationConfig.thinkingConfig.thinkingLevel'] = qRes.value;
        }
        notes = ['Gemini 兼容协议同步返回，比例/分辨率在 generationConfig.imageConfig 里'];
        const qNote = qualitySkipNote(cfg, proto, q);
        if (qNote) notes.push(qNote);
        if (count > 1) notes.push(`该协议没有原生 n，出 ${count} 张会并发发 ${count} 次请求（按 ${count} 次计费）`);
      } else {
        params = buildMediaParams(cfg, { aspectRatio: ar, imageSize: sz, images: [], quality: q, size: sizePick });
        notes = describeParamNotes(cfg, params, ar, sz, pickedSize);
        const qNote = qualitySkipNote(cfg, proto, q);
        if (qNote) notes.push(qNote);
        if (count > 1) notes.push(`媒体异步不接受 count，出 ${count} 张会并发发 ${count} 次请求（按 ${count} 次计费）`);
      }
      if (!protocolSupported(cfg, proto)) {
        const sup = (modelInfoOf(cfg) || {}).protocols || [];
        notes.push(`⚠ ${cfg.model} 的推荐协议是 ${sup.join(' / ')}，当前选了「${PROTOCOLS[proto].label}」，可能被上游拒`);
      }
      json(res, 200, { ok: true, protocol: proto, provider, model: cfg.model, params, schema: schemaOf(cfg), notes });
    } catch (e) {
      json(res, 200, { ok: false, error: String(e.message) });
    }
  },

  async 'POST /api/test'(req, res) {
    const body = await readJsonBody(req);
    // quality 是界面状态、不在 config 白名单里，mergeConfig 拿到就丢了，得从原始请求体里取
    const cfg = mergeConfig(body);
    try {
      const parsed = await callUpstream(Object.assign({}, cfg, { count: 1 }), {
        prompt: 'A simple red apple on a white background',
        images: [],
        aspectRatio: cfg.aspectRatio || '1:1',
        imageSize: cfg.imageSize || '1K',
        quality: String(body.quality || ''),
        size: String(body.size || '')
      });
      json(res, 200, {
        ok: true,
        message: `连接成功，返回 ${parsed.images.length} 张图`,
        protocol: parsed.debug.protocolLabel,
        provider: parsed.debug.providerLabel,
        url: parsed.debug.url,
        model: cfg.model,
        // 降级说明（例如 ALAPI 的 2k/4k 出不了、自动退回 1k）也回报给界面，
        // 否则「测试连接」成功了却看不出实际用的是哪一档
        notes: (parsed.debug.paramNotes || []).slice(0, 6),
        sample: `data:${parsed.images[0].mime};base64,${parsed.images[0].base64.slice(0, 160)}`,
        text: (parsed.texts || []).join(' ').slice(0, 300)
      });
    } catch (e) {
      const d = e.debug || {};
      json(res, 200, {
        ok: false,
        message: String(e.message).slice(0, 900),
        protocol: d.protocolLabel || '',
        provider: d.providerLabel || '',
        url: d.url || '',
        params: d.params || null,
        notes: (d.paramNotes || []).slice(0, 6)
      });
    }
  },

  async 'POST /api/optimize-prompt'(req, res) {
    const body = await readJsonBody(req);
    const cfg = mergeConfig(body.config || {});
    try {
      // task: t2i 文生图 / i2i 图生图 / batch 批量修图。
      // 老版本前端只传 mode（batch|single），这里做兼容映射。
      const task = body.task || (body.mode === 'batch' ? 'batch' : 'i2i');
      const r = await callOptimizer(cfg, {
        prompt: body.prompt || '',
        ctx: { task, aspectRatio: body.aspectRatio, imageSize: body.imageSize }
      });
      json(res, 200, {
        ok: true,
        text: r.text,
        model: r.model,
        protocol: r.proto,
        url: r.url,
        ms: r.ms,
        original: String(body.prompt || ''),
        attempts: r.attempts
      });
    } catch (e) {
      json(res, 200, { ok: false, error: String(e.message).slice(0, 1200), attempts: e.attempts || [] });
    }
  },

  async 'POST /api/generate'(req, res) {
    const body = await readJsonBody(req);
    const cfg = mergeConfig(body.config || {});
    const images = (body.images || []).map((im) => ({
      mime: im.mime || 'image/png',
      base64: String(im.base64 || '').replace(/^data:[^,]+,/, '')
    }));
    try {
      const parsed = await callUpstream(cfg, {
        prompt: body.prompt || '',
        images,
        aspectRatio: body.aspectRatio || cfg.aspectRatio,
        imageSize: body.imageSize || cfg.imageSize,
        quality: body.quality || '',
        // 前端胶囊直接选了模型文档里的 size 原值（tt-image-2 的像素尺寸等），原样带上
        size: String(body.size || '')
      });
      json(res, 200, {
        ok: true,
        images: parsed.images,
        texts: parsed.texts,
        debug: parsed.debug,
        model: cfg.model,
        protocol: parsed.debug.protocol,
        provider: parsed.debug.provider,
        aspectRatio: body.aspectRatio || cfg.aspectRatio,
        imageSize: body.imageSize || cfg.imageSize
      });
    } catch (e) {
      json(res, 200, { ok: false, error: String(e.message).slice(0, 1500), debug: e.debug || null });
    }
  },

  async 'POST /api/ls'(req, res) {
    const body = await readJsonBody(req);
    const target = body.path || '';
    // 空路径 → 列出所有盘符
    if (!target) {
      const drives = [];
      for (let c = 65; c <= 90; c++) {
        const root = String.fromCharCode(c) + ':\\';
        try {
          if (fs.existsSync(root)) drives.push({ name: root, path: root });
        } catch {
          /* ignore */
        }
      }
      return json(res, 200, { ok: true, path: '', parent: null, dirs: drives, files: 0 });
    }
    const abs = path.resolve(target);
    let entries;
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true });
    } catch (e) {
      return json(res, 200, { ok: false, error: `无法读取：${e.message}` });
    }
    const dirs = [];
    let imgCount = 0;
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (ent.name.startsWith('.') || ent.name === 'node_modules' || ent.name === '$RECYCLE.BIN') continue;
        dirs.push({ name: ent.name, path: path.join(abs, ent.name) });
      } else if (ent.isFile() && isImageFile(ent.name, true)) {
        imgCount++;
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    const parent = path.dirname(abs);
    json(res, 200, {
      ok: true,
      path: abs,
      parent: parent === abs ? '' : parent,
      dirs,
      files: imgCount
    });
  },

  /**
   * 预热桌面助手。页面启动、以及用户把鼠标挪到「+」上时各叫一次，
   * 这样点「选择文件夹」的时候 PowerShell 早就装备好了（冷启动 1.4s 只付一次，且不在点击路径上）。
   */
  async 'POST /api/desktop/warm'(req, res) {
    try {
      await warmDesktopWorker();
      json(res, 200, { ok: true, ready: desktopReady() });
    } catch (e) {
      json(res, 200, { ok: false, error: String(e.message || e).slice(0, 160) });
    }
  },

  async 'POST /api/pick-folder'(req, res) {
    const body = await readJsonBody(req);
    try {
      const picked = await pickFolderDialog(body.initial || '');
      if (picked) rememberDir(picked);
      json(res, 200, { ok: true, path: picked || '' });
    } catch (e) {
      json(res, 200, { ok: false, error: `系统选择器不可用（${String(e.message).slice(0, 200)}），请在 ⚙ 批量选项里直接粘贴路径` });
    }
  },

  async 'POST /api/scan'(req, res) {
    const body = await readJsonBody(req);
    const dir = String(body.dir || '').trim();
    if (!dir) return json(res, 400, { ok: false, error: '请输入文件夹路径' });
  try {
    const st = await fsp.stat(dir);
    if (!st.isDirectory()) return json(res, 200, { ok: false, error: '这不是一个文件夹' });
  } catch {
    return json(res, 200, { ok: false, error: `文件夹不存在：${dir}` });
  }
  allowInputTree(dir);
  rememberDir(dir);
  const files = await scanFolder(dir, { recursive: !!body.recursive, includeExtra: !!body.includeExtra, exclude: body.exclude || [] });
    const totalBytes = files.reduce((s, f) => s + f.size, 0);
    json(res, 200, {
      ok: true,
      dir: path.resolve(dir),
      total: files.length,
      totalBytes,
      files: files.slice(0, 500).map((f) => ({ name: f.name, rel: f.rel, abs: f.abs, size: f.size }))
    });
  },

  async 'POST /api/batch/start'(req, res) {
    if (job && job.running) return json(res, 200, { ok: false, error: '已有批量任务在运行，请先停止或等待完成' });
    const body = await readJsonBody(req);
    // 用 mergeConfig 而不是 saveConfig：启动批量只是「用这套配置跑一次」，
    // 不该顺手把 config.json 重写一遍（那会把不在白名单里的手写键静默丢掉）。
    const cfg = mergeConfig(body.config || {});
    const inputDir = String(body.inputDir || '').trim();
    if (!inputDir) return json(res, 400, { ok: false, error: '请输入输入文件夹' });
    try {
      const st = await fsp.stat(inputDir);
      if (!st.isDirectory()) return json(res, 200, { ok: false, error: '输入路径不是文件夹' });
    } catch {
      return json(res, 200, { ok: false, error: `输入文件夹不存在：${inputDir}` });
    }

    const outputDir = String(body.outputDir || '').trim() || path.join(inputDir, '修图输出');
    if (path.resolve(outputDir).toLowerCase() === path.resolve(inputDir).toLowerCase()) {
      return json(res, 200, { ok: false, error: '输出文件夹不能和输入文件夹相同，请另选一个（避免把生成结果反复当素材处理）' });
    }
    allowInputTree(inputDir);
    rememberDir(inputDir);
    allowImageRoot(outputDir);
    const options = {
      prompt: String(body.prompt || ''),
      aspectRatio: String(body.aspectRatio || cfg.aspectRatio),
      imageSize: String(body.imageSize || cfg.imageSize),
      quality: String(body.quality || ''),
      size: String(body.size || ''),
      concurrency: Number(body.concurrency || cfg.concurrency || 3),
      recursive: !!body.recursive,
      includeExtra: !!body.includeExtra,
      skipExisting: body.skipExisting !== false,
      suffix: String(body.suffix ?? cfg.suffix ?? '_修图'),
      writeCsvLog: body.writeCsvLog !== false,
      saveDebug: !!body.saveDebug,
      followSourceRatio: body.followSourceRatio !== false
    };
    if (!options.prompt.trim()) return json(res, 200, { ok: false, error: '请输入统一的修图提示词' });

    let files = await scanFolder(inputDir, {
      recursive: options.recursive,
      includeExtra: options.includeExtra,
      exclude: [outputDir]
    });
    if (!files.length) return json(res, 200, { ok: false, error: '文件夹里没找到可处理的图片' });

    // 超大素材先剔除：单张要整文件读进内存再 base64，一张就能把服务撑爆
    const oversized = files.filter((f) => f.size > MAX_LOCAL_IMAGE);
    if (oversized.length) {
      files = files.filter((f) => f.size <= MAX_LOCAL_IMAGE);
      if (!files.length) {
        return json(res, 200, {
          ok: false,
          error: `${oversized.length} 张图片都超过单张 ${MAX_LOCAL_IMAGE / 1048576}MB 上限，无法处理`
        });
      }
    }

    jobSeq += 1;
    job = {
      id: `job-${Date.now()}-${jobSeq}`,
      running: true,
      stopRequested: false,
      startedAt: Date.now(),
      finishedAt: null,
      inputDir: path.resolve(inputDir),
      outputDir: path.resolve(outputDir),
      // 属于哪个对话：左侧栏按它分组，刷新后也要认得出来
      convId: String(body.convId || ''),
      model: cfg.model,
      protocol: cfg.protocol,
      // 记下本次任务用的配置：重试时要沿用同一套参数，而不是那时候的磁盘配置
      cfg: Object.assign({}, cfg),
      options,
      items: files.map((f) => {
        const outBase = path.basename(f.rel, path.extname(f.rel)) + options.suffix;
        const exists = options.skipExisting && [...EXT_CORE, ...EXT_EXTRA].some((e) => fs.existsSync(path.join(path.resolve(outputDir), path.dirname(f.rel), outBase + e)));
        return {
          rel: f.rel,
          abs: f.abs,
          size: f.size,
          status: exists ? 'skipped' : 'pending',
          ms: 0,
          error: '',
          out: '',
          outRel: ''
        };
      })
    };

    // 一建好就落盘：刚开跑就刷新页面 / 重启服务，这条任务也不会丢
    syncJobHistory();
    emit({ type: 'started', ...jobSnapshot().job });
    if (oversized.length) {
      emit({
        type: 'log',
        level: 'warn',
        message: `${oversized.length} 张超过单张 ${MAX_LOCAL_IMAGE / 1048576}MB 上限，已跳过：${oversized
          .slice(0, 3)
          .map((f) => f.rel)
          .join('、')}${oversized.length > 3 ? ' 等' : ''}`
      });
    }
    runJob(cfg).catch((e) => {
      job.running = false;
      emit({ type: 'fatal', message: String(e.message) });
    });

    json(res, 200, { ok: true, ...jobSnapshot() });
  },

  async 'POST /api/batch/stop'(req, res) {
    if (!job || !job.running) return json(res, 200, { ok: false, error: '当前没有运行中的任务' });
    job.stopRequested = true;
    emit({ type: 'stopping' });
    json(res, 200, { ok: true });
  },

  async 'POST /api/batch/retry'(req, res) {
    if (!job) return json(res, 200, { ok: false, error: '没有可重试的任务' });
    if (job.running) return json(res, 200, { ok: false, error: '任务运行中' });
    const failed = job.items.filter((i) => i.status === 'failed' || i.status === 'pending');
    if (!failed.length) return json(res, 200, { ok: false, error: '没有失败项需要重试' });
    failed.forEach((i) => {
      i.status = 'pending';
      i.error = '';
      i.ms = 0;
    });
    job.stopRequested = false;
    job.running = true;
    job.finishedAt = null;
    // 沿用任务启动时的配置：中途改设置不应影响这次重试的口径
    const cfg = job.cfg || loadConfig();
    syncJobHistory();
    emit({ type: 'started', ...jobSnapshot().job });
    runJob(cfg).catch((e) => {
      job.running = false;
      emit({ type: 'fatal', message: String(e.message) });
    });
    json(res, 200, { ok: true, ...jobSnapshot() });
  },

  /** 批量任务历史（含正在跑的那条）：刷新页面 / 重启服务后靠它恢复 */
  async 'GET /api/batch/jobs'(req, res) {
    json(res, 200, { ok: true, jobs: jobHistory });
  },

  /**
   * 删掉一条历史记录。
   * 只删记录：输出目录是用户自己的文件，不是程序生成的缓存，绝不代删。
   */
  async 'POST /api/batch/job/delete'(req, res) {
    const body = await readJsonBody(req);
    const id = String(body.id || '');
    if (!/^job-\d{10,16}-\d{1,6}$/.test(id)) return json(res, 400, { ok: false, error: '非法的任务 id' });
    jobHistory = jobHistory.filter((j) => j.id !== id);
    saveJobHistory();
    json(res, 200, { ok: true });
  },

  async 'GET /api/batch/status'(req, res) {
    // 每次查询都重新登记一遍本次任务的输入/输出目录。
    // 以前这两个目录是从 config.json 里恢复的，现在配置不存界面状态了，
    // 所以改成「服务重启后，页面一问状态就把它们放行」——否则重启后
    // 原图预览和结果图会 403（"该路径不在允许读取的图片目录内"）。
    if (job) {
      allowInputTree(job.inputDir);
      allowImageRoot(job.outputDir);
    }
    json(res, 200, { ok: true, ...jobSnapshot() });
  },

  /** 取某一项的完整诊断信息（请求了什么 / 上游原样返回了什么） */
  async 'POST /api/batch/item'(req, res) {
    if (!job) return json(res, 200, { ok: false, error: '当前没有任务' });
    const body = await readJsonBody(req);
    const it = job.items.find((i) => i.rel === body.rel);
    if (!it) return json(res, 200, { ok: false, error: '找不到这一项：' + body.rel });
    json(res, 200, {
      ok: true,
      item: {
        rel: it.rel,
        abs: it.abs,
        localBytes: it.size || null,
        status: it.status,
        error: it.error || '',
        ms: it.ms || 0,
        out: it.out || '',
        debug: it.debug || null
      }
    });
  },

  /** 拿输出图做对比预览用 */
  async 'GET /api/recent'(req, res) {
    json(res, 200, { ok: true, items: job ? job.items.filter((i) => i.status === 'done').slice(-30).map((i) => ({ rel: i.rel, abs: i.abs, out: i.out })) : [] });
  },

  async 'GET /api/batch/events'(req, res) {
    res.writeHead(
      200,
      Object.assign({}, SEC_HEADERS, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
      })
    );
    res.write(`data: ${JSON.stringify({ type: 'hello', ...jobSnapshot() })}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }, 25000);
    req.on('close', () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
  },

  async 'POST /api/reveal'(req, res) {
    const body = await readJsonBody(req);
    let target = path.resolve(body.path || '');
    // 网络路径（UNC）会让 explorer 主动向对方主机发起 SMB 认证，
    // 顺手把本机凭据摘要发出去 —— 本机工具不需要这个能力，直接拒
    if (/^[\\/]{2}/.test(target)) {
      return json(res, 200, { ok: false, error: '不接受网络路径（\\\\主机\\共享），请用本机文件夹' });
    }
    try {
      if (!fs.existsSync(target)) {
        // 路径还不存在（比如输出文件夹还没生成）时，打开最近一层存在的上级目录。
        // 注意要一路走到盘符：原来的循环用「parent !== root」做条件，会在盘符前一步就退出，
        // 于是「某盘下整条路径都不存在」的情况会误报「路径不存在」。
        let cur = target;
        let found = '';
        for (;;) {
          const parent = path.dirname(cur);
          if (!parent || parent === cur) break;
          if (fs.existsSync(parent)) { found = parent; break; }
          cur = parent;
        }
        if (!found) throw new Error('路径不存在');
        target = found;
      }
      const err = await openInExplorer(target);
      if (err) return json(res, 200, { ok: false, error: `没能打开资源管理器：${err.message}` });
      // 把真正打开的位置回给前端，界面可以据此提示「已打开 X」，
      // 免得窗口开在浏览器后面时用户以为点了没反应
      json(res, 200, { ok: true, path: target });
    } catch (e) {
      json(res, 200, { ok: false, error: String(e.message) });
    }
  },

  /**
   * 浏览器拖文件夹进来只能读到目录名，读不到真实路径 —— 这里按目录名就近搜一次。
   * 只扫「已知线索附近 + 常用目录」的下两级，超过时间/数量上限就停。
   */
  async 'POST /api/find-dir'(req, res) {
    const body = await readJsonBody(req);
    const name = String(body.name || '').trim();
    if (!name) return json(res, 200, { ok: false, error: '没有拿到文件夹名' });
    try {
      // 先查备忘录：用过一次的目录，第二次拖同一个名字就能直接命中
      const memo = loadDirCache()[name.toLowerCase()];
      if (memo) {
        try {
          if (fs.statSync(memo).isDirectory()) return json(res, 200, { ok: true, dirs: [memo], from: 'cache' });
        } catch {
          /* 记下来的目录已经不在（改名 / 删了 / 换盘），继续按名字搜 */
        }
      }
      json(res, 200, { ok: true, dirs: await findDirsByName(name, body.hints || []) });
    } catch (e) {
      json(res, 200, { ok: false, error: String(e.message) });
    }
  },

  async 'GET /api/records'(req, res) {
    json(res, 200, { ok: true, records: loadRecords() });
  },

  async 'POST /api/records/add'(req, res) {
    const body = await readJsonBody(req);
    const rec = body.record || {};
    try {
      json(res, 200, { ok: true, record: appendRecord(rec) });
    } catch (e) {
      json(res, 200, { ok: false, error: String(e.message) });
    }
  },

  async 'POST /api/records/delete'(req, res) {
    const body = await readJsonBody(req);
    try {
      json(res, 200, deleteRecord(String(body.id || '')));
    } catch (e) {
      json(res, 200, { ok: false, error: String(e.message) });
    }
  },

  async 'POST /api/records/clear'(req, res) {
    try {
      json(res, 200, clearRecords());
    } catch (e) {
      json(res, 200, { ok: false, error: String(e.message) });
    }
  },

  async 'GET /api/local-image'(req, res, parsed) {
    const p = parsed.searchParams.get('path') || '';
    try {
      const abs = path.resolve(p);
      // 只放行「已知图片目录里的图片文件」——原来任意路径都能读，
      // 等于把 config.json（含 API Key）也一并交出
      if (!isImageExt(abs)) throw new Error('只允许读取图片文件');
      if (!isAllowedImagePath(abs)) throw new Error('该路径不在允许读取的图片目录内');
      const st = fs.statSync(abs);
      if (!st.isFile()) throw new Error('不是文件');
      const ext = path.extname(abs).toLowerCase();
      let body = fs.readFileSync(abs);
      let mime = MIME_BY_EXT[ext] || 'application/octet-stream';
      if (ext === '.bmp') {
        const { rgba, width, height } = decodeBMP(body);
        body = encodePNG(rgba, width, height);
        mime = 'image/png';
      }
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(
        200,
        Object.assign({}, SEC_HEADERS, {
          'Content-Type': mime,
          'Content-Length': body.length,
          // 允许浏览器短期缓存：进度列表会反复引用同一批缩略图，
          // 原来 no-store 会让它们被反复重新下载
          'Cache-Control': 'private, max-age=300'
        })
      );
      res.end(body);
    } catch (e) {
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(404, Object.assign({}, SEC_HEADERS, { 'Content-Type': 'text/plain; charset=utf-8' }));
      res.end('图片读取失败：' + e.message);
    }
  }
};

/* ------------------------------------------------------------ 生图记录 */

/**
 * 记录里的图片路径**一律相对「这条记录自己的目录」存**（`out-0.png`、`ref-0.src.jpg`），
 * 不存 `C:\...\records\conv_xxx\rXXX\out-0.png` 这种绝对路径。
 *
 * 为什么：记录本来就跟项目放一起，路径没理由钉死在某台机器上。原先存绝对路径，
 * 项目一改盘符、挪个目录、拷到另一台电脑，历史会话里的图就全成了破图 ——
 * 文本和提示词还好好地写在清单里，只有图打不开。
 *
 * 现在存的是相对文件名：出接口时 expandRecord() 按**当前的**目录拼回绝对路径（前端拿到的
 * 仍是绝对路径，一行都不用改）；写盘时 shrinkRecord() 再收敛回相对形式。
 * 老记录里的绝对路径由 migrateRecordsLayout() 在启动时收敛一次，之后永久可移植。
 */

/** 对话 id → 磁盘目录名。非法字符一律剔除（挡住 ../ 逃逸），没有 convId 的归到 _legacy */
function convDirName(convId) {
  const s = String(convId || '').replace(/[^A-Za-z0-9_-]/g, '');
  return s ? `conv_${s.slice(0, 64)}` : RECORD_LEGACY_DIR;
}

/** 磁盘目录名 → 对话 id（_legacy 反推成空串）。只用于补全；记录里的 convId 字段优先 */
function convIdOfDirName(dirName) {
  const n = String(dirName || '');
  if (n === RECORD_LEGACY_DIR) return '';
  return n.startsWith('conv_') ? n.slice(5) : '';
}

/** records 下所有对话目录的名字（记录清单、批量历史都住在这些目录里） */
function listConversationDirs() {
  try {
    return fs
      .readdirSync(RECORD_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && (d.name === RECORD_LEGACY_DIR || d.name.startsWith('conv_')))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/**
 * 一条记录该落在哪个目录（绝对路径）。
 * id 形态跟 appendRecord 生成的一致，非法一律返回 null —— 这个值会被拼进路径做递归删除，
 * 松一点就等于给了一个「删任意目录」的口子。
 * 兼容只传 id 字符串的老写法（那种情况只能按 _legacy 定位，新代码请传记录对象）。
 */
function recordDirOf(rec) {
  const o = typeof rec === 'string' ? { id: rec } : rec || {};
  const id = String(o.id || '');
  if (!/^r\d{10,16}_[a-z0-9]{3,12}$/.test(id)) return null;
  const dir = path.join(RECORD_DIR, convDirName(o.convId), id);
  const rel = path.relative(RECORD_DIR, dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return dir;
}

/** 绝对路径 → 「记录目录内的相对文件名」（幂等；记录外的路径原样留着） */
function relPathWithin(dir, p) {
  const s = String(p || '');
  if (!s || !dir || !path.isAbsolute(s)) return s;
  const rel = path.relative(dir, path.resolve(s));
  // 只有确实落在「这条记录自己的目录」里才收敛；记录外的路径无路可相对，原样留着
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.split(path.sep).join('/');
  // 「先把项目挪了、之后才升级到这一版」：老记录里的绝对路径指的还是旧位置，相对不出来。
  // 这时看同名文件是不是就在这条记录目录里 —— 在就认它，等于顺手把历史救回来。
  // 按记录 id 分目录，所以 out-0.png / ref-0.png 这种名字在一条记录里不会撞。
  const base = path.basename(s);
  try {
    if (base && fs.existsSync(path.join(dir, base))) return base;
  } catch {
    /* 探不到就维持原样 */
  }
  return s;
}

/** 「记录目录内的相对文件名」→ 当前机器上的绝对路径；越界一律返回空串 */
function absPathWithin(dir, p) {
  const s = String(p || '');
  if (!s) return '';
  if (path.isAbsolute(s)) return s; // 老记录 / 记录外路径：原样交给 /api/local-image 判定
  if (!dir) return s;
  const abs = path.resolve(dir, s);
  const rel = path.relative(dir, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return ''; // 挡住 ../ 逃逸
  return abs;
}

/**
 * 记录里带路径的字段一览 —— **只是清单，没有代码依赖它**：
 *   refs[].thumb / refs[].src
 *   images[].file / images[].thumb   （早期版本还有个 images[].path，已被 shrinkRecord 并进 file）
 * 加新字段时照这里改 `shrinkRecord()`（落盘收敛成相对名）和 `expandRecord()`（出接口展开成绝对路径）。
 * 这两个函数是所有图片路径的唯一出入口，别在别处手搓路径。
 */

/** 写盘形态：绝对路径 → 相对文件名（幂等，已经是相对的原样返回） */
function shrinkRecord(rec, dirOverride) {
  const dir = dirOverride || recordDirOf(rec);
  const conv = (o, k) => (o && o[k] ? relPathWithin(dir, o[k]) : '');
  const refs = (rec.refs || []).map((r) => Object.assign({}, r, { thumb: conv(r, 'thumb'), src: conv(r, 'src') }));
  const images = (rec.images || []).map((im) => {
    const o = Object.assign({}, im, { file: conv(im, 'file'), thumb: conv(im, 'thumb') });
    // 早期版本留下的 path 字段：并进 file 之后就不再写盘
    if (!o.file) o.file = relPathWithin(dir, im.path);
    delete o.path;
    return o;
  });
  return Object.assign({}, rec, { refs, images });
}

/** 接口形态：相对文件名 → 当前机器上的绝对路径（前端拿到的仍是绝对路径，不用改） */
function expandRecord(rec, dirOverride) {
  const dir = dirOverride || recordDirOf(rec);
  const refs = (rec.refs || []).map((r) =>
    Object.assign({}, r, { thumb: absPathWithin(dir, r.thumb), src: absPathWithin(dir, r.src) })
  );
  const images = (rec.images || []).map((im) =>
    Object.assign({}, im, { file: absPathWithin(dir, im.file || im.path || ''), thumb: absPathWithin(dir, im.thumb) })
  );
  return Object.assign({}, rec, { refs, images });
}

/**
 * 读**所有对话**的记录，合并成一份扁平清单（时间倒序）。
 * 出接口的形态：图片字段已经是本机绝对路径，前端拿到的和以前一模一样，不用改。
 */
function loadRecords() {
  const out = [];
  listConversationDirs().forEach((dirName) => {
    const dir = path.join(RECORD_DIR, dirName);
    let raw = [];
    try {
      const list = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
      raw = Array.isArray(list) ? list : [];
    } catch {
      return; // 这个对话没有记录清单（只跑过批量、或刚建目录），跳过
    }
    raw.forEach((r) => {
      if (!r || !r.id) return;
      const rec = Object.assign({}, r);
      // 目录名兜底：记录里 convId 缺了就按它所在的目录补上
      // （_legacy 反推成空串，正好就是前端认的「早前的对话」）
      if (!rec.convId) rec.convId = convIdOfDirName(dirName);
      // 一定要传「这条记录自己的目录」（对话目录 + 记录 id），传成 dirName 那一层就少一级、图全读不到
      out.push(expandRecord(rec, recordDirOf(rec) || dir));
    });
  });
  return out.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
}

/**
 * 按对话拆写记录清单。
 * ⚠️ 它会顺手把「磁盘上有、这次没传进来」的对话目录收掉 —— 所以调用方**必须传全量**，
 * 传半个列表等于把没传的那些对话删掉。clear() 正是靠这个语义清场的。
 */
function saveRecords(list) {
  const rows = (list || []).map((r) => shrinkRecord(r));
  const byConv = new Map();
  rows.forEach((r) => {
    const name = convDirName(r.convId);
    if (!byConv.has(name)) byConv.set(name, []);
    byConv.get(name).push(r);
  });
  fs.mkdirSync(RECORD_DIR, { recursive: true });
  byConv.forEach((group, name) => {
    const dir = path.join(RECORD_DIR, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(group, null, 2), 'utf8');
  });
  listConversationDirs().forEach((name) => {
    if (!byConv.has(name)) dropConversationDir(name);
  });
}

/**
 * 收掉一个对话目录。
 * 目录里除了生图记录还可能住着批量历史（jobs.json）—— 有就只删记录那部分，
 * 别把用户还没看过的批量历史一起陪葬。
 */
function dropConversationDir(name) {
  const dir = path.join(RECORD_DIR, name);
  let keepJobs = false;
  try {
    keepJobs = fs.existsSync(path.join(dir, 'jobs.json'));
  } catch {
    /* 探不到就当没有 */
  }
  if (!keepJobs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 删不掉就留着，不影响读取 */
    }
    return;
  }
  try {
    fs.rmSync(path.join(dir, 'index.json'), { force: true });
  } catch {
    /* ignore */
  }
  try {
    fs.readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^r\d{10,16}_[a-z0-9]{3,12}$/.test(d.name))
      .forEach((d) => {
        try {
          fs.rmSync(path.join(dir, d.name), { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      });
  } catch {
    /* ignore */
  }
}

/**
 * 按对话裁剪：每个对话只留 RECORD_LIMIT 条，最多留 RECORD_CONV_LIMIT 个对话。
 * 被裁掉的记录连图一起从磁盘删掉，返回保留下来的清单（时间倒序）。
 */
function pruneRecords(list) {
  const groups = new Map();
  (list || []).forEach((r) => {
    const k = convDirName(r.convId);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  });

  const kept = [];
  const dropped = [];
  groups.forEach((rows) => {
    rows.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
    kept.push(...rows.slice(0, RECORD_LIMIT));
    dropped.push(...rows.slice(RECORD_LIMIT));
  });

  // 对话太多：按「最近一条记录的时间」排，只留最新的 RECORD_CONV_LIMIT 个，其余整组丢掉
  const dead = new Set(
    [...groups.entries()]
      .map(([k, rows]) => ({ k, latest: Number(rows[0] && rows[0].createdAt) || 0 }))
      .sort((a, b) => b.latest - a.latest)
      .slice(RECORD_CONV_LIMIT)
      .map((x) => x.k)
  );

  const finalKept = [];
  kept.forEach((r) => {
    if (dead.has(convDirName(r.convId))) dropped.push(r);
    else finalKept.push(r);
  });

  dropped.forEach((r) => {
    const d = recordDirOf(r);
    if (!d) return;
    // 同步删：异步删一旦失败就静默留一堆孤儿目录，而这次淘汰之后再没人会想起它们
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* 删不掉就留着，不影响读取 */
    }
  });
  return finalKept.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
}

/**
 * 删一条记录，返回新的全量清单（接口层直接拿去响应）。
 * id 会被拼进路径做递归删除，所以先按 id 在清单里找到这条记录，再用**它自己带的 convId**
 * 推出目录 —— 光凭一个 id 是定位不到对话目录的。
 * 找不到就当删成功（幂等）：删一条对话是逐条调的，重复 / 并发调用很正常。
 */
function deleteRecord(id) {
  const all = loadRecords();
  const target = all.find((r) => r.id === id);
  if (!target) return { ok: true, records: all };
  const dir = recordDirOf(target);
  if (!dir) return { ok: false, error: '非法的记录 id' };
  const list = all.filter((r) => r.id !== id);
  fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  // saveRecords 会把「这个对话一条记录都不剩」的目录一起收掉
  // （该对话还有批量历史的话，只收记录那部分，历史留着）
  saveRecords(list);
  return { ok: true, records: list };
}

/** 清空所有生图记录：空清单交给 saveRecords，所有对话目录连图一起收（批量历史留着） */
function clearRecords() {
  saveRecords([]);
  return { ok: true };
}

function stripDataUri(s) {
  return String(s || '').replace(/^data:[^,]+,/, '');
}

/**
 * 存一条生图记录：结果图原样落盘，参考图/结果图的缩略图由前端 canvas 生成后一并传来。
 * 落点按这条记录自带的 convId 决定目录：records\<conv_xxx>\<recordId>\ —— 一个对话一个文件夹。
 * entry 里的图片字段一律是**相对记录目录的文件名**；返回值走 expandRecord() 拼回绝对路径，
 * 前端拿到的仍然是可以直接读的完整路径。
 */
function appendRecord(rec) {
  fs.mkdirSync(RECORD_DIR, { recursive: true });
  const convId = String(rec.convId || '');
  const id = `r${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const dir = recordDirOf({ id, convId });
  fs.mkdirSync(dir, { recursive: true });

  /**
   * 参考图存两份：
   *   ref-i.png     显示用缩略图（前端 canvas 生成，160px，很小）
   *   ref-i.src.jpg 复用副本 —— 「编辑重发 / 重试失败」要把这张参考图重新提交给模型，
   *                 拿 160px 的缩略图去生成等于糊图，所以额外留一份 1536px 的可用副本。
   *   （原图不存：单次最多 14 张、上限 30MB，60 条记录能堆到 GB 级）
   */
  const refs = (rec.refs || []).slice(0, 14).map((r, i) => {
    const name = r.name || `参考图${i + 1}`;
    const out = { name, thumb: '', src: '' };
    if (r.thumb) {
      fs.writeFileSync(path.join(dir, `ref-${i}.png`), Buffer.from(stripDataUri(r.thumb), 'base64'));
      out.thumb = `ref-${i}.png`; // 只记文件名，绝对路径不写进清单（见 relPathWithin）
    }
    if (r.src) {
      const data = stripDataUri(r.src);
      if (data) {
        // 扩展名要跟真实内容对得上：/api/local-image 是按扩展名发 Content-Type 的，
        // 写错类型浏览器直接不认。只信 png/jpeg/webp/gif 这几种，其余一律嗅探。
        const declared = String(r.src).match(/^data:(image\/(?:png|jpeg|jpg|webp|gif));/i);
        const ext =
          (declared && extOfMime(declared[1])) ||
          extOfMime(sniffMime(Buffer.from(data.slice(0, 64), 'base64'))) ||
          '.jpg';
        fs.writeFileSync(path.join(dir, `ref-${i}.src${ext}`), Buffer.from(data, 'base64'));
        out.src = `ref-${i}.src${ext}`;
      }
    }
    return out;
  });

  const images = (rec.images || []).slice(0, 8).map((im, i) => {
    const data = stripDataUri(im.base64);
    if (!data) return null;
    const ext = extOfMime(im.mime) || guessExtFromMime(sniffMime(Buffer.from(data.slice(0, 64), 'base64')));
    const file = `out-${i}${ext}`;
    const buf = Buffer.from(data, 'base64');
    fs.writeFileSync(path.join(dir, file), buf);
    let thumb = '';
    if (im.thumb) {
      thumb = `out-${i}.thumb.png`;
      fs.writeFileSync(path.join(dir, thumb), Buffer.from(stripDataUri(im.thumb), 'base64'));
    }
    return { file, thumb, mime: im.mime || '', bytes: buf.length };
  }).filter(Boolean);

  const entry = {
    id,
    createdAt: rec.createdAt || Date.now(),
    prompt: String(rec.prompt || ''),
    model: rec.model || '',
    // 来源/协议存机器可读的 key：重试失败时要按原样切回去，
    // 只有 label 是不够的（label 改文案就对不上了）
    provider: rec.provider || '',
    protocol: rec.protocol || '',
    providerLabel: rec.providerLabel || '',
    protocolLabel: rec.protocolLabel || '',
    ratio: rec.ratio || '',
    size: rec.size || '',
    count: Number(rec.count) || images.length,
    ms: Number(rec.ms) || 0,
    kind: rec.kind || 'single',
    // 属于哪个对话（左侧栏分组 + 落盘目录都用它）。老记录没有这个字段，前端会归到「早前的对话」
    convId,
    failed: String(rec.failed || ''),
    notes: Array.isArray(rec.notes) ? rec.notes.slice(0, 8) : [],
    refs,
    images
  };

  // 每个对话各留 RECORD_LIMIT 条、最多留 RECORD_CONV_LIMIT 个对话，超出部分连图一起删掉
  const list = [entry].concat(loadRecords());
  saveRecords(pruneRecords(list));
  return expandRecord(entry, dir);
}

function extOfMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg';
  if (m.includes('webp')) return '.webp';
  if (m.includes('gif')) return '.gif';
  return '.png';
}

/* ------------------------------------------- 拖文件夹：按目录名反查绝对路径 */
const FIND_DIR_MAX = 6000;
const FIND_DIR_MS = 3500;

/**
 * 「文件夹名 → 绝对路径」的备忘录。
 * 浏览器拖拽只能给出文件夹名，深一点路径（D:\素材\9月\待修图）靠搜索够不着，
 * 所以凡是成功用过的目录都记一笔，下次拖同一个文件夹就能秒认。
 *
 * 放 records\.cache\ 下、而不是 records\ 根目录：它压根不是「记录」，
 * 只是本机路径的反查表（还带 300 条的上限淘汰），没理由跟生图记录并排躺着。
 * 旧位置（records\dir-cache.json）由 migrateRecordsLayout() 在启动时搬过来。
 */
const DIR_CACHE_FILE = path.join(RECORD_DIR, '.cache', 'dir-cache.json');
const DIR_CACHE_LIMIT = 300;

function loadDirCache() {
  let o = {};
  try {
    o = JSON.parse(fs.readFileSync(DIR_CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
  if (!o || typeof o !== 'object') return {};
  // 备忘录里存的是绝对路径，换目录 / 换台电脑之后全是死的：
  // 读的时候顺手筛一遍，只留下当前确实存在的目录，
  // 免得「拖个文件夹」先拿到一条已经失效的答案再去搜，也免得死条目越积越多
  const out = {};
  Object.keys(o).forEach((k) => {
    try {
      if (o[k] && fs.statSync(o[k]).isDirectory()) out[k] = o[k];
    } catch {
      /* 目录没了（或这台机器上本来就没有），丢掉这一条 */
    }
  });
  return out;
}

function rememberDir(dir) {
  const abs = path.resolve(String(dir || ''));
  const name = path.basename(abs).toLowerCase();
  if (!name || !abs) return;
  try {
    const cache = loadDirCache();
    // 重新插入一次，让最近用过的排在后面
    delete cache[name];
    cache[name] = abs;
    const keys = Object.keys(cache);
    if (keys.length > DIR_CACHE_LIMIT) keys.slice(0, keys.length - DIR_CACHE_LIMIT).forEach((k) => delete cache[k]);
    fs.mkdirSync(path.dirname(DIR_CACHE_FILE), { recursive: true });
    fs.writeFileSync(DIR_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch {
    /* 记不住不影响主流程 */
  }
}

/* --------------------------------- 旧落盘布局 → 按对话分组（一次性，幂等） */

/**
 * 把上一版的「全局一份」落盘布局迁成按对话分组。分三步，各自判断、互不依赖：
 *   ① records\dir-cache.json  → records\.cache\dir-cache.json
 *   ② records\jobs.json       → records\<conv_xxx>\jobs.json（按每条任务自己的 convId 拆）
 *   ③ records\index.json + records\<recordId>\ → records\<conv_xxx>\<recordId>\ + 各对话的 index.json
 *
 * 判据就是「旧文件还在不在」—— 迁完立即删掉，所以再来一次会直接跳过，重复调用安全。
 * 中途失败也不会脏：第 ③ 步是「全量拆写」，只要旧清单还没删，下次启动会从头再走一遍。
 */
function migrateRecordsLayout() {
  // ① dir-cache：它跟记录无关，只是挪个位置
  try {
    if (fs.existsSync(DIR_CACHE_LEGACY)) {
      fs.mkdirSync(path.dirname(DIR_CACHE_FILE), { recursive: true });
      if (fs.existsSync(DIR_CACHE_FILE)) fs.rmSync(DIR_CACHE_LEGACY, { force: true });
      else fs.renameSync(DIR_CACHE_LEGACY, DIR_CACHE_FILE);
    }
  } catch {
    /* 挪不动就留着，下次启动再试 */
  }

  // ② 批量历史：按每条任务自己的 convId 拆进各对话目录
  try {
    if (fs.existsSync(BATCH_HISTORY_LEGACY)) {
      let list = [];
      try {
        list = JSON.parse(fs.readFileSync(BATCH_HISTORY_LEGACY, 'utf8'));
      } catch {
        list = [];
      }
      if (Array.isArray(list) && list.length) {
        const byConv = new Map();
        list.forEach((j) => {
          if (!j || !j.id) return;
          const name = convDirName(j.convId);
          if (!byConv.has(name)) byConv.set(name, []);
          byConv.get(name).push(j);
        });
        byConv.forEach((rows, name) => {
          const dir = path.join(RECORD_DIR, name);
          fs.mkdirSync(dir, { recursive: true });
          const file = path.join(dir, 'jobs.json');
          let exist = [];
          try {
            const t = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (Array.isArray(t)) exist = t;
          } catch {
            /* 目标文件还没有，正常 */
          }
          const ids = new Set(exist.map((x) => x && x.id));
          fs.writeFileSync(file, JSON.stringify(exist.concat(rows.filter((x) => !ids.has(x.id))), null, 2), 'utf8');
        });
      }
      fs.rmSync(BATCH_HISTORY_LEGACY, { force: true });
    }
  } catch {
    /* 拆不动就留着，最多是这回历史少读几条 */
  }

  // ③ 生图记录：把 records\<recordId>\ 挪进 records\<conv_xxx>\<recordId>\
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(RECORD_INDEX_LEGACY, 'utf8'));
  } catch {
    return; // 旧清单不在：要么已经迁过，要么全新安装
  }
  if (!Array.isArray(raw)) return;

  const moved = [];
  raw.forEach((r) => {
    if (!r || !r.id) return;
    const rec = Object.assign({}, r);
    const convId = String(rec.convId || '');
    rec.convId = convId;
    const convDir = path.join(RECORD_DIR, convDirName(convId));
    const oldDir = path.join(RECORD_DIR, r.id);
    const newDir = path.join(convDir, r.id);
    try {
      if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
        fs.mkdirSync(convDir, { recursive: true });
        fs.renameSync(oldDir, newDir); // 同一个盘内改名，又快又原子
      }
    } catch {
      /* 搬不动就算了：图会读不到（界面显示占位），文字信息还在 */
    }
    // 更早的记录里可能还是绝对路径：按它自己的目录收敛成相对文件名
    moved.push(shrinkRecord(rec, fs.existsSync(newDir) ? newDir : oldDir));
  });

  saveRecords(moved); // 按对话拆写；顺带收掉磁盘上没有对应记录的残留目录
  try {
    fs.rmSync(RECORD_INDEX_LEGACY, { force: true });
  } catch {
    /* 删不掉的话下次启动会再迁一遍 —— saveRecords 是幂等的，不会写脏 */
  }
  if (moved.length) {
    console.log(
      `  已把 ${moved.length} 条生图记录按对话归入 ${new Set(moved.map((r) => convDirName(r.convId))).size} 个目录`
    );
  }
  // 根下还躺着清单之外的 r* 目录（历史淘汰留下的空壳、或手工删过清单）。
  // 原样保留、只提示一句 —— 「删用户数据」这种事不该被一次布局迁移顺手做掉。
  try {
    const orphans = fs
      .readdirSync(RECORD_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^r\d{10,16}_[a-z0-9]{3,12}$/.test(d.name))
      .map((d) => d.name);
    if (orphans.length) {
      console.log(
        `  提示：records 下还有 ${orphans.length} 个不在清单里的记录目录，已原样保留（${orphans.slice(0, 3).join('、')}${
          orphans.length > 3 ? ' …' : ''
        }）`
      );
    }
  } catch {
    /* 提示失败无所谓 */
  }
}

/** 这些目录又大又没有素材，搜文件夹时不下钻（同名目标仍然会被记录） */
const FIND_DIR_SKIP = new Set([
  'node_modules',
  '$recycle.bin',
  'system volume information',
  'windows',
  'program files',
  'program files (x86)',
  'programdata',
  'appdata',
  'application data',
  '.git',
  '.cache',
  'temp',
  'tmp'
]);

/** 本机存在的盘符根目录（C:\ … Z:\），系统盘排最后 */
function driveRoots() {
  const out = [];
  for (let i = 2; i <= 25; i++) {
    const root = String.fromCharCode(65 + i) + ':\\';
    try {
      if (fs.existsSync(root)) out.push(root);
    } catch {
      /* ignore */
    }
  }
  // 素材一般不在系统盘，而搜索预算（目录数 / 时间）是有限的：
  // 把 C: 排到最后，D:/E: 这些资料盘先搜，命中率明显更高。
  return out.filter((r) => !/^C:/i.test(r)).concat(out.filter((r) => /^C:/i.test(r)));
}

async function findDirsByName(name, hints) {
  const target = String(name || '').trim().toLowerCase();
  if (!target) return [];

  const roots = [];
  const addRoot = (p) => {
    if (!p) return;
    const abs = path.resolve(p);
    if (!roots.some((r) => r.toLowerCase() === abs.toLowerCase())) roots.push(abs);
  };
  // 已知线索本身、它的上级和上两级 —— 拖进来的文件夹多半就在最近用过的目录附近
  (hints || []).forEach((h) => {
    if (!h) return;
    try { if (fs.statSync(h).isDirectory()) addRoot(h); } catch { /* ignore */ }
    addRoot(path.dirname(path.resolve(h)));
    addRoot(path.dirname(path.dirname(path.resolve(h))));
  });
  const home = process.env.USERPROFILE || '';
  if (home) {
    addRoot(home);
    ['Desktop', 'Pictures', 'Documents', 'Downloads'].forEach((d) => addRoot(path.join(home, d)));
  }

  const hits = [];
  const seen = new Set();
  const started = Date.now();
  let visited = 0;
  const queue = roots.map((dir) => ({ dir, depth: 0 }));
  /**
   * 各盘符根目录排到队尾。
   * 素材多半放在 D:/E: 而不是用户目录里，只搜「用户目录 + 最近用过的目录」经常扑空
   * （现象就是拖了文件夹进来却提示「没能自动定位」）。
   * 下钻有 6000 个目录 / 3.5 秒的双重上限，Windows、Program Files、AppData 这类
   * 目录不下钻，所以不会把整块盘扫一遍。线索命中的目录仍然优先。
   */
  driveRoots().forEach((dir) => queue.push({ dir, depth: 0 }));

  while (queue.length) {
    if (hits.length >= 20 || visited >= FIND_DIR_MAX || Date.now() - started > FIND_DIR_MS) break;
    const cur = queue.shift();
    if (seen.has(cur.dir.toLowerCase())) continue;
    seen.add(cur.dir.toLowerCase());
    visited++;
    let ents;
    try {
      ents = await fsp.readdir(cur.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith('.') || e.name === '$RECYCLE.BIN') continue;
      const abs = path.join(cur.dir, e.name);
      const lname = e.name.toLowerCase();
      if (lname === target) hits.push(abs);
      else if (FIND_DIR_SKIP.has(lname)) continue;
      if (cur.depth < 3) queue.push({ dir: abs, depth: cur.depth + 1 });
    }
  }
  return hits;
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  // 用 relative 判断包含关系，比 startsWith 更稳（不会把 publicX 误判成 public 的子目录）
  const relToPublic = path.relative(PUBLIC_DIR, filePath);
  if (relToPublic.startsWith('..') || path.isAbsolute(relToPublic)) {
    res.writeHead(403, SEC_HEADERS);
    res.end('forbidden');
    return;
  }
  sendStaticFile(res, filePath);
}

function sendStaticFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, Object.assign({}, SEC_HEADERS, { 'Content-Type': 'text/plain; charset=utf-8' }));
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime =
      {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json; charset=utf-8',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.png': 'image/png'
      }[ext] || 'application/octet-stream';
    const headers = Object.assign({}, SEC_HEADERS, {
      'Content-Type': mime,
      'Cache-Control': 'no-store'
    });
    let body = buf;
    if (ext === '.html') {
      // 一次性口令注入页面；内联脚本用一次性 nonce 放行，避免给 script-src 开 'unsafe-inline'
      const nonce = crypto.randomBytes(16).toString('base64');
      body = Buffer.from(
        buf.toString('utf8').replace(/%%APP_TOKEN%%/g, APP_TOKEN).replace(/%%CSP_NONCE%%/g, nonce),
        'utf8'
      );
      headers['Content-Security-Policy'] = [
        "default-src 'self'",
        "script-src 'self' 'nonce-" + nonce + "'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "media-src 'self' data: blob:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'"
      ].join('; ');
    } else {
      headers['Content-Security-Policy'] = "default-src 'self'; frame-ancestors 'none'";
    }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(body);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://${HOST}:${PORT}`);
  const pathname = parsed.pathname;

  // 只服务本机页面：来自其它 Origin 的请求一律拒绝
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
    return json(res, 403, { ok: false, error: '仅允许本机页面访问' });
  }

  if (pathname.startsWith('/api/')) {
    // <img src> 和 EventSource 没法带自定义头，所以同时接受查询参数
    const token = req.headers['x-app-token'] || parsed.searchParams.get('token');
    if (token !== APP_TOKEN) return json(res, 403, { ok: false, error: '无效的会话口令，请刷新页面' });
    const handler = API[`${req.method} ${pathname}`];
    if (!handler) return json(res, 404, { ok: false, error: `未知接口 ${req.method} ${pathname}` });
    try {
      await handler(req, res, parsed);
    } catch (e) {
      // 连接可能已经断了（例如请求体超限被 destroy），写响应本身也要护住，
      // 否则这里抛出去会变成 unhandledRejection
      try {
        if (!res.headersSent) json(res, 500, { ok: false, error: String(e.message) });
        else if (!res.writableEnded) res.end();
      } catch {
        /* 连接已销毁，忽略 */
      }
    }
    return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405, SEC_HEADERS);
    res.end('Method Not Allowed');
    return;
  }
  serveStatic(req, res, pathname);
});

// 本机 PID 落盘：无窗口启动时没有控制台可关，只能靠 停止.vbs 按 PID 结束。
// 只在自己启动时覆盖，避免把别人的记录改掉。
const PID_FILE = path.join(APP_DIR, '.server.pid');

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  try {
    fs.writeFileSync(PID_FILE, String(process.pid));
  } catch {
    /* 写不了就只是不能按 PID 停，不影响服务本身 */
  }
  // 先把配置里记着的输入/输出目录和记录目录登记成可读的图片目录
  seedImageRoots();
  // 旧落盘布局（全局一份 index.json / jobs.json）一次性归位成「按对话分组」。
  // 必须排在读记录 / 读历史之前，否则读到的还是旧位置。
  migrateRecordsLayout();
  // 再把批量任务历史读回来：顺带登记历史任务用过的目录，否则它们的缩略图会 403
  loadJobHistory();
  // 预热桌面助手：这样第一次点「浏览 / 打开」就能立刻出窗口，不用等那 1.4s。
  // 闲置 10 分钟会自动退出，不会一直占着内存。
  warmDesktopWorker().catch(() => {});
  console.log('');
  console.log('  ╭──────────────────────────────────────────────╮');
  console.log('  │            AI IMG HUB · 本地服务已启动        │');
  console.log('  ╰──────────────────────────────────────────────╯');
  console.log(`  地址：${url}`);
  console.log(`  配置：${CONFIG_PATH}`);
  console.log('  关闭此窗口即停止服务（Ctrl+C）');
  console.log('');
  if (!NO_OPEN) {
    try {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
    } catch {
      /* ignore */
    }
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n  端口 ${PORT} 已被占用。换一个端口再试：node server.js ${PORT + 1}\n`);
  } else {
    console.error('\n  服务启动失败：', e.message, '\n');
  }
  process.exit(1);
});

process.on('SIGINT', () => {
  console.log('\n  已停止。');
  process.exit(0);
});

// 服务退出时把常驻的桌面助手一起带走，别留下孤儿 PowerShell 进程
process.on('exit', () => {
  // 顺手清掉 PID 文件。被 taskkill /F 强行结束时这个回调不会跑，
  // 那种情况由 停止.vbs 自己删（它无论如何都会删）。
  try {
    if (fs.existsSync(PID_FILE) && String(fs.readFileSync(PID_FILE, 'utf8')).trim() === String(process.pid)) {
      fs.unlinkSync(PID_FILE);
    }
  } catch {
    /* ignore */
  }
  if (desktopWorker) {
    try {
      desktopWorker.proc.kill();
    } catch {
      /* ignore */
    }
  }
});
