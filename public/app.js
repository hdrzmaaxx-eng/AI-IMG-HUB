/* ============================================================
   AI IMG HUB · 前端逻辑
   ============================================================ */
'use strict';

const TOKEN = window.__APP_TOKEN__ || '';
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/**
 * 界面记忆只存浏览器本地，绝不进 config.json。
 * config.json 的边界是「凭据 + 接口 + 参数默认值」，服务端执行任务时不需要
 * 「上次选了哪个文件夹 / 上次粘的提示词」，所以这些东西归 localStorage 管。
 * 换浏览器、清缓存、换机器会回到默认值，属于预期行为。
 */
const UI_KEY = 'aiimghub.ui-state';
function loadUiState() {
  try {
    return JSON.parse(localStorage.getItem(UI_KEY) || '{}') || {};
  } catch {
    return {};
  }
}
function saveUiState(patch) {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify({ ...loadUiState(), ...patch }));
  } catch {
    /* 无痕模式等写不了就算了，不影响主流程 */
  }
}

/**
 * 上次跑批用的目录。
 *
 * 它**不参与界面还原**（打开页面 / 发完一轮，输入框都是干净的）：
 * 只在「选择文件夹」和「按名字反查目录」时当起始位置，省得每次都从头点。
 * 旧的 inputDir 键还认，免得老用户升级后那点线索白丢。
 */
function lastInputDirHint() {
  const ui = loadUiState();
  return ui.lastInputDir || ui.inputDir || '';
}

/** 空的一组胶囊取值：role → 值（空串 = 不传，交给上游默认） */
function emptyPicks() {
  return { ratio: '', size: '', res: '', tier: '' };
}

const state = {
  config: null,
  // 兜底用的档位表：正常情况下胶囊的选项来自「当前模型的参数表」，这两个只在
  // 模型不在内置目录里（用户手输模型名）时兜底，见 pillPlan()
  ratios: ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'],
  sizes: ['1K', '2K', '4K'],
  counts: [1, 2, 3, 4],
  providers: [],
  protocols: [],
  models: {},
  /**
   * 「1K / 2K / 4K」在各模型上的含义（model-catalog.js 的 RESOLUTION，随 bootstrap 下发）。
   * 三家不是一个东西：banana-2 是 imageSize 档位、tt-image-2 藏在 size 像素里、
   * ALAPI 是 resolution 且 4k 只支持六个比例。键是「模型名@来源」。
   */
  resolutions: {},
  /**
   * 被上游拒过 n>1 的「来源|协议|模型」组合。
   * 协议表说「支持原生 n」只是纸面能力，有些渠道实际只收 n=1 ——
   * 服务端撞到过就会把组合名报回来，这里记下，让「出几张」的提示说人话。
   */
  nativeNBlocked: new Set(),
  // 两个来源的 Key 各自保留，切换来源时不会把另一个清掉
  keys: { agg: '', alapi: '' },
  // picks 是胶囊上的选择，键就是角色名（ratio / size / res / tier），换模型时按新模型重算
  single: { picks: emptyPicks(), count: 1, refs: [], results: [] },
  /**
   * 界面只有一种，靠模式区分语义：生图（拖图片）/ 批量（拖文件夹）。
   * 批量任务全部挂在 batchJobs 上，每条一个气泡，服务端也有历史。
   */
  batch: { picks: emptyPicks(), dir: '', count: 0, liveId: '', liveCtx: null },
  mode: 'single',
  viewMode: 'flow',
  /**
   * 当前对话。每次打开页面都是一个新对话（跟 DeepSeek 一样），
   * 左侧栏按 convId 把历史记录/批量任务分组。
   */
  convId: '',
  sidebarCollapsed: false,
  batchJobs: [],
  batchExpanded: new Set(),
  es: null,
  records: [],
  /**
   * 正在生成、还没落盘的那几轮：只在内存里，显示完就被真实记录顶替。
   * 每条都带自己的 convId —— 生图可以并发，也可以中途切对话 / 开新对话，
   * 占位气泡只出现在它自己那条对话里，落盘时也回到它自己那条对话。
   */
  pendingRecords: []
};

/* ------------------------------------------------------------ 基础设施 */

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json', 'x-app-token': TOKEN }),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`服务返回异常（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }
  // 服务重启后口令会变，这时所有接口都会 403 —— 直接引导用户刷新，别只报一句看不懂的错
  if (data && data.error && /会话口令|仅允许本机页面/.test(String(data.error))) {
    showConnBanner('与本地服务的会话已失效（服务可能重启过）。刷新页面即可恢复。');
  }
  return data;
}

function toast(msg, type) {
  const wrap = $('#toastWrap');
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  wrap.appendChild(el);
  // 最多留 4 条，多了就把最老的挤掉，免得盖满整个底部
  while (wrap.children.length > 4) wrap.firstElementChild.remove();
  // 退场交给 CSS 过渡（不是关键帧）：连续弹多条时不会互相打断。
  // 要人读的（提醒 / 报错）停久一点，纯报喜的快点走
  setTimeout(() => {
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 220);
  }, type === 'warn' || type === 'err' ? 6000 : 2800);
}

/* 与服务断开时的常驻提示条：原来 SSE 断线是静默的，服务重启后页面只会「点了没反应」 */
let connBannerShown = false;
// 侧栏列表缓存开关：接口数据真正加载完才允许更新，免得服务断开时把缓存冲成空的
let convCacheReady = false;
// 上一帧「在跑的批量任务」指纹，侧栏不必为每条进度事件重画（见 syncSidebarRunning）
let sbRunKey = '';
function showConnBanner(text) {
  const el = $('#connBanner');
  if (!el) return;
  $('#connBannerText').textContent = text;
  el.hidden = false;
  connBannerShown = true;
}
function hideConnBanner() {
  const el = $('#connBanner');
  if (!el || !connBannerShown) return;
  el.hidden = true;
  connBannerShown = false;
}

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function fmtMs(ms) {
  if (!ms) return '';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
  return Math.floor(ms / 60000) + 'm' + Math.round((ms % 60000) / 1000) + 's';
}

function fmtDur(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + ' 秒';
  const m = Math.floor(s / 60);
  if (m < 60) return m + ' 分 ' + (s % 60) + ' 秒';
  return Math.floor(m / 60) + ' 时 ' + (m % 60) + ' 分';
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function extOf(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg';
  if (m.includes('webp')) return '.webp';
  return '.png';
}

function imgUrl(localPath) {
  return `/api/local-image?path=${encodeURIComponent(localPath)}&token=${TOKEN}`;
}

/**
 * 图读不到时（文件被删 / 路径失效 / 项目被挪到别的目录或别的电脑）在它原位顶一块占位。
 * 历史记录里的图最常见的就是这个原因 —— 只留一个破图标，看上去像程序坏了，
 * 说清楚是「读不到」才好判断该重跑还是该去把文件找回来。
 *
 * 做法是「藏起原图 + 旁边插占位」，不是替换节点：调用方手里的 img 引用仍然有效，
 * 同一个位置之后换上新地址（重试出图、换参考图）还能正常显示，占位会自己撤掉。
 */
function onImgError(img, tip) {
  const clear = () => {
    const nx = img.nextElementSibling;
    if (nx && nx.classList.contains('img-missing')) nx.remove();
    img.classList.remove('is-missing');
  };
  img.addEventListener('load', clear);
  img.addEventListener('error', () => {
    img.classList.add('is-missing');
    const nx = img.nextElementSibling;
    if (nx && nx.classList.contains('img-missing')) return;
    const ph = document.createElement('div');
    ph.className = 'img-missing';
    ph.textContent = tip || '图片读不到';
    ph.title = '图片读不到：文件可能已被删除，或路径已失效（项目换过目录 / 换过电脑）';
    img.parentNode.insertBefore(ph, img.nextSibling);
  });
}

/** 兼容旧调用点：单张/一组图都走新的查看器（可缩放、左右切换、标注） */
function showLightbox(url) {
  if (!url) return;
  openViewer([url], 0);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/\n/g, ' ');
}

/* ------------------------------------------------------------ 参数胶囊
 * 胶囊**完全由当前模型的参数表驱动** —— 换模型，胶囊的数量、标题、选项一起变：
 *   banana-2             → 比例 aspectRatio · 分辨率 imageSize · 思考 thinkingLevel
 *   tt-image-2           → 尺寸 size（文档里的 34 个像素尺寸）· 画质 quality
 *   gpt-image-2 (ALAPI)  → 比例 size（比例枚举）· 分辨率 resolution
 * 模型表里没有的参数，对应的胶囊就不会出现；选项一律按文档原值渲染，不做本地加工。
 * 模型不在内置目录里时（用户在设置里手输模型名）退回 state.ratios / state.sizes 兜底。
 */

/** 一个语义角色可能对应多个字段名（各家叫法不一样），按顺序取第一个存在的 */
const PILL_ROLES = [
  { role: 'ratio', keys: ['aspectRatio', 'aspect_ratio'] },
  { role: 'size', keys: ['size'] },
  { role: 'res', keys: ['imageSize', 'resolution'] },
  { role: 'tier', keys: ['quality', 'thinkingLevel'] }
];

const ROLE_META = {
  ratio: { label: '比例', title: '图片比例' },
  size: { label: '尺寸', title: '图片尺寸' },
  res: { label: '分辨率', title: '分辨率' },
  tier: { label: '画质', title: '画质档位' }
};

/** 画质档在平台上叫法不统一，胶囊标题跟着字段名走 */
const TIER_META = {
  quality: { label: '画质', title: '画质档位' },
  thinkingLevel: { label: '思考', title: '思考等级' }
};

const RE_PIXEL_V = /^\d{2,5}\s*[x×]\s*\d{2,5}$/i;
const RE_RATIO_V = /^\d{1,3}\s*:\s*\d{1,3}$/;

/** 枚举参数的展示形态：像素格 / 比例格 / 分段条 */
function paramKind(p) {
  const vals = (p.values || []).map((v) => String(v).trim()).filter((v) => v.toLowerCase() !== 'auto');
  if (vals.length && vals.every((v) => RE_PIXEL_V.test(v))) return 'pixel';
  if (vals.length && vals.every((v) => RE_RATIO_V.test(v))) return 'ratio';
  return 'seg';
}

/* --------------------------------------- 像素枚举：拆成「比例 × 清晰度」两颗胶囊
 * tt-image-2 的文档把比例和清晰度合并在 size 一个字段里（34 个像素值），
 * 官方每个选项的 label 已经写明「2K 竖版 (2:3)」这种组合 —— 这里把 label 解析出来，
 * 界面上就能照别的模型的样子拆成「比例」「分辨率」两颗胶囊，选完再合成回文档要求的
 * 像素写法（文档明确：只传「1K」「16:9」这种档位会报 400）。
 * 只有「size 是像素枚举、且模型没有独立比例/分辨率参数」的模型走这条路。
 */

/** 最大公约数：把像素值化简成最简比例 */
function gcd(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x || 1;
}

/** 官方选项 label（模型表里没存就返回空串） */
function optionLabelOf(param, value) {
  return (param.optionLabels || {})[String(value)] || '';
}

/** 这项属于哪一档清晰度：先认官方 label 的档位前缀，认不出来按总像素量估 */
function tierOfPixel(value, label) {
  const s = String(label || '');
  if (/(^|\s)4K/i.test(s)) return '4K';
  if (/(^|\s)2K/i.test(s)) return '2K';
  if (/(^|\s)1K/i.test(s)) return '1K';
  const [w, h] = String(value).split(/[x×]/i).map(Number);
  const mp = (w * h) / 1048576;
  if (!mp) return '1K';
  // 文档：渠道分组名带 -1K 的只支持「总像素 ≤ 约 260 万」；再往上的实际取值落在
  // 3.2M~6.3M（2K）和 7.0M~8.3M（4K），取中间值切开
  if (mp <= 2.6) return '1K';
  if (mp <= 6.6) return '2K';
  return '4K';
}

/** 这项是什么比例：官方 label 的括注优先，没有就按像素值化简 */
function ratioOfPixel(value, label) {
  const m = String(label || '').match(/[(（]\s*(\d{1,3})\s*[:：]\s*(\d{1,3})\s*[)）]/);
  if (m) return `${Number(m[1])}:${Number(m[2])}`;
  const [w, h] = String(value).split(/[x×]/i).map(Number);
  if (!w || !h) return '';
  const g = gcd(w, h);
  return `${w / g}:${h / g}`;
}

/**
 * 把像素枚举拆成 { auto, ratios, tiers, tierAt(), at() }。
 * 比例或档位只有一种（拆出来跟原来一样）时返回 null，调用方就维持单颗「尺寸」胶囊。
 */
function pixelSplit(param) {
  const byRatio = new Map();
  const tiers = new Set();
  let auto = '';
  for (const raw of param.values || []) {
    const v = String(raw).trim();
    if (v.toLowerCase() === 'auto') {
      auto = v;
      continue;
    }
    if (!RE_PIXEL_V.test(v)) continue;
    const label = optionLabelOf(param, v);
    const ratio = ratioOfPixel(v, label);
    if (!ratio) continue;
    if (!byRatio.has(ratio)) byRatio.set(ratio, new Map());
    byRatio.get(ratio).set(tierOfPixel(v, label), v);
    tiers.add(tierOfPixel(v, label));
  }
  if (byRatio.size < 2 || tiers.size < 2) return null;

  const known = ['1K', '2K', '4K'].filter((t) => tiers.has(t));
  const tierList = known.length ? known : [...tiers];

  /** 这个比例实际能用的档位（选的那档文档里没列就退到最近的） */
  function tierAt(ratio, tier) {
    const g = byRatio.get(ratio);
    if (!g) return '';
    if (g.has(tier)) return tier;
    const i = Math.max(0, tierList.indexOf(tier));
    const near = [tier, ...tierList.slice(i + 1), ...tierList.slice(0, i).reverse()].find((t) => g.has(t));
    return near || '';
  }

  return {
    auto,
    ratios: [...byRatio.keys()],
    tiers: tierList,
    tierAt,
    at(ratio, tier) {
      const t = tierAt(ratio, tier);
      return t ? byRatio.get(ratio).get(t) : '';
    },
    /** 反查：文档里的像素值 → { ratio, tier }（回填老记录用） */
    fromPixel(px) {
      const want = String(px == null ? '' : px).trim().toLowerCase();
      if (!want) return null;
      for (const [ratio, g] of byRatio) {
        for (const [tier, v] of g) {
          if (String(v).toLowerCase() === want) return { ratio, tier };
        }
      }
      return null;
    }
  };
}

function currentModelEntry() {
  const cfg = state.config || {};
  return modelInfo(cfg.model || '', cfg.provider) || {};
}

/* -------------------------------- 「1K / 2K / 4K」在各模型上是什么意思
 * 三家不一样（见 model-catalog.js 的 RESOLUTION），表随 bootstrap 下发：
 *   banana-2  → imageSize 档位，0.5K/1K/2K/4K，同一档各比例像素不同
 *   tt-image-2→ 清晰度藏在 size 的像素枚举里，只有 1K/2K/4K
 *   ALAPI     → resolution 1k/2k/4k，且 4k 只有六个比例有
 */
function modelKeyOf() {
  const cfg = state.config || {};
  return `${cfg.model || ''}@${cfg.provider || 'agg'}`;
}

/** 当前模型的分辨率表（不在表里 = 按平台通用档位处理） */
function resTable() {
  return state.resolutions[modelKeyOf()] || null;
}

/** 比例 × 档位 → 文档写死的像素（没有这个组合返回空串） */
function resPixelOf(ratio, tier) {
  const t = resTable();
  if (!t || !t.pixels || !ratio || !tier) return '';
  const row = t.pixels[ratio];
  if (!row) return '';
  if (Array.isArray(row)) {
    const i = t.tiers.indexOf(tier);
    return i < 0 ? '' : row[i] || '';
  }
  return row[tier] || '';
}

/** 这个比例支持哪些档位（文档没给比例白名单 = 全支持；比例不在文档里 = 空） */
function resTiersAt(ratio) {
  const t = resTable();
  if (!t) return [];
  if (!t.ratios) return t.tiers.slice();
  return (t.ratios[ratio] || []).slice();
}

/** 比例定下来后，这一档按文档退到真正支持的最近一档（没有可用档返回空串） */
function degradeResTier(ratio, tier) {
  const t = resTable();
  if (!t || !tier) return '';
  const allow = t.ratios ? resTiersAt(ratio) : t.tiers.slice();
  if (!allow.length) return '';
  let i = t.tiers.indexOf(tier);
  if (i < 0) i = t.tiers.length - 1;
  for (; i >= 0; i--) {
    if (allow.indexOf(t.tiers[i]) >= 0) return t.tiers[i];
  }
  return allow[0] || '';
}

/** 当前模型的胶囊计划：{ ratio, size, res, tier }，每项是 { role, param, kind } 或 null */
function pillPlan() {
  const schema = currentModelEntry().params || [];
  const out = { ratio: null, size: null, res: null, tier: null, composed: null };
  for (const r of PILL_ROLES) {
    for (const k of r.keys) {
      const p = schema.find((x) => x.name === k && Array.isArray(x.values) && x.values.length);
      if (p) {
        out[r.role] = { role: r.role, param: p, kind: paramKind(p) };
        break;
      }
    }
  }

  // tt-image-2 这类：文档把比例和清晰度合并在 size 一个字段里（像素枚举）。
  // 拆成「比例」「分辨率」两颗胶囊，共用同一个字段，选完再合成回像素写法。
  if (out.size && out.size.kind === 'pixel' && !out.ratio && !out.res) {
    const split = pixelSplit(out.size.param);
    if (split) {
      const base = { name: out.size.param.name, required: out.size.param.required };
      out.ratio = {
        role: 'ratio',
        param: Object.assign({}, base, { values: split.auto ? split.ratios.concat([split.auto]) : split.ratios.slice() }),
        kind: 'ratio',
        composed: split
      };
      out.res = {
        role: 'res',
        param: Object.assign({}, base, { values: split.tiers.slice() }),
        kind: 'seg',
        composed: split
      };
      out.composed = split;
      out.size = null;
    }
  }
  // 兜底只对「压根不在内置目录里」的模型生效（用户在设置里手输的模型名）。
  // 内置模型没写某个参数，就是该模型真的没有它 —— 不能硬塞一颗胶囊出来，
  // 否则 tt-image-2 会平白多一颗发不出去的「分辨率」。
  if (!schema.length) {
    if (!out.ratio && (state.ratios || []).length) {
      out.ratio = { role: 'ratio', param: { name: 'aspectRatio', values: state.ratios.slice() }, kind: 'ratio', fallback: true };
    }
    if (!out.res && (state.sizes || []).length) {
      out.res = { role: 'res', param: { name: 'imageSize', values: state.sizes.slice() }, kind: 'seg', fallback: true };
    }
  }
  return out;
}

function picksOf(batch) {
  return batch ? state.batch.picks : state.single.picks;
}

/** 必填参数补一个稳妥的默认档；选填参数留空（= 不传，交给上游） */
function bestPick(item) {
  const vals = (item.param.values || []).map(String).filter((v) => v.toLowerCase() !== 'auto');
  if (item.kind === 'pixel') {
    let best = vals[0] || '';
    let bs = Infinity;
    for (const v of vals) {
      const [w, h] = v.split(/[x×]/i).map(Number);
      if (!w || !h) continue;
      const score = Math.abs(Math.log(w / 1024)) + Math.abs(Math.log(h / 1024));
      if (score < bs) {
        bs = score;
        best = v;
      }
    }
    return best;
  }
  if (item.kind === 'ratio') return vals.find((v) => v === '1:1') || vals[0] || '';
  if (!item.param.required) return '';
  return vals.find((v) => /^1k$/i.test(v)) || vals[0] || '';
}

/** 换模型 / 切模式后把失效的取值清掉，必填项补默认档 */
function normalizePicks(batch) {
  const plan = pillPlan();
  const picks = picksOf(batch);
  for (const role of ['ratio', 'size', 'res', 'tier']) {
    const item = plan[role];
    if (!item) {
      picks[role] = '';
      continue;
    }
    const ok = item.param.values.some((v) => String(v) === String(picks[role] || ''));
    if (!ok) picks[role] = bestPick(item);
  }
  // 「比例 × 清晰度」这个组合文档里没列（例如某比例只给了 1K）→ 清晰度退到最近的档
  if (plan.composed && picks.ratio && picks.res) {
    const t = plan.composed.tierAt(picks.ratio, picks.res);
    if (t && t !== picks.res) picks.res = t;
  }
  // 同样的道理，但走的是模型自己那份分辨率表：ALAPI 文档里 4k 只有
  // 16:9 / 9:16 / 2:1 / 1:2 / 21:9 / 9:21 六个比例有，选了别的比例就退到 2k。
  // 注意 ALAPI 的比例是装在 size 那颗胶囊里的（plan.size.kind === 'ratio'），
  // 不在 picks.ratio 上，两边都要看。
  const effRatio = picks.ratio || (plan.size && plan.size.kind === 'ratio' ? picks.size : '');
  if (!plan.composed && plan.res && effRatio && picks.res) {
    const deg = degradeResTier(effRatio, picks.res);
    if (deg && deg !== picks.res) picks.res = deg;
  }
  return plan;
}

/** 比例 + 清晰度 → 文档要求的像素写法（选「自动」就原样返回 auto） */
function composeSize(split, ratio, tier) {
  if (!split) return '';
  if (split.auto && ratio === split.auto) return split.auto;
  return ratio ? split.at(ratio, tier) : '';
}

function savePicks() {
  saveUiState({ picks: { single: { ...state.single.picks }, batch: { ...state.batch.picks } } });
}

/** 胶囊上怎么显示这个值 */
function displayPickValue(item, v) {
  if (!v) return '默认';
  if (/^auto$/i.test(String(v))) return '自动';
  return item.kind === 'pixel' ? String(v).replace(/[xX]/g, '×') : String(v);
}

/** 弹层里的说明：模型表里的 paramHints 优先，其次按角色兜底 */
function pickHint(item) {
  if (item.fallback) return '当前模型不在内置参数表里，按平台通用档位给你选。';
  // 像素枚举拆出来的两颗胶囊：共用文档里的同一个 size 字段
  if (item.composed) {
    return item.role === 'ratio'
      ? '文档把比例和清晰度合并在 size 一个字段里。这里按比例挑，最终发出去的是「比例 × 分辨率」对应的那个像素尺寸，原样提交不做换算。'
      : '清晰度档。和比例一起合成文档 size 列表里的像素尺寸——文档不接受只传「1K」「2K」这种档位（会报 400）。';
  }
  const hints = currentModelEntry().paramHints || {};
  if (hints[item.param.name]) return hints[item.param.name];
  if (item.role === 'tier') return '留「默认」= 不传这个字段，由上游决定。';
  if (item.role === 'res') return '清晰度越高越慢、越贵。';
  return '';
}

/**
 * 这个协议能不能把画质档发出去（与 server.js 的 qualityFieldFor 保持一致）：
 *   media  → 直接进 params        openai → 只认顶层 quality
 *   gemini → 只认 thinkingConfig.thinkingLevel    alapi → 没有这个字段
 */
function qualityFieldOf(proto, paramName) {
  if (!paramName) return '';
  if (proto === 'openai') return paramName === 'quality' ? 'quality' : '';
  if (proto === 'gemini') return paramName === 'thinkingLevel' ? 'generationConfig.thinkingConfig.thinkingLevel' : '';
  if (proto === 'alapi' || proto === 'alapi_async') return '';
  return paramName;
}

/** 当前选中的比例（tt-image-2 那种拆出来的也算，共用 size 字段） */
function pickedRatio() {
  const plan = pillPlan();
  const picks = picksOf(state.mode === 'batch');
  if (plan.ratio) return picks.ratio || '';
  if (plan.size && plan.size.kind === 'ratio') return picks.size || '';
  return '';
}

/** 当前比例下，这一档文档里到底有没有（只有带比例白名单的模型会拦：ALAPI 的 4k） */
function resBlocked(v) {
  const t = resTable();
  const ratio = pickedRatio();
  if (!t || !t.ratios || !ratio || !v) return false;
  const allow = t.ratios[ratio];
  // 比例本身不在文档的白名单里（比如「自动」）→ 不硬判，交给上游
  if (!allow) return false;
  return allow.indexOf(v) < 0;
}

/** 分辨率那一档在弹层里怎么显示：带上这个比例下的真实像素（换行两段，靠 CSS 断行） */
function resChoiceLabel(v) {
  const px = resPixelOf(pickedRatio(), v);
  return px ? `${v}\n${String(px).replace(/[xX]/g, '×')}` : v;
}

/**
 * 分辨率胶囊底部那句话：①这一档在当前比例下是多少像素（按模型自己的文档）
 * ②哪些档位这个比例没有 ③出不了会怎么退（ALAPI：4k → 2k → 1k）
 */
function resNote() {
  const plan = pillPlan();
  const t = resTable();
  if (!plan.res || !t) return '';
  const picks = picksOf(state.mode === 'batch');
  const ratio = pickedRatio();
  const cur = picks.res || '';
  const out = [];
  const px = resPixelOf(ratio, cur);
  if (px) out.push(`文档里 ${ratio} 的 ${cur} 是 ${String(px).replace(/[xX]/g, '×')}。`);
  if (t.ratios && ratio) {
    const allow = t.ratios[ratio];
    if (allow) {
      const miss = t.tiers.filter((x) => allow.indexOf(x) < 0);
      if (miss.length) out.push(`这个比例文档里没有 ${miss.join(' / ')}（选了会自动往下退）。`);
    }
  }
  if (t.fallback) out.push(`上游出不了这一档会自动退档重发：${t.tiers.slice().reverse().join(' → ')}。`);
  return out.join('');
}

/** 弹层底部那句话（会跟着批量选项、协议变化） */
function popNote(item, batch) {
  const parts = [pickHint(item)];
  if (item.role === 'ratio' && batch && $('#optFollowRatio') && $('#optFollowRatio').checked) {
    parts.push('批量里「比例跟随原图」开着，只有原图比例吸附不到时才用这里选的值。');
  }
  if (item.role === 'res') {
    const rn = resNote();
    if (rn) parts.push(rn);
  }
  if (item.role === 'tier' && batch) parts.push('批量里每一张都用这一档。');
  if (item.role === 'tier') {
    const proto = (state.config && state.config.protocol) || '';
    if (!qualityFieldOf(proto, item.param.name)) {
      const lbl = (protocolOf(proto) || {}).label || proto;
      parts.push(`当前协议「${lbl}」没有 ${item.param.name} 字段，选了也发不出去，想用得换成 media 协议。`);
    }
  }
  return parts.filter(Boolean).join('');
}

/** 形状小方块：统一缩到 20px 的方框里，短边不小于 6px */
function shapeBox(w, h) {
  const box = 20;
  const iw = w >= h ? box : Math.max(6, Math.round((box * w) / h));
  const ih = h >= w ? box : Math.max(6, Math.round((box * h) / w));
  return [iw, ih];
}

/** 值 → 形状方块的宽高；认不出来返回 null */
function valueBox(v) {
  const s = String(v).trim();
  if (RE_PIXEL_V.test(s)) {
    const [w, h] = s.split(/[x×]/i).map(Number);
    return shapeBox(w || 1, h || 1);
  }
  if (RE_RATIO_V.test(s)) {
    const [w, h] = s.split(':').map(Number);
    return shapeBox(w || 1, h || 1);
  }
  return null;
}

/** 带形状预览的网格（比例 / 像素尺寸共用） */
function buildShapeGrid(host, item, cur, onPick) {
  host.innerHTML = '';
  (item.param.values || []).map(String).forEach((v) => {
    const isAuto = v.toLowerCase() === 'auto';
    const label = isAuto ? '自动' : displayPickValue(item, v);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ratio' + (v === String(cur) ? ' is-active' : '');
    btn.dataset.value = v;
    btn.title = label;
    btn.innerHTML = '<i></i><span></span>';
    btn.querySelector('span').textContent = label;
    const i = btn.querySelector('i');
    const box = isAuto ? null : valueBox(v);
    if (box) {
      i.style.width = box[0] + 'px';
      i.style.height = box[1] + 'px';
    } else {
      i.hidden = true;
    }
    btn.addEventListener('click', () => onPick(v));
    host.appendChild(btn);
  });
}

/**
 * 分段条（分辨率 / 画质档这类短列表）；withDefault 时最前面多一个「默认」= 不传。
 * opts.disabled(v) 能让某一档在当前比例下置灰（ALAPI 的 4k 就靠这个），
 * opts.label(v) 换一个更长的显示文案（比如带上像素）。
 */
function buildSegChoices(host, item, cur, onPick, withDefault, opts) {
  host.innerHTML = '';
  const o = opts || {};
  const mk = (value, label, off, title) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = String(value) === String(cur) ? 'is-active' : '';
    btn.dataset.value = value;
    btn.textContent = label;
    if (title) btn.title = title;
    if (off) {
      btn.disabled = true;
      btn.classList.add('is-locked');
    } else {
      btn.addEventListener('click', () => onPick(value));
    }
    host.appendChild(btn);
  };
  if (withDefault) mk('', '默认');
  (item.param.values || []).map(String).forEach((v) => {
    mk(v, o.label ? o.label(v) : v, o.disabled ? !!o.disabled(v) : false, o.title ? o.title(v) : '');
  });
}

/** 选填的参数给一个「默认」（= 不传）；必填的（如 tt-image-2 的 size）不给 */
function needsDefault(item) {
  return !item.param.required;
}

function buildCountSeg(host, current, onPick) {
  host.innerHTML = '';
  state.counts.forEach((n) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = Number(n) === Number(current) ? 'is-active' : '';
    btn.textContent = n + ' 张';
    btn.addEventListener('click', () => {
      Array.from(host.children).forEach((c) => c.classList.remove('is-active'));
      btn.classList.add('is-active');
      onPick(Number(n));
    });
    host.appendChild(btn);
  });
}

/** 服务端用的那把键：来源|协议|模型（见 server.js 的 nativeNKey） */
function nKeyOf(cfg) {
  return `${cfg.provider || ''}|${cfg.protocol || ''}|${cfg.model || ''}`;
}

/** 选中一个档位：就地更新，不重建 DOM（重建会把刚点开的弹层关掉） */
function setPick(role, value) {
  const batch = state.mode === 'batch';
  const plan = pillPlan();
  picksOf(batch)[role] = value || '';
  // 换了比例 → 分辨率那一档可能不再合法（文档里「比例 × 清晰度」不是随便拼的，
  // ALAPI 的 4k 只活在六个比例上）：按新比例吸附一次，并把分辨率弹层就地重画
  if (role === 'ratio' || (role === 'size' && plan.size && plan.size.kind === 'ratio')) {
    normalizePicks(batch);
    refreshResChoices();
  }
  savePicks();
  syncPillValues();
  updateCountHint();
}

/** 比例变了：分辨率弹层里哪些档位还能选、这一档是多少像素，都跟着变，就地重画 */
function refreshResChoices() {
  const plan = pillPlan();
  const item = plan.res;
  const pop = $('#paramPops .pill-pop[data-role="res"]');
  if (!item || !pop) return;
  const batch = state.mode === 'batch';
  const seg = pop.querySelector('.seg');
  if (seg) {
    buildSegChoices(seg, item, picksOf(batch).res, (v) => setPick('res', v), needsDefault(item), {
      disabled: resBlocked,
      label: resChoiceLabel
    });
  }
  const note = pop.querySelector('.pop-note');
  if (note) note.textContent = popNote(item, batch);
}

/** 只刷新胶囊上的显示值与选中态 */
function syncPillValues() {
  const batch = state.mode === 'batch';
  const plan = pillPlan();
  const picks = picksOf(batch);
  for (const role of ['ratio', 'size', 'res', 'tier']) {
    const item = plan[role];
    if (!item) continue;
    const cur = picks[role] || '';
    const pill = $(`#pillsDyn .param-pill[data-role="${role}"]`);
    const b = pill && pill.querySelector('b');
    if (b) b.textContent = displayPickValue(item, cur);
    $$(`#paramPops .pill-pop[data-role="${role}"] [data-value]`).forEach((btn) => {
      btn.classList.toggle('is-active', (btn.dataset.value || '') === cur);
    });
  }
  updateParamNotes();
}

/** 刷新每个弹层底部的说明（批量选项 / 协议变了要跟着改口） */
function updateParamNotes() {
  const batch = state.mode === 'batch';
  const plan = pillPlan();
  for (const role of ['ratio', 'size', 'res', 'tier']) {
    const item = plan[role];
    if (!item) continue;
    const pop = $(`#paramPops .pill-pop[data-role="${role}"]`);
    if (!pop) continue;
    const note = pop.querySelector('.pop-note');
    if (note) note.textContent = popNote(item, batch);
    if (role === 'ratio') {
      const body = pop.querySelector('.pop-body');
      const dim = batch && $('#optFollowRatio') && $('#optFollowRatio').checked;
      if (body) body.style.opacity = dim ? '0.55' : '1';
    }
  }
}

/** 兼容旧调用点：批量「比例跟随原图」勾选变了就重算说明 */
function updateRatioNote() {
  updateParamNotes();
}

/** 按当前模型的参数表重建整条胶囊 + 弹层 */
function renderParamPills() {
  const host = $('#pillsDyn');
  const pops = $('#paramPops');
  if (!host || !pops) return;
  host.innerHTML = '';
  pops.innerHTML = '';

  const batch = state.mode === 'batch';
  const plan = pillPlan();
  const picks = picksOf(batch);

  for (const role of ['ratio', 'size', 'res', 'tier']) {
    const item = plan[role];
    if (!item) continue;
    const meta = role === 'tier' ? TIER_META[item.param.name] || ROLE_META.tier : ROLE_META[role];
    const cur = picks[role] || '';

    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'param-pill';
    pill.dataset.role = role;
    pill.title = `${meta.title} · ${item.param.name}`;
    const lab = document.createElement('span');
    lab.className = 'pill-label';
    lab.textContent = meta.label;
    const val = document.createElement('b');
    val.textContent = displayPickValue(item, cur);
    pill.append(lab, val);
    host.appendChild(pill);

    const pop = document.createElement('div');
    pop.className = 'pill-pop';
    pop.dataset.role = role;
    pop.hidden = true;
    // 动态生成的弹层不会被启动时那圈 stopPropagation 绑上，这里补一条，
    // 否则点弹层里的按钮会冒泡到 document，把弹层直接关掉
    pop.addEventListener('click', (e) => e.stopPropagation());

    const title = document.createElement('div');
    title.className = 'pop-title';
    // 标题只在看不清来源时才缀参数名：
    //   tier（画质/思考）—— 档位含义自明，不缀
    //   composed（像素枚举拆出的比例/分辨率）—— 两颗胶囊共用 size，缀了反而容易误读成两个字段，不缀
    //   其余（尺寸 / 独立 aspectRatio / 独立 imageSize）—— 保留参数名
    const bareTitle = item.role === 'tier' || item.composed;
    title.textContent = bareTitle ? meta.title : `${meta.title}（${item.param.name}）`;
    pop.appendChild(title);

    // 像素尺寸有 30 多项，限高滚动，别把弹层撑到屏幕外
    const body = document.createElement('div');
    body.className = 'pop-body' + (item.kind === 'pixel' ? ' pop-body-scroll' : '');
    pop.appendChild(body);

    const onPick = (v) => setPick(role, v);
    if (item.kind === 'seg') {
      const seg = document.createElement('div');
      seg.className = 'seg';
      body.appendChild(seg);
      // 分辨率那一颗要跟着比例走：ALAPI 的 4k 只有六个比例支持，别的比例上置灰
      const extra = role === 'res' ? { disabled: resBlocked, label: resChoiceLabel } : null;
      buildSegChoices(seg, item, cur, onPick, needsDefault(item), extra);
    } else {
      const grid = document.createElement('div');
      grid.className = 'ratio-grid compact' + (item.kind === 'pixel' ? ' px-grid' : '');
      body.appendChild(grid);
      buildShapeGrid(grid, item, cur, onPick);
    }

    if (role === 'ratio') {
      const dim = batch && $('#optFollowRatio') && $('#optFollowRatio').checked;
      body.style.opacity = dim ? '0.55' : '1';
    }
    pops.appendChild(pop);

    pill.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = pop.hidden;
      closePillPops();
      closeAllModelMenus();
      if (!willOpen) return;
      pop.hidden = false;
      pill.classList.add('is-open');
    });
  }
}

/**
 * 把当前模型的胶囊选择翻成发给服务端的参数。
 *   aspectRatio / imageSize —— 语义入参，服务端按模型把值映射到对应的字段名
 *   size —— 文档原值入参：模型表里有 size 参数时才有值，服务端命中枚举就原样下发
 *   quality —— 画质档（banana-2 上是 thinkingLevel），服务端按协议落到对应字段
 * 空串一律表示「不传，交给上游」，不做本地补值。
 */
function paramPayload(batch) {
  const plan = pillPlan();
  const picks = picksOf(batch);
  const out = { aspectRatio: '', imageSize: '', size: '', quality: '' };
  if (plan.ratio) out.aspectRatio = picks.ratio || '';
  if (plan.size) {
    out.size = picks.size || '';
    // size 里装的是比例（ALAPI 这种）时，它同时就是比例的角色
    if (plan.size.kind === 'ratio' && !out.aspectRatio) out.aspectRatio = out.size;
  }
  if (plan.res) out.imageSize = picks.res || '';
  if (plan.tier) out.quality = picks.tier || '';
  // size 是像素枚举的模型（tt-image-2）：比例 + 分辨率在这里合成回文档要求的分辨率写法。
  // 这个模型没有独立的 aspectRatio 字段，别把胶囊上的标签当参数发出去；分辨率留着 ——
  // 批量「比例跟随原图」时服务端要拿它做吸附的基准。
  if (plan.composed) {
    out.size = composeSize(plan.composed, picks.ratio, picks.res);
    out.aspectRatio = '';
  }
  return out;
}

/** 记录卡片上「比例 / 分辨率」两格显示什么 */
function recordParamsOf(batch) {
  const plan = pillPlan();
  const picks = picksOf(batch);
  const ratio = plan.ratio ? picks.ratio || '' : plan.size ? picks.size || '' : '';
  const size = plan.res ? picks.res || '' : '';
  return { ratio, size };
}

/** 回填旧记录时，把记录里的比例 / 分辨率对回当前模型的胶囊 */
function applyPickFromRecord(rec) {
  const plan = pillPlan();
  const picks = picksOf(false);
  const inEnum = (item, v) => !!item && !!v && item.param.values.some((x) => String(x) === String(v));
  if (inEnum(plan.ratio, rec.ratio)) picks.ratio = String(rec.ratio);
  else if (inEnum(plan.size, rec.ratio)) picks.size = String(rec.ratio);
  if (inEnum(plan.res, rec.size)) picks.res = String(rec.size);
  // size 是像素枚举的模型（tt-image-2）：老记录里存的是「像素尺寸」单胶囊的格式，
  // 按文档反解成「比例 + 分辨率」再回填
  if (plan.composed && !inEnum(plan.ratio, rec.ratio)) {
    const hit = plan.composed.fromPixel(rec.ratio) || plan.composed.fromPixel(rec.size);
    if (hit) {
      picks.ratio = hit.ratio;
      picks.res = hit.tier;
    }
  }
}

/** 生图数量怎么实现，取决于协议支持不支持原生 n —— 讲清楚，别让人以为是免费叠加 */
function updateCountHint() {
  const el = $('#countHint');
  if (!el) return;
  // 批量模式下第三颗胶囊是并发数，跟「出几张」不是一回事
  if (state.mode === 'batch') {
    el.textContent = '建议 2~5';
    return;
  }
  const cfg = state.config || {};
  const proto = protocolOf(cfg.protocol);
  const n = state.single.count;
  if (n <= 1) {
    el.textContent = '';
    return;
  }
  // 协议写着支持 n，但这个渠道实测只收 n=1：服务端已自动改成并发发，提示得跟上
  if (proto && proto.nativeN && !state.nativeNBlocked.has(nKeyOf(cfg))) {
    el.textContent = `一次请求出 ${n} 张`;
  } else {
    el.textContent = `并发 ${n} 次请求，按 ${n} 次计费`;
  }
}

/**
 * 服务端这一轮降级了（上游只收 n=1）→ 记住这个组合，输入框旁的提示立刻改口，
 * 不用等刷新页面。key 由服务端给回来，免得两边各拼一套拼错。
 */
function markNativeNFallback(debug) {
  if (!debug || !debug.nativeNFallback || !debug.nativeNKey) return;
  if (state.nativeNBlocked.has(debug.nativeNKey)) return;
  state.nativeNBlocked.add(debug.nativeNKey);
  updateCountHint();
}

/* ------------------------------------------------------------ 模式：生图 / 批量修图
 * 整套界面只有一个入口：丢图片 = 生图，丢文件夹 = 批量修图。
 * 左边栏那对按钮只是给「不想拖拽、想手动切」的人用的，不是必须。
 */

function baseName(p) {
  return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() || '';
}

function activePromptEl() {
  return state.mode === 'batch' ? $('#batchPrompt') : $('#singlePrompt');
}

/** 把界面按当前模式拉齐：文本框、胶囊、按钮文案、提示语 */
function syncComposer() {
  const batch = state.mode === 'batch';
  $('#composer').dataset.mode = state.mode;
  $$('#modeSwitch button').forEach((b) => b.classList.toggle('is-active', b.dataset.mode === state.mode));
  $('#singlePrompt').hidden = batch;
  $('#batchPrompt').hidden = !batch;

  // 参数胶囊：数量之前那几颗由当前模型的参数表生成（比例/尺寸、分辨率、画质…）
  const show = (sel, on) => {
    const el = $(sel);
    if (el) el.hidden = !on;
  };
  show('#countSegSingle', !batch);
  show('#countBatchWrap', batch);
  show('#pillOptions', batch);
  $('#countPopTitle').textContent = batch ? '并发数' : '生图数量';
  $('#pillCountLabel').textContent = batch ? '并发' : '数量';
  $('#valCount').textContent = batch ? `${Number($('#batchConcurrency').value) || 3} 张` : `${state.single.count} 张`;
  $('#btnSend').title = batch ? '开始批量修图' : '生成';
  renderParamPills();
  renderRefs();
  updateCountHint();
}

function setMode(mode) {
  if (mode !== 'batch') mode = 'single';
  if (state.mode === mode) return syncComposer();
  state.mode = mode;
  saveUiState({ mode });
  syncComposer();
  closePillPops();
  setTimeout(() => activePromptEl().focus(), 0);
}

$$('#modeSwitch button').forEach((b) => {
  b.addEventListener('click', () => setMode(b.dataset.mode));
});

/* ------------------------------------------------------------ 输入框上的参数弹层 */

// 固定（非模型参数）的那几颗胶囊。模型参数胶囊自己处理点击，见 renderParamPills()
const PILL_POPS = [
  { pill: '#pillCount', pop: '#popCount' },
  { pill: '#pillOptions', pop: '#popOptions' },
  { pill: '#btnPresets', pop: '#popPresets' }
];

/** 关掉所有参数弹层（含按模型动态生成的那些） */
function closePillPops() {
  $$('.pill-pop').forEach((pop) => {
    pop.hidden = true;
  });
  $$('.param-pill').forEach((p) => p.classList.remove('is-open'));
}

function togglePillPop(pillSel) {
  const item = PILL_POPS.find((p) => p.pill === pillSel);
  if (!item) return;
  const pop = $(item.pop);
  const willOpen = pop.hidden;
  closePillPops();
  closeAllModelMenus();
  if (!willOpen) return;
  pop.hidden = false;
  $(item.pill).classList.add('is-open');
}

PILL_POPS.forEach((p) => {
  const pill = $(p.pill);
  if (!pill) return;
  pill.addEventListener('click', (e) => {
    e.stopPropagation();
    togglePillPop(p.pill);
  });
});
$$('.pill-pop').forEach((pop) => pop.addEventListener('click', (e) => e.stopPropagation()));
document.addEventListener('click', closePillPops);

/* ------------------------------------------------------------ 预设提示词 */

// 预设文案在 prompt-presets.js（纯内容，可单测）
const PROMPT_PRESETS = PromptPresets.PRESETS;

function setPrompt(v) {
  const ta = activePromptEl();
  ta.value = v;
  ta.dispatchEvent(new Event('input'));
  autoGrow(ta);
  closePillPops();
  ta.focus();
  toast('已套用预设，可按需微调');
}

$$('#popPresets .chip').forEach((chip) => {
  const key = chip.dataset.preset;
  chip.title = (PROMPT_PRESETS[key] || '').slice(0, 120) + '…';
  chip.addEventListener('click', () => setPrompt(PROMPT_PRESETS[key] || ''));
});


$('#optFollowRatio').addEventListener('change', updateRatioNote);
$('#batchConcurrency').addEventListener('input', syncComposer);
$('#batchConcurrency').addEventListener('change', syncComposer);

/* ------------------------------------------------------------ 单张：参考图 */

const FOLDER_ICON =
  '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>';

/** 缩略图右下角那颗「涂鸦」图标 */
const DAUB_ICON =
  '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z"/></svg>';

/**
 * 输入框上方那块「这一轮要处理什么」：
 *   生图 → 参考图缩略图：点图看大图，左上角 ✕ 移除，右下角 ✎ 涂鸦（改完顶掉这张）
 *   批量 → 一个文件夹贴片（文件夹图标 + 名字 + 张数）：点它用资源管理器打开，左上角 ✕ 移除
 */
function renderRefs() {
  const host = $('#thumbList');
  host.hidden = false;
  host.innerHTML = '';
  if (state.mode === 'batch') {
    const chip = buildFolderChip();
    if (chip) host.appendChild(chip);
    return;
  }
  state.single.refs.forEach((ref, idx) => {
    const d = document.createElement('div');
    d.className = 'thumb';
    d.title = (ref.name || '') + '（点图看大图，右下角涂鸦）';

    const img = document.createElement('img');
    img.src = ref.url;
    img.alt = ref.name || '参考图';
    img.addEventListener('click', () => openViewer(state.single.refs.map((r) => r.url), idx));
    d.appendChild(img);

    const rm = document.createElement('button');
    rm.className = 'rm';
    rm.type = 'button';
    rm.textContent = '✕';
    rm.title = '移除这张参考图';
    rm.addEventListener('click', () => {
      state.single.refs.splice(idx, 1);
      renderRefs();
    });
    d.appendChild(rm);

    const daub = document.createElement('button');
    daub.className = 'daub';
    daub.type = 'button';
    daub.innerHTML = DAUB_ICON;
    daub.title = '涂鸦标注（改完顶掉这张参考图）';
    daub.addEventListener('click', () =>
      openDoodle(ref.url, (dataUrl) => replaceRefWithDataUrl(idx, dataUrl))
    );
    d.appendChild(daub);

    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = `${idx + 1}. ${ref.name.slice(0, 12)}`;
    d.appendChild(tag);
    host.appendChild(d);
  });
  // 参考图上限不再常驻显示：填多了会提示，模型不支持时 addFiles 会拦下来
}

/** 涂鸦改完的结果就地顶掉原来那张参考图（而不是又加一张） */
function replaceRefWithDataUrl(idx, dataUrl) {
  const m = String(dataUrl).match(/^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is);
  if (!m) return toast('这张图读不出来', 'err');
  const ref = state.single.refs[idx];
  if (!ref) return;
  ref.mime = m[1];
  ref.base64 = m[2];
  ref.url = dataUrl;
  renderRefs();
  toast('已更新这张参考图');
}

/** 批量模式下贴在输入框上的文件夹 */
function buildFolderChip() {
  const dir = state.batch.dir || $('#batchInput').value.trim();
  if (!dir) return null;
  const chip = document.createElement('div');
  chip.className = 'folder-chip';
  chip.title = `${dir}\n点击用资源管理器打开`;
  chip.tabIndex = 0;
  chip.setAttribute('role', 'button');
  chip.addEventListener('click', (e) => {
    if (e.target.closest('.fc-rm')) return; // ✕ 是移除，不要顺带把文件夹打开
    revealPath(dir);
  });
  chip.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    revealPath(dir);
  });

  const ic = document.createElement('span');
  ic.className = 'fc-ic';
  ic.innerHTML = FOLDER_ICON;
  chip.appendChild(ic);

  const name = document.createElement('span');
  name.className = 'fc-name';
  name.textContent = baseName(dir) || dir;
  chip.appendChild(name);

  if (state.batch.count) {
    const n = document.createElement('span');
    n.className = 'fc-meta';
    n.textContent = `${state.batch.count} 张`;
    chip.appendChild(n);
  }

  const rm = document.createElement('button');
  rm.className = 'fc-rm';
  rm.type = 'button';
  rm.textContent = '✕';
  rm.title = '移除这个文件夹';
  rm.addEventListener('click', clearBatchFolder);
  chip.appendChild(rm);
  return chip;
}

/** 移除文件夹贴片：清掉本轮素材并退回生图（批量没有文件夹就没意义了） */
function clearBatchFolder() {
  state.batch.dir = '';
  state.batch.count = 0;
  $('#batchInput').value = '';
  $('#scanInfo').textContent = '';
  renderScanGrid([]);
  // 用户主动摘掉的文件夹就别留线索了（lastInputDir 一起清）
  saveUiState({ inputDir: '', lastInputDir: '' });
  if (state.mode === 'batch') setMode('single');
  else syncComposer();
  toast('已移除文件夹');
}

/** 模型不在内置表里时的参考图上限：没有已知上限，用一个保守的默认值挡住误操作 */
const DEFAULT_REF_LIMIT = 8;

/** 当前模型允许的参考图张数 */
function refLimit() {
  const cfg = state.config || {};
  const m = modelInfo(cfg.model || '', cfg.provider);
  return m ? Number(m.maxRefs) || 0 : DEFAULT_REF_LIMIT;
}

/**
 * 参考图体积上限。上游平台的限制是「单文件 ≤10MB、单次合计 ≤30MB」，
 * 之前前端只笼统卡 30MB/张，用户按 14 张传会直接撞到服务端的请求体上限，
 * 拿到的是一句和真实规则无关的报错。
 * 服务端的单张素材上限也按 10MB 对齐（MAX_LOCAL_IMAGE），两边别再各说各话。
 */
const MAX_REF_BYTES = 10 * 1024 * 1024;
const MAX_REF_TOTAL_BYTES = 30 * 1024 * 1024;

/** 超过这个最长边就等比缩下来（跟 000.html 一致）。再大模型也用不上，只会拖慢上传。 */
const REF_MAX_SIDE = 4096;

function fileToDataUrl(f) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(f);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('这张图解不开'));
    img.src = src;
  });
}

/** base64 体积（含 data URL 前缀的估算） */
function dataUrlBytes(dataUrl) {
  const i = String(dataUrl).indexOf(',');
  const b64 = i >= 0 ? dataUrl.slice(i + 1) : String(dataUrl);
  return Math.round((b64.length * 3) / 4);
}

/** 等比缩放 + 重编码成 JPEG。JPEG 没有透明通道，先铺白底（跟 000.html 一样）。 */
function reencodeImage(img, maxSide, quality) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(w * scale));
  cv.height = Math.max(1, Math.round(h * scale));
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.drawImage(img, 0, 0, cv.width, cv.height);
  return cv.toDataURL('image/jpeg', quality);
}

/**
 * 把用户给的图收拾成「能传上去」的参考图。
 * 旧版只做校验：超过 10MB 直接拒收 —— 手机拍的照片基本都在 12MB 以上，
 * 等于这个功能对它们完全不可用。现在改成先压缩再传（照 000.html 的做法）：
 *   1) 解码失败（浏览器不认的格式）就原样返回，交给后端去报错；
 *   2) 边长超 4096 或体积超 10MB 才重编码，其余原样走，不无谓地损失画质；
 *   3) 一次不行就逐级降质量 / 再缩边长，直到确实塞得进单张上限。
 */
async function prepareRefImage(f) {
  const dataUrl = await fileToDataUrl(f);
  let img = null;
  try {
    img = await loadImage(dataUrl);
  } catch {
    img = null; // 浏览器不认的格式：原样交给后端去报错，比在这里瞎猜好
  }
  const overSide = img ? Math.max(img.naturalWidth, img.naturalHeight) > REF_MAX_SIDE : false;
  const oversized = f.size > MAX_REF_BYTES;
  // 原样可用就别动它，避免无意义地掉画质
  if (!img || (!overSide && !oversized)) return { url: dataUrl, name: f.name, bytes: f.size, note: '' };

  let out = '';
  let side = REF_MAX_SIDE;
  for (const q of [0.9, 0.8, 0.7]) {
    out = reencodeImage(img, side, q);
    if (dataUrlBytes(out) <= MAX_REF_BYTES) break;
    side = Math.min(side, 3072);
  }
  if (dataUrlBytes(out) > MAX_REF_BYTES) return null; // 压不下来就放弃这张
  return {
    url: out,
    name: f.name,
    bytes: dataUrlBytes(out),
    note: `${f.name} 太大，已压缩 ${fmtBytes(f.size)} → ${fmtBytes(dataUrlBytes(out))}`
  };
}

async function addFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|gif|bmp|avif|tiff?)$/i.test(f.name));
  if (!files.length) return toast('请选择图片文件', 'err');
  // 上限跟随当前模型的 images 参数（banana 系 14 张，多数模型 10 张左右）
  const lim = refLimit();
  if (!lim) return toast('当前模型不支持参考图，只能文生图', 'err');
  const room = lim - state.single.refs.length;
  if (room <= 0) return toast(`当前模型最多 ${lim} 张参考图`, 'err');

  // 已占用的体积按 base64 长度反推
  let total = state.single.refs.reduce((s, r) => s + Math.round((r.base64.length * 3) / 4), 0);

  const notes = [];
  for (const f of files.slice(0, room)) {
    let prepared;
    try {
      prepared = await prepareRefImage(f);
    } catch (e) {
      toast(`${f.name} 处理失败：${e.message}`, 'err');
      continue;
    }
    if (!prepared) {
      toast(`${f.name} 压到 ${MAX_REF_BYTES / 1048576}MB 以内仍然太大，已跳过`, 'err');
      continue;
    }
    if (total + prepared.bytes > MAX_REF_TOTAL_BYTES) {
      toast(`参考图合计不能超过 ${MAX_REF_TOTAL_BYTES / 1048576}MB，后面的已跳过`, 'err');
      break;
    }
    const m = String(prepared.url).match(/^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is);
    if (!m) continue;
    total += prepared.bytes;
    if (prepared.note) notes.push(prepared.note);
    state.single.refs.push({ name: prepared.name, mime: m[1], base64: m[2], url: prepared.url });
  }
  if (files.length > room) toast(`最多 ${lim} 张，多余的已忽略`, 'err');
  if (notes.length) toast(notes.join('；'), 'ok');
  renderRefs();
}

/* 输入框：h 变化时自动长高（最多到 CSS 里的 max-height，再长就内部滚动） */
function autoGrow(ta) {
  if (!ta) return;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
}

$('#fileInput').addEventListener('change', (e) => {
  // 主动选文件 = 生图（要批量就拖文件夹进来）
  if (state.mode !== 'single') setMode('single');
  addFiles(e.target.files);
  e.target.value = '';
});

$('#btnReloadPage').addEventListener('click', () => location.reload());

function debounce(fn, ms) {
  let t = null;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

['#singlePrompt', '#batchPrompt'].forEach((sel) => {
  const ta = $(sel);
  ta.addEventListener('input', () => {
    autoGrow(ta);
    savePromptMemory();
  });
});

function savePromptMemory() {
  saveUiState({ singlePrompt: $('#singlePrompt').value, batchPrompt: $('#batchPrompt').value });
}

/* ------------------------------------------------------------ 拖进聊天框：分流
 * 浏览器拖文件夹只能读到目录名，拿不到绝对路径，所以交给服务端按名字就近反查。
 */

/**
 * 从一次 drop 里取出「拖了什么」。
 *
 * ⚠ 必须全程同步，一个 await 都不能有：
 * DataTransfer 的数据在 drop 事件处理返回后就进入保护模式，之后再读 items / files 全是空的。
 * 之前是先 await 目录句柄、再读 dt.files —— 拖文件夹没事（名字早就拿到了），
 * 拖图片则永远读成空数组，表现就是「没识别到内容」。这个顺序是硬要求。
 */
function isImageFile(f) {
  return /^image\//.test(f.type || '') || /\.(jpe?g|png|webp|gif|bmp|avif|tiff?)$/i.test(f.name || '');
}

function readDrop(dt) {
  const items = Array.from((dt && dt.items) || []);
  const files = Array.from((dt && dt.files) || []);
  let dirName = '';
  let parentName = '';
  for (const it of items) {
    if (it.kind !== 'file') continue;
    // 快照式同步调用：webkitGetAsEntry 之后再异步读就没数据了
    const ent = it.webkitGetAsEntry ? it.webkitGetAsEntry() : null;
    if (!ent) continue;
    if (ent.isDirectory) {
      dirName = ent.name;
      break;
    }
    if (ent.isFile && !parentName) {
      // 有的浏览器会把「文件夹里的文件」报成 /文件夹/文件.png
      const parts = String(ent.fullPath || '').split('/').filter(Boolean);
      if (parts.length > 1) parentName = parts[0];
    }
  }
  return { items, files, images: files.filter(isImageFile), dirName, parentName };
}

/** 兜底：entry 拿不到时（Safari 等）才用的异步目录句柄探测，只能放在同步读取之后 */
async function folderNameOf(items) {
  for (const it of items) {
    if (it.kind !== 'file') continue;
    if (typeof it.getAsFileSystemHandle !== 'function') continue;
    try {
      const h = await it.getAsFileSystemHandle();
      if (h && h.kind === 'directory') return h.name;
    } catch {
      /* ignore */
    }
  }
  return '';
}

/** 拖进来 / 手填的文件夹名 → 绝对路径 → 扫描 */
async function useFolderName(name) {
  if (!name) {
    toast('没能读到文件夹名，直接在 ⚙ 批量选项里填完整路径也可以', 'err');
    return;
  }
  const hints = [$('#batchInput').value.trim(), lastInputDirHint()].filter(Boolean);
  toast(`正在定位「${name}」…`);
  let r;
  try {
    r = await api('/api/find-dir', { name, hints });
  } catch (e) {
    return toast(e.message, 'err');
  }
  if (!r.ok || !r.dirs.length) {
    toast(`没能自动定位「${name}」，请在系统窗口里选一次这个文件夹`, 'err');
    await pickFolderNative(lastInputDirHint());
    return;
  }
  $('#batchInput').value = r.dirs[0];
  saveUiState({ lastInputDir: r.dirs[0] });
  if (r.dirs.length > 1) {
    toast(`找到 ${r.dirs.length} 个同名文件夹，先用「${r.dirs[0]}」，不对的话在 ⚙ 里改`, 'err');
  }
  await scanBatchDir();
}

async function scanBatchDir() {
  const dir = $('#batchInput').value.trim();
  if (!dir) return toast('先给一个输入文件夹', 'err');
  try {
    const r = await api('/api/scan', {
      dir,
      recursive: $('#optRecursive').checked,
      includeExtra: $('#optExtra').checked,
      exclude: []
    });
    if (!r.ok) {
      state.batch.dir = '';
      state.batch.count = 0;
      syncComposer();
      return toast(r.error, 'err');
    }
    state.batch.dir = dir;
    state.batch.count = r.total || 0;
    renderScanGrid(r.files);
    $('#scanInfo').textContent = `找到 ${r.total} 张图片，共 ${fmtBytes(r.totalBytes)}`;
    syncComposer();
    if (!r.total) toast('这个文件夹里没有可处理的图片', 'err');
  } catch (e) {
    toast(e.message, 'err');
  }
}

async function handleComposerDrop(drop) {
  // 图片优先：拖进来的是图片就走生图（哪怕它来自某个文件夹里）
  if (drop.images.length) {
    setMode('single');
    await addFiles(drop.images);
    return;
  }
  // 文件夹走批量；浏览器只给得出目录名，绝对路径交给服务端反查
  const dirName = drop.dirName || drop.parentName || (await folderNameOf(drop.items));
  if (dirName) {
    setMode('batch');
    await useFolderName(dirName);
    return;
  }
  if (drop.files.length) {
    setMode('single');
    await addFiles(drop.files);
    return;
  }
  toast('没识别到内容：拖图片 = 生图，拖文件夹 = 批量修图', 'err');
}

(function initComposerDrop() {
  const composer = $('#composer');
  ['dragenter', 'dragover'].forEach((ev) =>
    composer.addEventListener(ev, (e) => {
      e.preventDefault();
      composer.classList.add('is-drop');
    })
  );
  ['dragleave', 'dragend'].forEach((ev) =>
    composer.addEventListener(ev, (e) => {
      if (ev === 'dragleave' && composer.contains(e.relatedTarget)) return;
      composer.classList.remove('is-drop');
    })
  );
  composer.addEventListener('drop', (e) => {
    e.preventDefault();
    composer.classList.remove('is-drop');
    // 同步抓数据再往下走：这里一旦先 await，DataTransfer 就失效了（图片会读成空）
    const drop = readDrop(e.dataTransfer);
    handleComposerDrop(drop);
  });
  // 拖到页面别处时别让浏览器把图片当成「打开新页面」
  ['dragover', 'drop'].forEach((ev) =>
    window.addEventListener(ev, (e) => {
      if (!composer.contains(e.target)) e.preventDefault();
    })
  );
})();

/* ------------------------------------------- 「+」：选图片还是选文件夹 */

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

function toggleAddMenu(open) {
  const menu = $('#addMenu');
  const btn = $('#btnAdd');
  if (!menu || !btn) return;
  const willOpen = open === undefined ? menu.hidden : !!open;
  menu.hidden = !willOpen;
  btn.setAttribute('aria-expanded', String(willOpen));
  if (willOpen) closePillPops();
}

/**
 * 系统原生「选择文件夹」框。
 * 浏览器自带的选目录控件（showDirectoryPicker / webkitdirectory）拿不到真实路径，
 * 而批量跑图需要的是绝对路径 —— 所以这一步交给本机的桌面助手弹 WinForms 对话框。
 *
 * 系统框弹出来之前有一段空白（助手没热时要先起 PowerShell），所以这里刻意给
 * 即时反馈 + 防重复点击，别让人以为点坏了。
 */
let pickFolderBusy = false;

/** 提前把桌面助手叫醒：冷启动的 1.4s 花在悬停时，而不是点击之后 */
function warmDesktop() {
  api('/api/desktop/warm', {}).catch(() => {});
}

async function pickFolderNative(initial) {
  if (pickFolderBusy) return '';
  pickFolderBusy = true;
  const btn = $('#btnAdd');
  if (btn) {
    btn.disabled = true;
    btn.classList.add('is-busy');
  }
  toast('正在打开系统窗口…');
  try {
    const r = await withTimeout(api('/api/pick-folder', { initial: String(initial || $('#batchInput').value.trim() || lastInputDirHint()) }), 180000);
    if (!r.ok || !r.path) {
      if (r.error) toast(r.error, 'err');
      return '';
    }
    $('#batchInput').value = r.path;
    saveUiState({ lastInputDir: r.path });
    setMode('batch');
    await scanBatchDir();
    return r.path;
  } catch (e) {
    toast(e.message === 'timeout' ? '系统对话框长时间没有响应，已取消' : e.message, 'err');
    return '';
  } finally {
    pickFolderBusy = false;
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('is-busy');
    }
  }
}

(function initAddMenu() {
  const btn = $('#btnAdd');
  const menu = $('#addMenu');
  if (!btn || !menu) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAddMenu();
  });
  // 鼠标一挪上去就预热：等真点下去的时候 PowerShell 已经装配好了
  btn.addEventListener('pointerenter', warmDesktop);
  menu.addEventListener('click', async (e) => {
    e.stopPropagation();
    const item = e.target.closest('button[data-act]');
    if (!item) return;
    toggleAddMenu(false);
    if (item.dataset.act === 'images') $('#fileInput').click();
    else await pickFolderNative();
  });
  document.addEventListener('click', () => toggleAddMenu(false));
})();

/* ------------------------------------------------------------ 生图记录 */

/** canvas 缩略图：记录里只存小图，不把几 MB 的原图反复写盘 */
function makeThumb(dataUrl, side) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.width;
        const h = img.height;
        if (!w || !h) return resolve('');
        const scale = Math.min(1, side / Math.max(w, h));
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(w * scale));
        cv.height = Math.max(1, Math.round(h * scale));
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, cv.width, cv.height);
        ctx.drawImage(img, 0, 0, cv.width, cv.height);
        resolve(cv.toDataURL('image/jpeg', 0.72));
      } catch {
        resolve('');
      }
    };
    img.onerror = () => resolve('');
    img.src = dataUrl;
  });
}

/** 把某个 URL 的图变成参考图（记录里的「继续改」用它） */
async function urlToDataUrl(url) {
  const res = await fetch(url);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

function noticeEl(kind, text) {
  const el = document.createElement('div');
  el.className = 'notice ' + kind;
  el.textContent = text;
  return el;
}

/** 记录里存的是原值（回填要用），展示时把 auto 说成人话 */
function recLabel(v) {
  return /^auto$/i.test(String(v)) ? '自动' : v;
}

function recMetaLine(r) {
  const bits = [];
  if (r.providerLabel) bits.push(r.providerLabel);
  if (r.protocolLabel) bits.push(r.protocolLabel);
  if (r.ratio) bits.push(recLabel(r.ratio));
  if (r.size) bits.push(recLabel(r.size));
  if (r.count) bits.push(r.count + ' 张');
  if (r.ms) bits.push(fmtMs(r.ms));
  return bits.join(' · ');
}

function recTime(ts) {
  const d = new Date(ts || Date.now());
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function loadRecords() {
  try {
    const r = await api('/api/records');
    state.records = r.ok ? r.records || [] : [];
  } catch {
    state.records = [];
  }
  renderRecords();
}

/* ------------------- 生成中：即时状态占位 -------------------
 * 点「开始生成」后先在这一列挂一条「生成中…」记录（带已用时间），
 * 出图或失败后再由真实记录顶替 —— 以前这一列在几十秒里毫无反应。
 */
let pendingTicker = null;

function pendingElapsedText(p) {
  const s = Math.max(0, Math.round((Date.now() - p.createdAt) / 1000));
  return s < 60 ? s + ' 秒' : Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
}

function stopPendingTicker() {
  if (!pendingTicker) return;
  clearInterval(pendingTicker);
  pendingTicker = null;
}

function startPendingTicker() {
  if (pendingTicker) return;
  // 只改文字，不重建卡片：重建会把缩略图重新下一遍
  pendingTicker = setInterval(() => {
    if (!state.pendingRecords.length) return stopPendingTicker();
    state.pendingRecords.forEach((p) => {
      const el = document.querySelector(`.msg[data-pend="${p.id}"] [data-pend-elapsed]`);
      if (el) el.textContent = pendingElapsedText(p);
    });
  }, 1000);
}

function addPendingRecord(rec) {
  state.pendingRecords.unshift(rec);
  renderRecords();
  startPendingTicker();
}

/**
 * 占位退场。
 * 生成期间用户可能已经切到别的对话了，这时不能整条消息流重画 ——
 * 只刷新左边栏（对话列表里的计数要减掉），把当前正看着的那屏留着。
 */
function dropPendingRecord(id) {
  const i = state.pendingRecords.findIndex((p) => p.id === id);
  if (i < 0) return;
  const [gone] = state.pendingRecords.splice(i, 1);
  if (convIdOf(gone) === state.convId) renderRecords();
  else renderConversations();
  if (!state.pendingRecords.length) stopPendingTicker();
}

/* ------------------- 聊天流：一条消息 = 一个气泡 -------------------
 * 生图一轮 = 用户气泡（提示词 + 参考图） + AI 气泡（结果图网格）
 * 批量一轮 = 一条可展开的任务气泡（见下面「批量：任务气泡」）
 */

function msgShell(kind, extra) {
  const el = document.createElement('div');
  el.className = 'msg ' + kind + (extra ? ' ' + extra : '');
  return el;
}

function refsBlock(refs) {
  const box = document.createElement('div');
  box.className = 'rec-refs';
  (refs || []).forEach((rf) => {
    if (!rf.thumb) return;
    const src = /^data:|^https?:|^blob:/.test(rf.thumb) ? rf.thumb : imgUrl(rf.thumb);
    // 缩略图只有 160px，放大看是糊的；记录里另存了 ref-i.src（最长边 1536）那份复用副本，
    // 有就用它当大图，没有（生成中占位、老记录）才退回缩略图
    const full = rf.src && !/^data:/.test(rf.src) ? imgUrl(rf.src) : src;
    const fig = document.createElement('figure');
    const img = document.createElement('img');
    img.loading = 'lazy';
    onImgError(img, '读不到');
    img.src = src;
    img.dataset.full = full;
    img.title = rf.name || '';
    img.addEventListener('click', () => openViewerInConv(full));
    fig.appendChild(img);
    box.appendChild(fig);
  });
  return box.firstChild ? box : null;
}

/** 用户气泡（右对齐）：参考图 + 提示词 + 时间 */
function buildUserBubble(info) {
  const wrap = msgShell('user-msg');
  if (info.pend) wrap.dataset.pend = info.pend;

  // 编辑并重新发送：把这轮的提示词（和参数）搬回输入框
  if (info.rec && !info.pend) {
    const edit = document.createElement('button');
    edit.className = 'edit-msg-btn';
    edit.type = 'button';
    edit.innerHTML =
      '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z"/></svg>';
    edit.title = '编辑并重新发送：把这条的提示词和参数填回输入框';
    edit.addEventListener('click', () => applyRecordToComposer(info.rec, { submit: false }));
    wrap.appendChild(edit);
  }

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  const refs = refsBlock(info.refs);
  if (refs) bubble.appendChild(refs);

  if (info.text) {
    const t = document.createElement('div');
    t.className = 'bubble-text';
    t.textContent = info.text;
    // 长提示词默认折叠：一条 400 字的精修提示词能占掉半屏，
    // 回头翻记录时基本只看前面几个字，想看全的再点开
    if (info.text.length > 200 || info.text.split('\n').length > 6) {
      t.classList.add('is-clampable', 'is-clamped');
      t.title = '点击展开 / 收起';
      t.addEventListener('click', () => t.classList.toggle('is-clamped'));
    }
    bubble.appendChild(t);
  }

  const foot = document.createElement('div');
  foot.className = 'msg-foot';
  foot.textContent = recTime(info.ts);
  if (info.count) {
    const s = document.createElement('span');
    s.textContent = `${info.count} 张`;
    foot.appendChild(s);
  }
  bubble.appendChild(foot);
  wrap.appendChild(bubble);
  return wrap;
}

/** AI 气泡（左对齐）：结果图网格 + 每张的下载 / 继续改 / 标注 */
function buildAiBubble(rec) {
  const wrap = msgShell('ai-msg');
  if (rec.pend) wrap.dataset.pend = rec.pend;
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = 'AI';
  wrap.appendChild(avatar);

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  const meta = document.createElement('div');
  meta.className = 'ai-meta';
  meta.innerHTML =
    `<code>${escapeHtml(rec.model || '—')}</code>` +
    `<span>${escapeHtml(recMetaLine(rec))}</span>`;
  if (rec.pend) {
    const state_ = document.createElement('span');
    state_.className = 'rec-state running';
    state_.innerHTML = `<span class="spinner spinner-dark"></span>生成中… 已用 <b data-pend-elapsed>${pendingElapsedText(rec)}</b>`;
    meta.appendChild(state_);
  }
  if (rec.id) {
    meta.appendChild(Object.assign(document.createElement('span'), { className: 'spacer' }));
    const del = document.createElement('button');
    del.className = 'icon-btn';
    del.textContent = '✕';
    del.title = '删除这条记录';
    del.setAttribute('aria-label', '删除这条记录');
    del.addEventListener('click', (e) => {
      e.stopPropagation(); // 气泡本身没绑点击，但别给外层的委托留口子
      deleteRecord(rec);
    });
    meta.appendChild(del);
  }
  bubble.appendChild(meta);

  if (rec.pend) {
    const bar = document.createElement('div');
    bar.className = 'bar bar-pending';
    bar.innerHTML = '<i></i>';
    bubble.appendChild(bar);
    const tip = document.createElement('div');
    tip.className = 'pending-tip';
    tip.textContent = rec.hint || '出图后自动换成结果';
    bubble.appendChild(tip);
  }

  if (rec.failed) bubble.appendChild(noticeEl('err', '生成失败：' + rec.failed));
  (rec.notes || []).forEach((t) => bubble.appendChild(noticeEl('warn', t)));

  // 失败的那一轮给一个一键重试：参数（提示词/参考图/比例/分辨率/数量/模型）都在记录里存着，
  // 不用让用户自己重新填一遍（旧记录可能没存参考图副本，会提示重新拖）。
  // 按钮带下拉（2026-10-07）：默认还是原样重跑，但**能当场换个模型**再跑 ——
  // 模型自己抽风失败时，用户最需要的就是换一家重试，而不是被迫先去顶部栏切模型、再回来找这条记录。
  if (rec.failed && !rec.pend) {
    const retry = document.createElement('button');
    retry.className = 'btn btn-ghost btn-sm retry-btn';
    retry.innerHTML = '重试这一轮<span class="retry-caret">▾</span>';
    retry.title = '默认按这条记录原本的提示词和参数重跑；点开可以换个模型重试';
    retry.setAttribute('aria-haspopup', 'menu');
    retry.setAttribute('aria-expanded', 'false');
    retry.addEventListener('click', (e) => {
      e.stopPropagation(); // 拦下来：不然会被 document 上那个「点哪儿都关」的监听当场关掉
      toggleRetryMenu(retry, rec);
    });
    bubble.appendChild(retry);
  }

  if ((rec.images || []).length) {
    const grid = document.createElement('div');
    grid.className = 'rec-imgs';
    rec.images.forEach((im, i) => {
      const full = im.file || im.path || '';
      const fig = document.createElement('figure');
      fig.className = 'rec-img';
      const img = document.createElement('img');
      img.loading = 'lazy';
      onImgError(img, '图片读不到');
      img.src = imgUrl(im.thumb || full);
      img.dataset.full = imgUrl(full);
      img.addEventListener('click', () => openViewerInConv(imgUrl(full)));
      fig.appendChild(img);

      const acts = document.createElement('figcaption');
      acts.className = 'rec-acts';

      const dl = document.createElement('a');
      dl.className = 'btn btn-ghost btn-sm';
      dl.textContent = '下载';
      dl.href = imgUrl(full);
      dl.download = `AI_IMG_HUB_${rec.id || 'x'}_${i + 1}${extOf(im.mime)}`;

      const again = document.createElement('button');
      again.className = 'btn btn-ghost btn-sm';
      again.textContent = '继续改';
      again.title = '把这张图作为参考图，进入下一轮生图';
      again.addEventListener('click', () => useImageAsRef(imgUrl(full), `记录${i + 1}`));

      const mark = document.createElement('button');
      mark.className = 'btn btn-ghost btn-sm';
      mark.textContent = '标注';
      mark.title = '在图上圈出要改的地方，标注完自动作为参考图';
      mark.addEventListener('click', () => openDoodle(imgUrl(full), (dataUrl) => useDataUrlAsRef(dataUrl, `标注${i + 1}`)));

      acts.append(dl, again, mark);
      fig.appendChild(acts);
      grid.appendChild(fig);
    });
    bubble.appendChild(grid);
  }

  wrap.appendChild(bubble);
  return wrap;
}

/* ------------------------------------------------------------ 重试：按钮上的模型下拉 */

/*
 * 失败那一轮的「重试这一轮 ▾」。点一下弹一个小菜单：
 *   ① 原模型重试（这条记录当时用的来源 · 协议 · 模型，原样重跑）
 *   ② 换个模型重试（跟顶部栏同一个来源的「常用组合」state.quickModels）
 *   ③ 先填回输入框，我自己挑模型…（等于以前的 ✎，回填但不发送）
 *
 * 弹层**挂在 body 上、position: fixed**：消息流那一层 .chat-scroll 是 overflow-y:auto，
 * 弹层留在气泡里会被这个滚动容器裁掉（失败气泡常常正好贴着可视区边缘）。
 * 挂 body 之后每次按按钮的实时位置摆一遍，上方放不下就翻到下方。
 * 滚动 / 改窗口大小 / 按 Esc / 点别处都关掉它。
 */
let retryMenuEl = null;
let retryMenuOwner = null;

function closeRetryMenu() {
  if (retryMenuEl && retryMenuEl.isConnected) retryMenuEl.remove();
  retryMenuEl = null;
  if (retryMenuOwner && retryMenuOwner.isConnected) retryMenuOwner.setAttribute('aria-expanded', 'false');
  retryMenuOwner = null;
}

/** 菜单内部自己滚动不算「页面滚了」，别把菜单关了 */
function onAnyScroll(e) {
  if (retryMenuEl && e.target && retryMenuEl.contains(e.target)) return;
  closeRetryMenu();
}

function positionRetryPop(pop, btn) {
  const gap = 8;
  const edge = 8;
  const r = btn.getBoundingClientRect();
  // 先按上下哪边宽裕决定朝哪开，再把高度卡进那一侧的空间，保证整块都看得见
  const roomAbove = r.top - gap - edge;
  const roomBelow = window.innerHeight - r.bottom - gap - edge;
  const openDown = roomBelow >= roomAbove;
  const room = Math.max(150, Math.min(340, openDown ? roomBelow : roomAbove));
  pop.style.maxHeight = room + 'px';
  const left = Math.max(edge, Math.min(r.left, window.innerWidth - pop.offsetWidth - edge));
  pop.style.left = left + 'px';
  if (openDown) {
    pop.style.top = r.bottom + gap + 'px';
    pop.style.bottom = 'auto';
  } else {
    pop.style.top = 'auto';
    pop.style.bottom = window.innerHeight - r.top + gap + 'px';
  }
}

/** 菜单里的一行：名称 + 来源 +（可选）一句说明 */
function retryItem({ name, src, note, active, run }) {
  const it = document.createElement('button');
  it.type = 'button';
  it.className = 'mm-item' + (active ? ' is-active' : '');
  const n = document.createElement('span');
  n.className = 'mm-i-name';
  n.textContent = name;
  it.appendChild(n);
  if (src) {
    const s = document.createElement('span');
    s.className = 'mm-i-src';
    s.textContent = src;
    it.appendChild(s);
  }
  if (note) {
    const t = document.createElement('span');
    t.className = 'mm-i-note';
    t.textContent = note;
    it.appendChild(t);
  }
  it.addEventListener('click', () => {
    closeRetryMenu();
    run();
  });
  return it;
}

function toggleRetryMenu(btn, rec) {
  if (retryMenuOwner === btn) return closeRetryMenu(); // 再点一次 = 收起
  closeRetryMenu();
  closeAllModelMenus();
  closePillPops();

  const cfg = state.config || {};
  const comboOf = (x) => `${x.provider || ''}|${x.protocol || ''}|${x.model || ''}`;
  const recCombo = comboOf(rec);
  const nowCombo = comboOf(cfg);

  const pop = document.createElement('div');
  pop.className = 'mm-pop retry-pop';
  pop.setAttribute('role', 'menu');
  pop.addEventListener('click', (e) => e.stopPropagation());

  pop.appendChild(menuSectionTitle('重试这一轮'));

  const srcLine = [rec.providerLabel, rec.protocolLabel].filter(Boolean).join(' · ');
  pop.appendChild(
    retryItem({
      name: `${rec.model || '—'}（原模型）`,
      src: srcLine || '这条记录当时用的模型',
      note: '提示词和参数原样重跑',
      active: nowCombo === recCombo,
      run: () => applyRecordToComposer(rec, { submit: true })
    })
  );

  // 换模型重试：列顶部栏那份「常用组合」，把原模型那条排除掉（上面已经有了）
  const others = (state.quickModels || []).filter((q) => comboOf(q) !== recCombo);
  if (others.length) {
    pop.appendChild(menuSectionTitle('换个模型重试'));
    others.forEach((q) => {
      pop.appendChild(
        retryItem({
          name: q.display || q.model,
          src: q.providerLabel || '',
          note: '沿用这条记录里对得上的参数档位',
          active: nowCombo === comboOf(q),
          run: () => applyRecordToComposer(rec, { submit: true, model: q })
        })
      );
    });
  }

  const foot = document.createElement('button');
  foot.type = 'button';
  foot.className = 'mm-item mm-foot';
  foot.textContent = '先填回输入框，我自己挑模型…';
  foot.addEventListener('click', () => {
    closeRetryMenu();
    applyRecordToComposer(rec, { submit: false });
  });
  pop.appendChild(foot);

  document.body.appendChild(pop);
  positionRetryPop(pop, btn);
  retryMenuEl = pop;
  retryMenuOwner = btn;
  btn.setAttribute('aria-expanded', 'true');
}

/** 把某张结果图变成参考图（「继续改」用它） */
async function useImageAsRef(url, name) {
  const lim = refLimit();
  if (state.single.refs.length >= lim) return toast(`参考图已满 ${lim} 张`, 'err');
  try {
    const dataUrl = await urlToDataUrl(url);
    useDataUrlAsRef(dataUrl, name);
  } catch (e) {
    toast('图片读取失败：' + e.message, 'err');
  }
}

/** 把 data:URL 塞进参考图（标注结果、记录图都走这里） */
function useDataUrlAsRef(dataUrl, name) {
  const lim = refLimit();
  if (state.single.refs.length >= lim) return toast(`参考图已满 ${lim} 张`, 'err');
  const m = String(dataUrl).match(/^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is);
  if (!m) return toast('这张图读不出来', 'err');
  if (state.mode !== 'single') setMode('single');
  state.single.refs.push({ name: name || '参考图', mime: m[1], base64: m[2], url: dataUrl });
  renderRefs();
  toast('已加入参考图');
}

/**
 * 记录里额外留一份「能重新提交给模型」的参考图副本。
 * 落盘那张 160px 缩略图只够看，拿去当参考图会糊；原图又太大（14 张 × 30MB）。
 * 折中：最长边 1536 + JPEG 0.85，一张两三 MB 变成两三百 KB，画质够用。
 */
const REF_REUSE_SIDE = 1536;

async function makeRefReuseCopy(dataUrl) {
  if (!dataUrl) return '';
  try {
    const img = await loadImage(dataUrl);
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    // 本来就不大就别重编码了，免得白白掉一次画质
    if (Math.max(w, h) <= REF_REUSE_SIDE && dataUrlBytes(dataUrl) <= 400 * 1024) return dataUrl;
    return reencodeImage(img, REF_REUSE_SIDE, 0.85);
  } catch {
    return '';
  }
}

/** 把记录里存着的参考图副本取回来；旧记录没存副本的会被跳过并回报数量 */
async function restoreRefsFromRecord(rec) {
  const lim = refLimit();
  const all = rec.refs || [];
  const out = [];
  for (const r of all) {
    if (out.length >= lim) break;
    if (!r.src) continue;
    try {
      const url = await urlToDataUrl(imgUrl(r.src));
      const m = String(url).match(/^data:(image\/[a-z0-9.+-]+);base64,(.*)$/is);
      if (m) out.push({ name: r.name || '参考图', mime: m[1], base64: m[2], url });
    } catch {
      /* 读不到这一张就跳过 */
    }
  }
  return { refs: out, missing: Math.max(0, all.length - out.length) };
}

/** 回填记录参数后，三个选择条的高亮要跟着 state 走 */
function setSingleParam(key, value) {
  state.single[key] = value;
  syncComposer();
}

function rebuildSingleControls() {
  normalizePicks(false);
  buildCountSeg($('#countSegSingle'), state.single.count, (v) => setSingleParam('count', v));
  renderParamPills();
  updateCountHint();
}

/**
 * 把「这条记录当时是怎么生成的」原样搬回输入框。
 * 「编辑并重发」和「重试失败」共用这一条路径：回填完要不要立刻发，看 opts.submit。
 */
async function applyRecordToComposer(rec, opts) {
  const o = opts || {};
  if (!rec) return;
  const draft = String($('#singlePrompt').value || '').trim() || state.single.refs.length;
  if (draft && !window.confirm('输入框里还有内容，要用这条记录覆盖掉吗？')) return;

  closePillPops();
  if (state.mode !== 'single') setMode('single');

  // 1) 模型：按记录里存的来源/协议/模型切回去（旧记录没这三个字段就留现状）。
  //    重试时用户在菜单里另挑了一个模型（o.model），就以他挑的那个为准。
  const cfg = state.config || {};
  const want =
    o.model && o.model.model
      ? {
          provider: o.model.provider,
          protocol: o.model.protocol,
          model: o.model.model,
          display: o.model.display || o.model.model,
          providerLabel: o.model.providerLabel || ''
        }
      : {
          provider: rec.provider,
          protocol: rec.protocol,
          model: rec.model,
          display: rec.model,
          providerLabel: rec.providerLabel || ''
        };
  const same = cfg.provider === want.provider && cfg.protocol === want.protocol && cfg.model === want.model;
  // 只认「本机确实配置了的来源/协议」：providerOf() 找不到时会退回第一个来源，
  // 拿旧记录里已经失效的 key 去切会把 baseUrl 顺手改错。
  const known = (state.providers || []).some((p) => p.key === want.provider) && !!protocolOf(want.protocol);
  if (want.provider && want.protocol && want.model && known && !same) {
    await switchModel({
      provider: want.provider,
      protocol: want.protocol,
      model: want.model,
      display: want.display,
      providerLabel: want.providerLabel || (providerOf(want.provider) || {}).label || ''
    });
  } else if (want.model && !same) {
    toast(
      o.model
        ? `${want.model} 所在的来源现在没配置，先按当前模型跑`
        : `这条记录用的是 ${want.model}，那个来源现在没配置，先按当前模型跑`,
      'err'
    );
  }

  // 2) 提示词 + 比例/分辨率/数量
  $('#singlePrompt').value = rec.prompt || '';
  autoGrow($('#singlePrompt'));
  savePromptMemory();
  applyPickFromRecord(rec);
  if (rec.count) state.single.count = Math.min(4, Math.max(1, Number(rec.count) || 1));
  rebuildSingleControls();

  // 3) 参考图
  const restored = await restoreRefsFromRecord(rec);
  state.single.refs = restored.refs;
  syncComposer();
  if (restored.missing) {
    toast(`${restored.missing} 张参考图是旧记录、没留下可复用的原图，请重新拖进来`, 'err');
  }

  if (o.submit) {
    generateSingle();
  } else {
    $('#singlePrompt').focus();
    toast('已填回输入框，改完点发送');
  }
}

/** 生成中：用户气泡 + 占位 AI 气泡（时间只改文字，不重建 DOM） */
function buildPendingBubbles(p) {
  const box = document.createDocumentFragment();
  box.appendChild(buildUserBubble({ ts: p.createdAt, text: p.prompt, refs: p.refs, pend: p.id }));
  box.appendChild(buildAiBubble(Object.assign({ pend: p.id }, p)));
  return box;
}

function buildRecordBubbles(rec) {
  const box = document.createDocumentFragment();
  box.appendChild(buildUserBubble({ ts: rec.createdAt, text: rec.prompt, refs: rec.refs, count: rec.count, rec }));
  box.appendChild(buildAiBubble(rec));
  return box;
}

function scrollChatToBottom(smooth) {
  const el = $('#chatScroll');
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

function chatAtBottom() {
  const el = $('#chatScroll');
  return el.scrollHeight - el.scrollTop - el.clientHeight < 140;
}

$('#chatScroll').addEventListener('scroll', () => {
  $('#btnScrollBottom').hidden = chatAtBottom();
  // 记下当前的相对位置（两种视图各记一份），切视图 / 重新渲染后好还原。
  // 用 rAF 节流：滚动事件一帧能报很多次，每次都算 scrollHeight 会掉帧。
  if (!scrollTick) {
    scrollTick = true;
    requestAnimationFrame(() => {
      scrollMemo[state.viewMode] = currentScrollRatio();
      scrollTick = false;
    });
  }
});
$('#btnScrollBottom').addEventListener('click', () => scrollChatToBottom(true));

/* 流式 / 网格的排版高度差很多，切回来还停在原来的相对位置比回到顶/底好用 */
const scrollMemo = { flow: null, grid: null };
let scrollTick = false;

function currentScrollRatio() {
  const el = $('#chatScroll');
  const max = el.scrollHeight - el.clientHeight;
  return max > 0 ? Math.min(1, Math.max(0, el.scrollTop / max)) : 0;
}

function restoreScrollRatio() {
  const ratio = scrollMemo[state.viewMode];
  if (ratio == null) return;
  requestAnimationFrame(() => {
    const el = $('#chatScroll');
    const max = el.scrollHeight - el.clientHeight;
    if (max > 0) el.scrollTop = max * ratio;
    $('#btnScrollBottom').hidden = chatAtBottom();
  });
}

/**
 * 生成中离开页面提醒。
 * 单张生图是「页面向本地服务发一个长请求」，页面一走这次生成就断了；
 * 批量任务跑在服务端，关页面不影响，所以只看 pending。
 */
window.addEventListener('beforeunload', (e) => {
  if ((state.pendingRecords || []).length) {
    e.preventDefault();
    e.returnValue = '还有图正在生成，离开页面会中断这次生成。';
    return e.returnValue;
  }
});

/* ============================================================
   对话：左边栏按 convId 分组，每次打开页面开一个新对话
   ============================================================ */

const CONV_LEGACY = 'legacy';

function newConvId() {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** 这条记录/任务属于哪个对话。老数据没有 convId，统一归到「早前的对话」。 */
function convIdOf(row) {
  return String((row && row.convId) || '') || CONV_LEGACY;
}

/**
 * 本地缓存按对话裁剪：**每个对话各留 n 条**（服务端也是这个规则，见 server.js 的 RECORD_LIMIT）。
 * 传进来的列表是按时间倒序的，所以「每见到一个对话就计数、超过 n 就丢」正好等于保留最新的 n 条。
 * 以前这里是全局 slice(0, 60)：同时开着好几条对话时，老对话的记录会被别的对话挤掉。
 */
function limitRecordsByConv(list, n) {
  const seen = Object.create(null);
  return list.filter((r) => {
    const k = convIdOf(r);
    seen[k] = (seen[k] || 0) + 1;
    return seen[k] <= n;
  });
}

/** 标题取这条对话里第一句提示词 */
function convTitleOf(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '（未写提示词）';
  return t.length > 22 ? t.slice(0, 22) + '…' : t;
}

/** DeepSeek 那种时间分档 */
function dateGroupLabel(ts) {
  const d = new Date(ts || Date.now());
  const now = new Date();
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff <= 0) return '今天';
  if (diff === 1) return '昨天';
  if (diff <= 7) return '7 天内';
  if (diff <= 30) return '30 天内';
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`;
}

/**
 * 把所有记录 + 批量任务按对话聚合出来。
 * 每条对话额外带一个 busy —— 它名下还有几轮正在跑（见下面两处 += 1）。
 * 侧栏靠它决定要不要挂那个转圈：生图可以并发，也可以中途切对话 / 开新对话，
 * 切走之后总得有个地方能看出「哪条对话还在出图」。
 */
function buildConversations() {
  const map = new Map();
  const touch = (id, ts, text, count, kind) => {
    let c = map.get(id);
    if (!c) {
      c = { id, title: '', createdAt: ts || 0, updatedAt: ts || 0, count: 0, batch: 0, busy: 0 };
      map.set(id, c);
    }
    if (!c.title && text) c.title = convTitleOf(text);
    if (ts && ts < c.createdAt) c.createdAt = ts;
    if (ts && ts > c.updatedAt) c.updatedAt = ts;
    c.count += count || 1;
    if (kind === 'batch') c.batch += 1;
  };
  (state.records || []).forEach((r) => touch(convIdOf(r), r.createdAt, r.prompt, 1, 'single'));
  (state.batchJobs || []).forEach((j) => {
    const id = convIdOf(j);
    touch(id, j.startedAt, (j.options || {}).prompt, 1, 'batch');
    // 批量任务跑在服务端，刷页面都停不下来：回来时侧栏也要接着转
    if (j.stats && j.stats.running) map.get(id).busy += 1;
  });
  map.forEach((c) => {
    if (!c.title) c.title = '（未写提示词）';
  });
  // 还没落盘的「生成中」也要算进它自己那条对话的条数。
  // 并发生图 / 中途开新对话时，这些占位可能属于好几条不同的对话，
  // 所以按每条自带的 convId 分组，而不是一股脑塞给当前对话。
  (state.pendingRecords || []).forEach((p) => {
    const id = convIdOf(p);
    let c = map.get(id);
    if (!c) {
      c = {
        id,
        title: convTitleOf(p.prompt),
        createdAt: p.createdAt || Date.now(),
        updatedAt: p.createdAt || Date.now(),
        count: 0,
        batch: 0,
        busy: 0
      };
      map.set(id, c);
    }
    if (!c.title) c.title = convTitleOf(p.prompt);
    c.count += 1;
    c.busy += 1; // 这一轮还没落盘 = 它正在生成
    if (p.createdAt && p.createdAt > c.updatedAt) c.updatedAt = p.createdAt;
  });
  return Array.from(map.values()).sort((a, b) => b.updatedAt - a.updatedAt);
}

function renderConversations() {
  const host = $('#convList');
  if (!host) return;
  const convs = buildConversations();
  // 留一份到本地：整页刷新后先用它把侧栏画出来，免得等接口那阵子闪一下空白。
  // 只在真实数据加载完之后才更新缓存，不然服务断开时会把缓存冲成空的。
  // busy（还有几轮在跑）**不写进缓存**：它是当下这一刻的状态，刷新之后那几轮已经断了，
  // 缓存里的转圈会一直转下去 —— 清成 0，等真实数据回来再重新判。
  if (convCacheReady) {
    try {
      localStorage.setItem('sbConvCache', JSON.stringify(convs.map((c) => ({ ...c, busy: 0 }))));
    } catch {}
  }
  sbRunKey = runningBatchKey(); // 记下这一帧在跑的批量任务，syncSidebarRunning 靠它判断要不要再画一次
  renderConvItems(host, convs);
}

/** 还在跑的批量任务。生图那边没有「服务端在跑」这一说，不在这里 */
function runningBatchKey() {
  return (state.batchJobs || [])
    .filter((j) => j.stats && j.stats.running)
    .map((j) => j.id)
    .join(',');
}

/**
 * 批量任务在跑的时候，进度事件密到每秒好几条 —— 每条都整块重画侧栏是白费。
 * 而侧栏上跟批量有关的其实只有一个 bit：这条对话是不是还在跑？
 * 所以比对一下这把 key，只有它真变了（开跑 / 收工）才重画一次。
 * 生图那边的占位（pendingRecords）进出场本来就会顺手把侧栏刷新，走的是别的路。
 */
function syncSidebarRunning() {
  if (runningBatchKey() === sbRunKey) return;
  renderConversations();
}

/** 页面刚打开、接口还没回来时：用上次的缓存先把侧栏画出来，点刷新不再闪空白 */
function restoreConvsFromCache() {
  const host = $('#convList');
  if (!host) return;
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem('sbConvCache') || 'null'); } catch {}
  if (Array.isArray(cached) && cached.length) renderConvItems(host, cached);
}

/** 列表重建的实际干活部分，渲染缓存时也走同一条路，点击/删除监听都齐 */
function renderConvItems(host, convs) {
  // 生成过程中这个列表会被反复重建，滚动位置别跟着跳回去
  const keepScroll = host.scrollTop;
  host.replaceChildren();

  // 当前对话（可能是刚开的空对话）永远排在最上面
  const mine = convs.find((c) => c.id === state.convId);
  if (!mine) {
    convs = [{ id: state.convId, title: '新对话', createdAt: Date.now(), updatedAt: Date.now(), count: 0, batch: 0, busy: 0, isNew: true }].concat(convs);
  }

  let lastGroup = '';
  convs.forEach((c) => {
    const g = c.isNew ? '当前' : dateGroupLabel(c.updatedAt);
    if (g !== lastGroup) {
      lastGroup = g;
      const t = document.createElement('div');
      t.className = 'sb-group-title';
      t.textContent = g;
      host.appendChild(t);
    }
    const item = document.createElement('div');
    item.className = 'sb-conv' + (c.id === state.convId ? ' is-active' : '') + (c.busy ? ' is-running' : '');
    item.dataset.conv = c.id;
    // 这是个 div，不给 tabindex/role 键盘根本到不了它 —— 侧栏对话是主要导航，必须能 Tab 到
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.title = c.busy ? `${c.title} —— 正在生图（${c.busy} 轮在跑）` : c.title;
    const ic = document.createElement('span');
    ic.className = 'cv-ic';
    ic.innerHTML = c.batch
      ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="7.5" y="4" width="13" height="11.5" rx="2"/><path d="M16.5 19.5H6a2 2 0 01-2-2V8"/></svg>'
      : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="8.6" cy="9.6" r="1.5" fill="currentColor" stroke="none"/><path d="M4.2 16.2l4.6-4.6 3 3 3.2-3.2 5 5"/></svg>';
    item.appendChild(ic);
    const title = document.createElement('span');
    title.className = 'cv-title';
    title.textContent = c.title;
    item.appendChild(title);
    // 这条对话还有几轮在跑：右侧挂一个转圈，替掉那个「轮数」角标的位置。
    // 只有一处尾随状态位，不会挤；蓝色 = 进行中（见 style.css 头部的配色规则）
    if (c.busy) {
      const sp = document.createElement('span');
      sp.className = 'cv-spin';
      sp.setAttribute('role', 'status');
      sp.setAttribute('aria-label', '正在生图');
      item.appendChild(sp);
    } else if (!c.isNew && c.count) {
      const n = document.createElement('span');
      n.className = 'cv-n';
      n.textContent = String(c.count);
      item.appendChild(n);
    }
    // 空对话（还没生成的占位）不给删除键 —— 它本来就没内容
    if (!c.isNew) {
      const del = document.createElement('button');
      del.className = 'cv-del';
      del.type = 'button';
      del.title = '删除这条对话';
      del.setAttribute('aria-label', '删除「' + c.title + '」');
      del.innerHTML =
        '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      del.addEventListener('click', (e) => {
        // 必须拦住：不然会先冒泡到 item 上，把这条对话选中了再弹确认框
        e.stopPropagation();
        deleteConversation(c.id);
      });
      item.appendChild(del);
    }
    item.addEventListener('click', () => selectConversation(c.id));
    // 键盘：回车 / 空格等同于点击（列表项是 div，只有 tabindex 还不够，要自己接键）
    item.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        selectConversation(c.id);
      }
    });
    host.appendChild(item);
  });
  host.scrollTop = keepScroll;
}

function refreshChatEmpty() {
  const body = $('#chatBody');
  if (!body) return;
  const empty = !currentConvRows().length;
  body.classList.toggle('is-empty', empty);
}

function selectConversation(id) {
  if (!id || id === state.convId) return;
  closeSidebarIfOverlay();
  state.convId = id;
  scrollMemo[state.viewMode] = null; // 换对话不沿用上一个对话的滚动位置
  renderConversations();
  renderRecords();
  scrollChatToBottom();
}

/**
 * 开一个新对话：每次打开页面也会走这里。
 * 注意**不清空 pendingRecords**：后台还有别的对话在生图，
 * 把占位和它们的进度一起抹掉，那几轮回来就没地方落座了。
 * 占位按各自的 convId 归属，新对话天然是空的。
 *
 * 也**不动输入框**（2026-10-07 改）：提示词、参考图缩略图、文件夹贴片、生图/批量模式
 * 全部原样带进新对话。开新对话只是换一条线，不是丢掉没发出去的草稿。
 * 想清空就点发送（clearComposer 会把提示词和素材一起腾空），或者手动删。
 * 旧行为是这里顺手 state.single.refs = [] —— 文字留着、参考图却被吃掉，前后不一致，已去掉。
 */
function startNewConversation() {
  closeSidebarIfOverlay();
  closeRetryMenu();
  state.convId = newConvId();
  scrollMemo[state.viewMode] = null;
  closePillPops();
  renderConversations();
  renderRecords();
  syncComposer();
  setTimeout(() => $('#singlePrompt').focus(), 0);
}

/* ------------------------------------------------------------ 消息流 */

/** 当前对话里要显示的行（记录 + 生成中 + 批量任务） */
function currentConvRows() {
  const rows = [];
  (state.pendingRecords || [])
    .filter((p) => convIdOf(p) === state.convId)
    .forEach((p) => rows.push({ ts: p.createdAt, build: () => buildPendingBubbles(p) }));
  (state.records || [])
    .filter((r) => convIdOf(r) === state.convId)
    .forEach((r) => rows.push({ ts: r.createdAt, build: () => buildRecordBubbles(r) }));
  (state.batchJobs || [])
    .filter((j) => convIdOf(j) === state.convId)
    .forEach((j) => rows.push({ ts: j.startedAt || 0, build: () => buildBatchBubble(j) }));
  rows.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  return rows;
}

/** 把当前对话的数据按时间合成一条消息流 */
function renderRecords() {
  const host = $('#chatList');
  if (!host) return;
  const keep = chatAtBottom();
  const rows = currentConvRows();
  refreshChatEmpty();

  if (!rows.length) {
    // 空对话：正文交给居中的问候语（#chatEmpty），这里不再塞欢迎气泡
    host.replaceChildren();
    $('#btnScrollBottom').hidden = true;
    renderConversations();
    return;
  }

  const frag = document.createDocumentFragment();
  rows.forEach((r) => frag.appendChild(r.build()));
  host.replaceChildren(frag);
  renderConversations();
  // 贴在底部就继续跟着最新；在翻旧记录就按比例还原，别把人踢走
  if (keep) scrollChatToBottom();
  else restoreScrollRatio();
}


/** 一轮生成结束后写一条记录：参考图缩略图 + 提示词 + 结果图 */
async function saveRecord(rec) {
  try {
    const r = await api('/api/records/add', { record: rec });
    if (!r.ok) return toast('记录保存失败：' + (r.error || ''), 'err');
    state.records = limitRecordsByConv([r.record].concat(state.records), 60);
    // 并发时这一轮可能属于另一条对话：那就只更新左边栏，
    // 别把用户当前正看着的那屏重画一遍
    if (convIdOf(r.record) === state.convId) renderRecords();
    else renderConversations();
  } catch (e) {
    toast('记录保存失败：' + e.message, 'err');
  }
}


/**
 * 只有点发送键才会发出去。
 * 回车保留原生行为 = 换行（长提示词基本都是多行的，回车直接发送反而容易误发），
 * 所以这里不再拦 keydown / beforeinput。
 */
function sendFromComposer() {
  if (state.mode === 'batch') startBatch();
  else generateSingle();
}

/**
 * 发出去就把输入框腾空。
 * 程序改 value 不会触发 input 事件，所以记忆里的那份也要一起清，否则刷新页面旧提示词又回来了。
 * 提示词并没有丢：生图记进了记录，批量任务记进了 job，记录上的「发送」能把原文填回来。
 */
function clearComposerPrompt() {
  const ta = activePromptEl();
  if (!ta) return;
  ta.value = '';
  autoGrow(ta);
  saveUiState(state.mode === 'batch' ? { batchPrompt: '', prompt: '' } : { singlePrompt: '' });
}

/**
 * 发出去就把这一轮的**素材**也从输入框上摘掉：
 *   生图 → 参考图缩略图（留着会一直赖在输入框左上角，下一轮很容易被当成新参考图又发一遍）
 *   批量 → 文件夹贴片 + ⚙ 批量选项里那份扫描结果
 * 批量还要把界面记忆里的目录一起摘掉，否则刷新页面贴片又回来了（跟提示词是同一个坑）。
 * 目录并没有忘：另存一份 lastInputDir，只给「选择文件夹」当起始位置用，不再往界面上放。
 */
function clearComposerAttachments() {
  if (state.mode === 'batch') {
    state.batch.dir = '';
    state.batch.count = 0;
    $('#batchInput').value = '';
    $('#scanInfo').textContent = '';
    renderScanGrid([]);
  } else {
    state.single.refs = [];
  }
  renderRefs();
}

/** 发送后统一清场：提示词 + 这一轮的素材 */
function clearComposer() {
  clearComposerPrompt();
  clearComposerAttachments();
}

$('#btnSend').addEventListener('click', sendFromComposer);

/**
 * 发起一轮生图。
 *
 * **可以并发**：发送按钮不再被禁用，同一对话里可以连着发，也可以中途
 * 开新对话接着发 —— 已经在跑的那几轮互不影响。
 *
 * 所以这一轮用到的所有东西（对话 id、模型/来源/协议、比例、分辨率、张数、
 * 提示词、参考图）必须在发出去的**那一刻全部快照到本地变量**。
 * 生成要几十秒，这期间用户完全可能在同一个输入框里换模型、换比例、
 * 换参考图、切对话；如果落盘时才去读 state，记录就会张冠李戴。
 */
async function generateSingle() {
  const cfg = state.config || {};
  const prov = providerOf(cfg.provider) || { keyField: 'apiKey', label: '接口' };
  if (!cfg[prov.keyField]) {
    toast(`请先在左下角「设置」里填写 ${prov.label || ''} 的 Key`, 'err');
    return openSettings();
  }

  // ---- 快照：这一轮的全部输入 ----
  const prompt = $('#singlePrompt').value.trim();
  const convId = state.convId;
  // 记录卡片上显示的「比例 / 分辨率」；真正发出去的参数见 paramPayload()
  const shown = recordParamsOf(false);
  const ratio = shown.ratio;
  const size = shown.size;
  const n = state.single.count;
  const refs = state.single.refs.slice();
  const model = cfg.model;
  const provider = cfg.provider || '';
  const protocol = cfg.protocol || '';
  const providerLabel = prov.label || '';

  if (!prompt.trim()) {
    toast(refs.length ? '请描述想要怎样修改' : '文生图需要输入提示词', 'err');
    return;
  }

  const proto = protocolOf(protocol);
  const maxRefs = (modelInfo(model, provider) || {}).maxRefs || 0;
  if (maxRefs && refs.length > maxRefs) {
    toast(`${model} 最多接受 ${maxRefs} 张参考图，已按前 ${maxRefs} 张提交`, 'err');
  }

  // 请求发出前就清空：输入框留着上一轮的话 / 参考图，下一轮很容易在旧素材上改，改完还以为是新的
  clearComposer();

  // 消息流末尾立刻挂一条「生成中…」，一轮结束（成功或失败）再由真实记录顶替
  const pendId = 'pend-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  addPendingRecord({
    id: pendId,
    convId, // 占位只出现在它自己那条对话里，切对话 / 开新对话都不会串
    createdAt: Date.now(),
    prompt,
    model,
    providerLabel,
    protocolLabel: proto ? proto.label : '',
    ratio,
    size,
    count: n,
    // 参考图直接复用左侧已经加载过的图，不必等缩略图重新画一遍
    refs: refs.slice(0, 14).map((x) => ({ name: x.name, thumb: x.url })),
    hint: (proto && proto.async ? '异步任务，正在等结果' : '出图中…') + (n > 1 ? `（共 ${n} 张）` : '')
  });

  const t0 = Date.now();
  const notes = [];
  // 缩略图 / 复用副本先算好：失败那条分支也要用（写在 try 里面 catch 就读不到了）
  let refThumbs = [];
  let refSrcs = [];
  try {
    const r = await api('/api/generate', Object.assign({
      prompt,
      images: refs.map((x) => ({ mime: x.mime, base64: x.base64 })),
      config: { count: n }
    }, paramPayload(false)));
    if (!r.ok) {
      const msg = '生成失败：' + r.error;
      toast('生成失败，已记入生图记录', 'err');
      notes.push(msg);
    } else {
      // 上游只收 n=1 时服务端会降级重发：记下这个组合，「出几张」的提示跟着改口
      markNativeNFallback(r.debug);
      if (r.debug && r.debug.paramNotes && r.debug.paramNotes.length) notes.push('参数已自动调整：' + r.debug.paramNotes.join('；'));
      if (r.debug && r.debug.failedRuns) notes.push(`有 ${r.debug.failedRuns} 张失败：${(r.debug.errors || []).join(' / ')}`);
      if (r.texts && r.texts.length) notes.push('模型附言：' + r.texts.join(' / '));
      // 出图了就是成功，先把结果报出来；提醒另发一条。
      // 以前只要 notes 非空就不报成功、只弹红条，「参数被自动调整 + 3 张都出了」
      // 会被显示成一次失败，看着像没出图。
      toast(`生成完成 ${r.images.length} 张 · ${fmtMs(Date.now() - t0)}`, 'ok');
      if (notes.length) toast(notes.join('；'), r.debug && r.debug.failedRuns ? 'err' : 'warn');
    }

    // 一条记录 = 参考图 + 提示词 + 结果图，写盘后刷新页面也还在
    const images = (r.images || []).map((im) => ({ mime: im.mime, base64: im.base64 }));
    const thumbs = await Promise.all(images.map((im) => makeThumb('data:' + (im.mime || 'image/png') + ';base64,' + im.base64, 320)));
    refThumbs = await Promise.all(refs.slice(0, 14).map((x) => makeThumb(x.url, 160)));
    // 另外留一份「能拿去重发」的副本（160px 缩略图当参考图会糊），见 appendRecord 里的说明
    refSrcs = await Promise.all(refs.slice(0, 14).map((x) => makeRefReuseCopy(x.url)));
    await saveRecord({
      createdAt: Date.now(),
      convId,
      prompt,
      model,
      provider,
      protocol,
      providerLabel,
      protocolLabel: proto ? proto.label : '',
      ratio,
      size,
      // 存「这轮要出几张」而不是「实际出了几张」：失败时为 0 的话，
      // 重试就不知道原来看的是几张了
      count: n,
      ms: Date.now() - t0,
      failed: r.ok ? '' : String(r.error || ''),
      notes,
      refs: refs.slice(0, 14).map((x, i) => ({ name: x.name, thumb: refThumbs[i] || '', src: refSrcs[i] || '' })),
      images: images.map((im, i) => ({ mime: im.mime, base64: im.base64, thumb: thumbs[i] || '' }))
    });
  } catch (e) {
    await saveRecord({
      createdAt: Date.now(),
      convId,
      prompt,
      model,
      provider,
      protocol,
      providerLabel,
      protocolLabel: proto ? proto.label : '',
      ratio,
      size,
      count: n,
      ms: Date.now() - t0,
      failed: e.message,
      refs: refs.slice(0, 14).map((x, i) => ({ name: x.name, thumb: '', src: refSrcs[i] || '' })),
      images: []
    });
    toast('请求异常：' + e.message, 'err');
  } finally {
    // 真实记录已经落盘并渲染在消息流末尾，占位气泡在这里退场（找不到也不会报错）
    dropPendingRecord(pendId);
  }
}

/* ------------------------------------------------------------ 扫描：64×64 缩略图 */

function revealPath(p) {
  const target = String(p || '').trim();
  if (!target) return toast('路径还是空的，先填或先选一个文件夹', 'err');
  return api('/api/reveal', { path: target }).then((r) => {
    if (!r.ok) return toast(r.error || '打开失败', 'err');
    // 资源管理器的窗口可能开在浏览器后面，明确说一句「已经打开了什么」，
    // 否则用户的第一反应是「点了没反应」
    toast('已在资源管理器中打开：' + (r.path || target), 'ok');
  });
}

/* 「打开」= 用系统资源管理器打开这个文件夹 */
$('#btnPickInput').addEventListener('click', () => revealPath($('#batchInput').value));

function renderScanGrid(files) {
  const box = $('#scanBox');
  const grid = $('#scanGrid');
  if (!box || !grid) return;
  grid.innerHTML = '';
  if (!files || !files.length) {
    box.hidden = true;
    return;
  }
  const frag = document.createDocumentFragment();
  // 服务端 /api/scan 最多返回 500 条，这里跟着取 500，别让「已扫描到 N 张」和列表对不上
  files.slice(0, 500).forEach((f) => {
    const fig = document.createElement('figure');
    fig.className = 'scan-item';
    fig.title = f.rel + (f.size ? `\n${fmtBytes(f.size)}` : '');
    const img = document.createElement('img');
    img.loading = 'lazy';
    onImgError(img, '读不到');
    img.src = imgUrl(f.abs);
    img.alt = f.name;
    img.addEventListener('click', () => showLightbox(img.src));
    fig.appendChild(img);
    const cap = document.createElement('figcaption');
    cap.textContent = f.name;
    cap.title = f.name;
    fig.appendChild(cap);
    frag.appendChild(fig);
  });
  grid.appendChild(frag);
  box.hidden = false;
}

$('#btnScan').addEventListener('click', () => {
  $('#scanInfo').textContent = '扫描中…';
  scanBatchDir();
});


/* ============================================================
   批量修图：一条任务 = 一条气泡
   收起态只有一屏：统计 + 进度 + 结果缩略图；点开才看逐个文件的明细。
   ============================================================ */

function badgeOf(status) {
  const map = { pending: ['待处理', ''], running: ['处理中', 'running'], done: ['成功', 'done'], failed: ['失败', 'failed'], skipped: ['跳过', 'skipped'] };
  const [text, cls] = map[status] || [status, ''];
  return `<span class="badge ${cls}">${text}</span>`;
}

function mkBtn(text, cls, onClick, title) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = text;
  if (title) b.title = title;
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

function statsOf(p) {
  return {
    total: Number(p.total) || 0,
    done: Number(p.done) || 0,
    ok: Number(p.ok) || 0,
    failed: Number(p.failed) || 0,
    skipped: Number(p.skipped) || 0,
    inFlight: Number(p.inFlight) || 0,
    running: !!p.running
  };
}

/** 状态迁移时就地改计数，不必每次 events 都全表重算 */
function bumpStat(stats, status, d) {
  if (status === 'done') {
    stats.done += d;
    stats.ok += d;
  } else if (status === 'failed') {
    stats.done += d;
    stats.failed += d;
  } else if (status === 'skipped') {
    stats.done += d;
    stats.skipped += d;
  } else if (status === 'running') {
    stats.inFlight = Math.max(0, stats.inFlight + d);
  }
}

function mergeJobItem(job, it) {
  const cur = job.items.get(it.rel) || { rel: it.rel, status: 'pending' };
  const prev = cur.status;
  if (it.abs) cur.abs = it.abs;
  if (it.out || it.outAbs) cur.out = it.out || it.outAbs;
  if (it.status) cur.status = it.status;
  if (it.ms != null) cur.ms = it.ms;
  if (it.error != null) cur.error = it.error;
  job.items.set(it.rel, cur);
  job.stats.total = job.items.size;
  if (prev !== cur.status) {
    bumpStat(job.stats, prev, -1);
    bumpStat(job.stats, cur.status, 1);
  }
  return cur;
}

/** 服务端推来的 job 快照 → 本地 job 对象（同一个 id 只创建一次） */
function upsertJob(payload, itemsArr) {
  if (!payload || !payload.id) return null;
  let job = state.batchJobs.find((j) => j.id === payload.id);
  if (!job) {
    job = { id: payload.id, items: new Map(), stats: statsOf({}), startedAt: 0, finishedAt: null };
    state.batchJobs.unshift(job);
  }
  ['inputDir', 'outputDir', 'model', 'options', 'convId'].forEach((k) => {
    if (payload[k]) job[k] = payload[k];
  });
  if (payload.startedAt) job.startedAt = payload.startedAt;
  if (payload.finishedAt) job.finishedAt = payload.finishedAt;
  if (payload.total != null) job.stats = statsOf(payload);
  if (itemsArr && itemsArr.length) itemsArr.forEach((i) => mergeJobItem(job, i));
  if (job.stats.running) state.batch.liveId = job.id;
  return job;
}

/* ------------------- 明细：一行一个文件（增量更新） ------------------- */

function buildJobRow(it) {
  const row = document.createElement('div');
  row.className = 'job-row';

  const thumb = document.createElement('div');
  thumb.className = 'thumbbox';
  const img = document.createElement('img');
  img.loading = 'lazy';
  img.alt = '';
  onImgError(img, '读不到');
  thumb.appendChild(img);
  row.appendChild(thumb);

  const name = document.createElement('div');
  name.className = 'fname';
  row.appendChild(name);

  const time = document.createElement('span');
  time.className = 't';
  row.appendChild(time);

  const badge = document.createElement('span');
  row.appendChild(badge);

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'icon-btn';
  openBtn.title = '在资源管理器中显示';
  openBtn.textContent = '↗';
  openBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (it.out) revealPath(it.out);
    else if (it.abs) revealPath(it.abs);
  });
  row.appendChild(openBtn);

  row.title = '点一下看大图（原图 ↔ 结果）';
  row.addEventListener('click', () => {
    const urls = [];
    if (it.abs) urls.push(imgUrl(it.abs));
    if (it.out) urls.push(imgUrl(it.out));
    if (urls.length) openViewer(urls, urls.length - 1);
  });

  return { row, img, name, time, badge, openBtn };
}

function updateJobRow(r, it) {
  const want = it.status === 'done' && it.out ? imgUrl(it.out) : it.abs ? imgUrl(it.abs) : '';
  if (want && r.img.dataset.src !== want) {
    r.img.dataset.src = want;
    r.img.src = want;
  }
  const html =
    `<b title="${escapeAttr(it.rel)}">${escapeHtml(it.rel)}</b>` +
    (it.error ? `<small class="err" title="${escapeAttr(it.error)}">${escapeHtml(String(it.error).slice(0, 160))}</small>` : '');
  if (r.name.dataset.h !== html) {
    r.name.dataset.h = html;
    r.name.innerHTML = html;
  }
  r.time.textContent = fmtMs(it.ms);
  const badge = badgeOf(it.status);
  if (r.badge.dataset.h !== badge) {
    r.badge.dataset.h = badge;
    r.badge.innerHTML = badge;
  }
  r.openBtn.hidden = !(it.status === 'done' && it.out);
}

/**
 * 只做增量：每完成一张就重建 500 行的话，浏览器会把所有缩略图重下一遍。
 * 已在 DOM 里的行只是被移动位置，不会触发图片重新加载。
 */
function renderJobRows(ctx) {
  const host = ctx.els.list;
  const all = Array.from(ctx.items.values());
  const shown = (ctx.filter === 'all' ? all : all.filter((i) => i.status === ctx.filter)).slice(0, 500);
  ctx.els.info.textContent = all.length ? `共 ${all.length} 个文件${shown.length < all.length ? `，显示 ${shown.length} 条` : ''}` : '';

  if (!shown.length) {
    host.innerHTML = `<div class="empty small"><p>${all.length ? '当前筛选下没有文件' : '还没有任务'}</p></div>`;
    ctx.rows.clear();
    return;
  }
  if (host.firstElementChild && host.firstElementChild.classList.contains('empty')) host.innerHTML = '';

  const seen = new Set();
  shown.forEach((it) => {
    seen.add(it.rel);
    let r = ctx.rows.get(it.rel);
    if (!r) {
      r = buildJobRow(it);
      ctx.rows.set(it.rel, r);
    }
    updateJobRow(r, it);
    host.appendChild(r.row);
  });
  for (const [rel, r] of ctx.rows) {
    if (!seen.has(rel)) {
      r.row.remove();
      ctx.rows.delete(rel);
    }
  }
}

/* ------------------- 气泡本体 ------------------- */

/** 结果缩略图：只在「完成的张数 + 最后一张」变了时才重画 */
function paintBatchThumbs(ctx) {
  const done = Array.from(ctx.items.values()).filter((i) => i.status === 'done' && i.out);
  const sign = done.length + ':' + (done.length ? done[done.length - 1].rel : '');
  if (ctx.sign === sign) return;
  ctx.sign = sign;

  const host = ctx.els.thumbs;
  host.innerHTML = '';
  if (!done.length) {
    host.hidden = true;
    if (ctx.els.restFulls) ctx.els.restFulls.dataset.moreFulls = '';
    return;
  }
  host.hidden = false;
  const start = Math.max(0, done.length - 8);
  done.slice(start).forEach((it) => {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = imgUrl(it.out);
    img.dataset.full = imgUrl(it.out);
    img.title = it.rel;
    img.addEventListener('click', () => openViewerInConv(imgUrl(it.out)));
    host.appendChild(img);
  });
  if (done.length > 8) {
    const more = document.createElement('span');
    more.className = 'more';
    more.textContent = `共 ${done.length} 张`;
    host.appendChild(more);
  }
  /**
   * 上面只画最后 8 张缩略图，但「查看器里能翻完整个对话」意味着
   * 超出的那部分也得在翻页清单里。清单挂在缩略图**之后**的一个空元素上：
   * 收集时按 DOM 顺序读，先出 8 张缩略图、再出剩下的，顺序就是完成顺序。
   * （不往 DOM 里塞隐藏的 img —— 设了 src 就会真去下载，几百张图会拖垮页面）
   */
  if (ctx.els.restFulls) {
    ctx.els.restFulls.dataset.moreFulls = JSON.stringify(done.slice(0, start).map((it) => imgUrl(it.out)));
  }
}

function paintBatch(ctx) {
  const job = ctx.job;
  const st = job.stats || statsOf({});
  const e = ctx.els;
  const total = st.total || ctx.items.size;

  e.total.textContent = total;
  e.done.textContent = st.done;
  e.ok.textContent = st.ok;
  e.fail.textContent = st.failed;
  e.running.textContent = st.inFlight;
  e.skip.textContent = st.skipped;

  const pct = total ? Math.max(0, Math.min(1, st.done / total)) : 0;
  // 用 scaleX 而不是 width：批量时进度事件很密，改宽度会每一步都触发重排
  e.bar.style.transform = `scaleX(${pct})`;

  if (total && st.done >= total) {
    e.text.textContent = `全部完成 · 成功 ${st.ok} / 失败 ${st.failed} / 跳过 ${st.skipped}`;
    e.eta.textContent = job.finishedAt && job.startedAt ? `耗时 ${fmtDur(Math.max(0, job.finishedAt - job.startedAt))}` : '';
  } else if (st.running) {
    e.text.textContent = `进行中 ${st.done}/${total}（${Math.round(pct * 100)}%）`;
    e.eta.textContent = st.inFlight ? `同时处理 ${st.inFlight} 张` : '';
  } else if (st.done) {
    e.text.textContent = `已停止 · 完成 ${st.done}/${total}`;
    e.eta.textContent = '';
  } else {
    e.text.textContent = '等待开始';
    e.eta.textContent = '';
  }

  e.time.textContent = recTime(job.startedAt);
  e.stop.hidden = !st.running;
  e.retry.hidden = !(st.failed > 0 && !st.running);
  e.reveal.hidden = !job.outputDir;
  e.expand.textContent = ctx.open ? '收起明细' : '展开明细' + (total > 6 ? `（${total}）` : '');
  e.detail.hidden = !ctx.open;

  paintBatchThumbs(ctx);
  if (ctx.open) renderJobRows(ctx);
  if (job.id === state.batch.liveId) $('#batchDot').hidden = !st.running;
  // 批量跑完 / 被停掉时，侧栏那条对话上的转圈也要跟着停 ——
  // 上面这堆进度更新走的都是「就地改气泡」，不会整块重画消息流，
  // 所以侧栏得在这儿单独收一下尾（内部自己判重，进度事件不会白画）
  syncSidebarRunning();
}

/** SSE 很密：把同一帧内的多次更新合成一次重绘 */
function schedulePaint(ctx) {
  if (ctx.timer) return;
  ctx.timer = requestAnimationFrame(() => {
    ctx.timer = 0;
    if (ctx.node && ctx.node.isConnected) paintBatch(ctx);
  });
}

function buildBatchBubble(job) {
  const wrap = msgShell('ai-msg', 'batch-msg');
  wrap.dataset.job = job.id;
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = '批量';
  avatar.style.fontSize = '10px';
  wrap.appendChild(avatar);

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  const ctx = {
    id: job.id,
    job,
    items: job.items,
    rows: new Map(),
    filter: 'all',
    open: state.batchExpanded.has(job.id),
    sign: '',
    timer: 0,
    node: wrap,
    els: {}
  };
  const e = ctx.els;

  const head = document.createElement('div');
  head.className = 'bb-head';
  const title = document.createElement('span');
  title.className = 'bb-title';
  title.innerHTML = `批量修图 · <b>${escapeHtml(baseName(job.inputDir) || '任务')}</b>`;
  head.appendChild(title);
  e.time = document.createElement('span');
  e.time.className = 'muted';
  head.appendChild(e.time);

  const acts = document.createElement('div');
  acts.className = 'bb-acts';
  e.stop = mkBtn('停止', 'btn btn-ghost btn-sm', () => stopBatch());
  e.retry = mkBtn('重试失败项', 'btn btn-ghost btn-sm', () => retryBatch(job.id));
  e.reveal = mkBtn('打开输出文件夹', 'btn btn-ghost btn-sm', () => revealPath(job.outputDir));
  e.expand = mkBtn('展开明细', 'btn btn-ghost btn-sm', () => {
    ctx.open = !ctx.open;
    if (ctx.open) state.batchExpanded.add(job.id);
    else state.batchExpanded.delete(job.id);
    paintBatch(ctx);
  });
  const del = mkBtn('✕', 'icon-btn', () => deleteBatchJob(job.id), '只删掉这条记录，磁盘上的图不动');
  acts.append(e.stop, e.retry, e.reveal, e.expand, del);
  head.appendChild(acts);
  bubble.appendChild(head);

  const path = document.createElement('div');
  path.className = 'bb-path';
  path.textContent = `${job.inputDir || ''} → ${job.outputDir || ''}`;
  bubble.appendChild(path);

  if (job.options && job.options.prompt) {
    const p = document.createElement('div');
    p.className = 'bb-prompt';
    p.textContent = job.options.prompt;
    p.title = job.options.prompt;
    bubble.appendChild(p);
  }

  const stats = document.createElement('div');
  stats.className = 'stats bb-stats';
  [
    ['总数', 'total', ''],
    ['已完成', 'done', ''],
    ['成功', 'ok', 'ok'],
    ['失败', 'fail', 'bad'],
    ['处理中', 'running', ''],
    ['跳过', 'skip', '']
  ].forEach(([label, key, cls]) => {
    const d = document.createElement('div');
    d.className = 'stat';
    const s = document.createElement('span');
    s.textContent = label;
    const b = document.createElement('strong');
    if (cls) b.className = cls;
    d.append(s, b);
    stats.appendChild(d);
    e[key] = b;
  });
  bubble.appendChild(stats);

  const bar = document.createElement('div');
  bar.className = 'bar';
  e.bar = document.createElement('i');
  bar.appendChild(e.bar);
  bubble.appendChild(bar);

  const foot = document.createElement('div');
  foot.className = 'bar-foot';
  e.text = document.createElement('span');
  e.eta = document.createElement('span');
  e.eta.className = 'muted';
  foot.append(e.text, e.eta);
  bubble.appendChild(foot);

  e.thumbs = document.createElement('div');
  e.thumbs.className = 'bb-thumbs';
  bubble.appendChild(e.thumbs);
  // 只承载「超出缩略图窗口的那批结果图 URL」，不显示任何东西，供查看器翻页用
  e.restFulls = document.createElement('span');
  e.restFulls.className = 'bb-rest';
  e.restFulls.hidden = true;
  bubble.appendChild(e.restFulls);

  const detail = document.createElement('div');
  detail.className = 'bb-detail';
  const tools = document.createElement('div');
  tools.className = 'list-tools';
  const filters = document.createElement('div');
  filters.className = 'filters';
  [
    ['all', '全部'],
    ['running', '处理中'],
    ['done', '成功'],
    ['failed', '失败'],
    ['pending', '待处理']
  ].forEach(([k, label]) => {
    const chip = mkBtn(label, 'chip' + (k === 'all' ? ' is-active' : ''), () => {
      ctx.filter = k;
      Array.from(filters.children).forEach((c) => c.classList.toggle('is-active', c === chip));
      renderJobRows(ctx);
    });
    chip.dataset.filter = k;
    filters.appendChild(chip);
  });
  e.info = document.createElement('span');
  e.info.className = 'muted';
  tools.append(filters, e.info);
  detail.appendChild(tools);
  e.list = document.createElement('div');
  e.list.className = 'job-list';
  detail.appendChild(e.list);
  bubble.appendChild(detail);
  e.detail = detail;

  wrap.appendChild(bubble);
  wrap.__ctx = ctx;
  if (job.id === state.batch.liveId) state.batch.liveCtx = ctx;
  paintBatch(ctx);
  return wrap;
}

/* ------------------- 任务操作 ------------------- */

function liveJob() {
  return state.batchJobs.find((j) => j.id === state.batch.liveId && j.stats && j.stats.running) || null;
}

async function startBatch() {
  const inputDir = $('#batchInput').value.trim() || state.batch.dir;
  const prompt = $('#batchPrompt').value.trim();
  const cfg = state.config || {};
  const prov = providerOf(cfg.provider) || { keyField: 'apiKey', label: '接口' };
  if (!cfg[prov.keyField]) {
    toast(`请先在左下角「设置」里填写 ${prov.label || ''} 的 Key`, 'err');
    return openSettings();
  }
  if (!inputDir) {
    setMode('batch');
    if ($('#popOptions').hidden) togglePillPop('#pillOptions');
    return toast('把文件夹拖进输入框就能开跑；也可以在 ⚙ 批量选项里手填路径', 'err');
  }
  if (!prompt) return toast('先写一句统一提示词（这批图要改成什么样）', 'err');
  if (liveJob()) return toast('已经有一个批量任务在跑，等它结束或先点停止', 'err');

  const btn = $('#btnSend');
  btn.disabled = true;
  btn.classList.add('is-loading');
  let r = null;
  try {
    r = await api('/api/batch/start', {
      inputDir,
      outputDir: '',
      prompt,
      // 这一轮算在哪个对话里：左侧栏按它分组
      convId: state.convId,
      // 胶囊选择 → 参数（比例/尺寸、分辨率、画质档），键随模型变
      ...paramPayload(true),
      concurrency: Number($('#batchConcurrency').value) || 3,
      recursive: $('#optRecursive').checked,
      includeExtra: $('#optExtra').checked,
      skipExisting: $('#optSkip').checked,
      writeCsvLog: $('#optCsv').checked,
      saveDebug: $('#optDebug').checked,
      followSourceRatio: $('#optFollowRatio').checked,
      suffix: (state.config && state.config.suffix) || '_修图',
      config: {}
    });
  } catch (e) {
    toast('启动失败：' + e.message, 'err');
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-loading');
  }
  if (!r) return;
  if (!r.ok) return toast(r.error, 'err');

  toast('任务已开始', 'ok');
  // 发送后把输入框腾空（提示词 + 文件夹贴片）——这一轮已经写进 job 了，
  // 任务气泡上带着路径，不用再靠贴片提醒「刚才跑的是哪个文件夹」
  clearComposer();
  // 目录另存一份只给界面逻辑用（下次「选择文件夹」从它开始），不进输入框
  saveUiState({ lastInputDir: inputDir });
  upsertJob(r.job, (r.job && r.job.items) || []);
  renderRecords();
  setTimeout(() => scrollChatToBottom(true), 30);
  syncComposer();
}

async function stopBatch() {
  const r = await api('/api/batch/stop', {});
  if (!r.ok) toast(r.error, 'err');
}

async function retryBatch(id) {
  if (id && id !== state.batch.liveId) {
    toast('这条任务已经不在服务的内存里了，把文件夹再拖一次就能重跑', 'err');
    return;
  }
  const r = await api('/api/batch/retry', {});
  if (!r.ok) return toast(r.error, 'err');
  const job = state.batchJobs.find((j) => j.id === state.batch.liveId);
  if (job) {
    // 服务端会把 failed/pending 重新入队；本地把对应计数退回去，避免中途数字对不上
    job.items.forEach((i) => {
      if (i.status !== 'failed' && i.status !== 'pending') return;
      bumpStat(job.stats, i.status, -1);
      i.status = 'pending';
      i.error = '';
      i.ms = 0;
    });
    job.stats.running = true;
    job.finishedAt = null;
  }
  toast('已重新入队', 'ok');
  renderRecords();
}

async function deleteBatchJob(id) {
  const r = await api('/api/batch/job/delete', { id });
  if (!r.ok) return toast(r.error || '删除失败', 'err');
  state.batchJobs = state.batchJobs.filter((j) => j.id !== id);
  state.batchExpanded.delete(id);
  if (state.batch.liveId === id) {
    state.batch.liveId = '';
    state.batch.liveCtx = null;
    $('#batchDot').hidden = true;
  }
  renderRecords();
  toast('记录已删除（磁盘上的图没动）', 'ok');
}

/* ------------------- 实时事件 ------------------- */

function repaintLive(force) {
  const node = state.batch.liveId ? document.querySelector(`.msg[data-job="${state.batch.liveId}"]`) : null;
  const ctx = node && node.__ctx;
  if (ctx) {
    state.batch.liveCtx = ctx;
    schedulePaint(ctx);
  } else if (force) {
    renderRecords();
  }
}

function connectEvents() {
  if (state.es) state.es.close();
  const es = new EventSource(`/api/batch/events?token=${TOKEN}`);
  state.es = es;
  es.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === 'hello') {
      if (msg.job) {
        upsertJob(msg.job, msg.job.items || []);
        renderRecords();
      }
      return;
    }
    if (msg.type === 'started') {
      upsertJob(msg, msg.items || []);
      renderRecords();
      return;
    }
    if (msg.type === 'progress') {
      const job = state.batchJobs.find((j) => j.id === (msg.id || state.batch.liveId));
      if (job && msg.total != null) job.stats = statsOf(msg);
      repaintLive(false);
      return;
    }
    if (msg.type === 'item') {
      const job = state.batchJobs.find((j) => j.id === state.batch.liveId);
      if (job) {
        mergeJobItem(job, msg);
        repaintLive(true);
      }
      return;
    }
    if (msg.type === 'log') {
      toast(`${msg.rel ? msg.rel + '：' : ''}${msg.message}`, 'err');
      return;
    }
    if (msg.type === 'stopping') {
      toast('正在停止，等当前这一张处理完…');
      return;
    }
    if (msg.type === 'fatal') {
      toast('任务异常：' + msg.message, 'err');
      const job = state.batchJobs.find((j) => j.id === state.batch.liveId);
      if (job) {
        job.stats.running = false;
        job.finishedAt = Date.now();
      }
      repaintLive(true);
      return;
    }
    if (msg.type === 'done') {
      const job = state.batchJobs.find((j) => j.id === (msg.id || state.batch.liveId));
      if (job) {
        job.stats = statsOf(msg);
        job.finishedAt = msg.finishedAt || Date.now();
      }
      repaintLive(true);
      if (msg.failed) toast(`批量完成：成功 ${msg.ok}，失败 ${msg.failed}`, 'err');
      else toast(`批量完成：${msg.ok} 张全部成功`, 'ok');
    }
  };
  es.onopen = () => hideConnBanner();
  es.onerror = () => {
    // CLOSED = 不会再自动重连（例如口令失效、服务已重启）；否则只是在重连中
    if (es.readyState === EventSource.CLOSED) {
      showConnBanner('与本地服务的连接已断开（服务可能重启过，会话口令已失效）。刷新页面即可恢复。');
    } else if (!connBannerShown) {
      showConnBanner('连接中断，正在自动重连…');
    }
  };
}

async function loadBatchJobs() {
  try {
    const r = await api('/api/batch/jobs');
    if (!r.ok) return;
    state.batchJobs = (r.jobs || []).map((raw) => {
      const job = {
        id: raw.id,
        inputDir: raw.inputDir,
        outputDir: raw.outputDir,
        model: raw.model,
        options: raw.options,
        startedAt: raw.startedAt || 0,
        finishedAt: raw.finishedAt || null,
        items: new Map(),
        stats: statsOf({})
      };
      (raw.items || []).forEach((i) => mergeJobItem(job, i));
      job.stats = Object.assign(statsOf(raw), { total: job.items.size });
      return job;
    });
    const live = state.batchJobs.find((j) => j.stats.running);
    state.batch.liveId = live ? live.id : '';
  } catch {
    /* 首次运行没有历史，忽略 */
  }
}


/* ------------------------------------------------------------ 设置 */

function providerOf(key) {
  return state.providers.find((p) => p.key === key) || state.providers[0] || null;
}
/** 这个地址属于哪个来源？用户自填的中转地址返回 null（对应服务端的 providerForBaseUrl） */
function providerByBaseUrl(base) {
  const key = String(base || '').replace(/\/+$/, '');
  if (!key) return null;
  return (
    state.providers.find((p) => [p.baseUrl, ...(p.baseUrlAliases || [])].some((u) => String(u).replace(/\/+$/, '') === key)) || null
  );
}
function protocolOf(key) {
  return state.protocols.find((p) => p.key === key) || null;
}
/** 模型按「模型名@来源」索引：同一个 gpt-image-2 在两个来源上参数完全不同 */
function modelInfo(name, provider) {
  const prov = provider || (state.config && state.config.provider) || 'agg';
  return state.models[`${name}@${prov}`] || null;
}
/** 该来源下可选的模型 */
function modelsFor(providerKey) {
  return Object.values(state.models).filter((m) => m.provider === providerKey);
}

/** 协议下拉只列当前来源支持的协议 */
function renderProtocolOptions(providerKey, current) {
  const sel = $('#cfgProtocol');
  const list = state.protocols.filter((p) => p.provider === providerKey);
  sel.innerHTML = '';
  list.forEach((p) => {
    const o = document.createElement('option');
    o.value = p.key;
    o.textContent = p.label + (p.async ? '（异步轮询）' : '（同步）');
    sel.appendChild(o);
  });
  const keep = list.some((p) => p.key === current) ? current : (list[0] && list[0].key);
  if (keep) sel.value = keep;
  return keep;
}

/** 某个来源下可选的模型（按当前协议把推荐款排前面） */
function modelNamesFor(providerKey, protocolKey) {
  const list = modelsFor(providerKey);
  const score = (m) => {
    if (!protocolKey) return 0;
    return m.defaultProtocol === protocolKey ? 0 : (m.protocols || []).includes(protocolKey) ? 1 : 2;
  };
  list.sort((a, b) => score(a) - score(b) || a.name.localeCompare(b.name));
  return list;
}

/* ------------------------------------------- 模型：顶部栏那一个下拉 */

// 只有一个挂载点（顶部栏）。生图和批量共用同一套模型配置。
const MODEL_MENUS = [];

function mountModelMenu(key) {
  const btn = document.getElementById('mmBtn' + key);
  const pop = document.getElementById('mmPop' + key);
  if (!btn || !pop) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const willOpen = pop.hidden;
    closeAllModelMenus();
    closePillPops();
    pop.hidden = !willOpen;
    btn.setAttribute('aria-expanded', String(willOpen));
    if (willOpen) renderModelMenu(pop);
  });
  pop.addEventListener('click', (e) => e.stopPropagation());
  MODEL_MENUS.push({ key, btn, pop });
}

function closeAllModelMenus() {
  MODEL_MENUS.forEach((m) => {
    m.pop.hidden = true;
    m.btn.setAttribute('aria-expanded', 'false');
  });
}

/*
 * 模型胶囊的落点：
 *   窗口 >720px —— 挪进输入框那排胶囊（.pills），贴在「数量」胶囊右边；
 *   窗口 ≤720px —— 留在顶部栏，行为和以前一样。
 * 断点必须和 style.css 里那条 @media (max-width: 720px) 对齐，
 * 否则会出现「样式按窄屏排、胶囊却被挪走了」的错位。
 * 顶部栏中间那列挪空后宽度归零，左右两列各占 1fr，中线不会歪。
 */
const NARROW_VIEWPORT = window.matchMedia('(max-width: 720px)');

function placeModelMenu() {
  const menu = $('#modelMenuTop');
  const home = $('#topbarMid');
  const pills = $('#pills');
  if (!menu || !home || !pills) return;
  const target = NARROW_VIEWPORT.matches ? home : pills;
  if (menu.parentElement === target) return;
  // 挪家途中弹层还挂在旧坐标上，先收掉；appendChild 只搬节点，按钮/弹层上的监听都跟着走
  closeAllModelMenus();
  target.appendChild(menu);
}

NARROW_VIEWPORT.addEventListener('change', placeModelMenu);
placeModelMenu();

document.addEventListener('click', closeAllModelMenus);
document.addEventListener('click', closeRetryMenu); // 点别处收掉重试菜单
// 重试菜单挂在 body 上，位置是按按钮当场的坐标算的：页面一滚就错位，直接收掉。
// 捕获阶段才能收到内层滚动容器（.chat-scroll）的 scroll。
window.addEventListener('scroll', onAnyScroll, true);
window.addEventListener('resize', closeRetryMenu);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  closeAllModelMenus();
  closeRetryMenu();
  closePillPops();
  toggleAddMenu(false);
});

/** 只列「名称 · 来源」，多余的说明一律不放 —— 顶部栏要的是能扫一眼 */
function renderModelMenu(pop) {
  const cfg = state.config || {};
  pop.innerHTML = '';
  (state.quickModels || []).forEach((q) => {
    const on = cfg.provider === q.provider && cfg.model === q.model && cfg.protocol === q.protocol;
    const it = document.createElement('button');
    it.type = 'button';
    it.className = 'mm-item' + (on ? ' is-active' : '');
    it.innerHTML =
      `<span class="mm-i-name">${escapeHtml(q.display || q.model)}</span>` +
      `<span class="mm-i-src">${escapeHtml(q.providerLabel)}</span>`;
    it.addEventListener('click', () => {
      closeAllModelMenus();
      switchModel(q);
    });
    pop.appendChild(it);
  });
  const foot = document.createElement('button');
  foot.type = 'button';
  foot.className = 'mm-item mm-foot';
  foot.textContent = '更多模型 / 换接口…';
  foot.addEventListener('click', () => {
    closeAllModelMenus();
    openSettings();
  });
  pop.appendChild(foot);
}

function menuSectionTitle(text) {
  const el = document.createElement('div');
  el.className = 'mm-title';
  el.textContent = text;
  return el;
}

/** 按钮上只显示模型名，来源与协议挂在 title 里（顶部栏要的是能扫一眼） */
function refreshModelMenus() {
  const cfg = state.config || {};
  const proto = protocolOf(cfg.protocol);
  const prov = (state.config && providerOf(cfg.provider)) || null;
  const full = `${prov ? prov.label + ' · ' : ''}${cfg.model || '—'}${proto ? ' · ' + proto.label : ''}`;
  MODEL_MENUS.forEach((m) => {
    const v = document.getElementById('mmValue' + m.key);
    if (v) v.textContent = cfg.model || '选择模型';
    m.btn.title = `当前：${full}\n点这里换模型`;
  });
}

/** 切换模型：同步写入服务端配置，并让设置面板、参数预览、参考图上限全部跟着变 */
async function switchModel(q) {
  const cur = String((state.config || {}).baseUrl || '').replace(/\/+$/, '');
  const prov = providerOf(q.provider);
  const curOwner = providerByBaseUrl(cur);
  const patch = { provider: q.provider, protocol: q.protocol, model: q.model };
  // 换来源要连带换地址，否则新来源的路径会打到旧域名上 404。
  // 但只纠正「明确属于另一个来源」的地址 —— 用户自填的中转地址（不认识）原样保留，
  // 否则点一下模型菜单就把中转配置点没了。
  if (prov && (!cur || (curOwner && curOwner.key !== q.provider))) {
    patch.baseUrl = prov.baseUrl;
  }
  const r = await api('/api/config', patch);
  if (!r.ok) return toast('切换失败：' + (r.error || '未知错误'), 'err');
  // applyConfig 里会把失效的胶囊选择按新模型重算（ALAPI 的 2k/4k 保留，
  // 只有真的选了它不支持的档位才降），这里只报一句切到哪了
  applyConfig(r.config);
  toast(`已切到 ${q.providerLabel} · ${q.display || q.model}`, 'ok');
}

/** 配置更新后把各处 UI 拉齐（换模型 / 换协议都要走这里） */
function applyConfig(cfg) {
  state.config = cfg;
  state.keys = { agg: cfg.apiKey || '', alapi: cfg.alapiKey || '' };
  fillSettings(cfg);
  refreshModelMenus();
  updateConnPill(cfg);
  renderRefs();
  // 新模型的参数表和旧的可能完全不一样（比如从 banana-2 换到 tt-image-2，
  // 「比例 + 分辨率」会变成「像素尺寸 + 画质」）：失效的取值清掉、必填的补默认，
  // 再把整条胶囊按新表重建
  normalizePicks(false);
  normalizePicks(true);
  savePicks();
  syncComposer();
}

/** 模型下拉候选 */
function renderModelOptions(providerKey, protocolKey, current) {
  const list = $('#modelOptions');
  list.innerHTML = '';
  const items = modelNamesFor(providerKey, protocolKey);
  const names = items.map((m) => m.name);
  items.forEach((m) => {
    const o = document.createElement('option');
    o.value = m.name;
    o.label = m.display + (m.defaultProtocol === protocolKey ? ' · 推荐' : '');
    list.appendChild(o);
  });
  if (current && !names.includes(current)) {
    const o = document.createElement('option');
    o.value = current;
    o.label = '自定义模型（不在内置表里）';
    list.appendChild(o);
  }
  return names;
}

/** Key 输入框跟随来源：聚合引擎用 apiKey，ALAPI 用 token */
function syncKeyField(providerKey, cfg) {
  const p = providerOf(providerKey);
  if (!p) return;
  const field = p.keyField;
  $('#cfgApiKey').value = state.keys[field] != null ? state.keys[field] : cfg[field] || '';
  $('#keyHint').textContent = `存在本机 config.json 的 ${field} 字段。${p.keyHint || ''}`;
}

function updateSettingsHints() {
  const provKey = $('#cfgProvider').value;
  const protoKey = $('#cfgProtocol').value;
  const prov = providerOf(provKey);
  const proto = protocolOf(protoKey);
  const model = $('#cfgModel').value.trim();

  $('#providerHint').textContent = prov ? `文档：${prov.docUrl}` : '';
  $('#protocolHint').textContent = proto ? proto.note : '';

  const m = modelInfo(model, provKey);
  if (m) {
    const refs = m.maxRefs ? `，参考图上限 ${m.maxRefs} 张` : '，不支持参考图';
    const params = m.params.filter((p) => p.name !== 'n').map((p) => p.name + (p.required ? '*' : ''));
    $('#modelHint').textContent =
      `${m.display}${refs}。该模型参数：${params.join('、') || '无'}（带 * 为必填）。输入框下面那几颗胶囊就是按这份参数表生成的，选了原样发给上游。` +
      (m.note ? '。' + m.note : '');
  } else if (model) {
    $('#modelHint').textContent = '不在内置模型表里，将按当前协议直接提交；胶囊暂时按平台通用档位（比例 / 分辨率）显示。';
  } else {
    $('#modelHint').textContent = '可直接输入模型名，也可以从下拉里选。';
  }

  const base = $('#cfgBaseUrl').value.trim();
  if (prov) {
    const others = [];
    state.providers.forEach((o) => {
      if (o.key === prov.key) return;
      const list = [o.baseUrl, ...(o.baseUrlAliases || [])].map((u) => u.replace(/\/+$/, ''));
      if (list.includes(base.replace(/\/+$/, ''))) others.push(o.label);
    });
    if (others.length) {
      $('#baseUrlHint').textContent = `⚠ 这是「${others.join('、')}」的地址，请求会打到错误的域名上导致 404，请改用 ${prov.baseUrl}`;
      $('#baseUrlHint').classList.add('is-warn');
    } else {
      const aliases = prov.baseUrlAliases || [];
      const isKnown = base === prov.baseUrl || aliases.includes(base.replace(/\/+$/, ''));
      $('#baseUrlHint').textContent = aliases.length > 1
        ? `同一平台的备用域名：${aliases.join('、')}${isKnown ? '' : '；当前填的是自定义地址'}`
        : `默认：${prov.baseUrl}${isKnown ? '' : '；当前填的是自定义地址'}`;
      $('#baseUrlHint').classList.remove('is-warn');
    }
  } else {
    $('#baseUrlHint').textContent = '';
    $('#baseUrlHint').classList.remove('is-warn');
  }

  // 用当前下拉里的来源取模型信息：不带 provKey 会按「已保存的配置」查，
  // 下拉改了还没保存时提示的上限就是错的（上限现在只在选择文件超限时才提示）
}

function fillSettings(cfg) {
  state.keys = { agg: cfg.apiKey || '', alapi: cfg.alapiKey || '' };

  const provSel = $('#cfgProvider');
  provSel.innerHTML = '';
  state.providers.forEach((p) => {
    const o = document.createElement('option');
    o.value = p.key;
    o.textContent = p.label + ' · ' + p.baseUrl.replace(/^https?:\/\//, '');
    provSel.appendChild(o);
  });
  provSel.value = state.providers.some((p) => p.key === cfg.provider) ? cfg.provider : state.providers[0].key;

  const protoKey = renderProtocolOptions(provSel.value, cfg.protocol);
  renderModelOptions(provSel.value, protoKey, cfg.model || 'banana-2');
  syncKeyField(provSel.value, cfg);

  $('#cfgBaseUrl').value = cfg.baseUrl || '';
  $('#cfgModel').value = cfg.model || '';
  $('#cfgOptimizerModel').value = cfg.optimizerModel || 'gem-3.8-flash';
  $('#cfgOptimizerProtocol').value = cfg.optimizerProtocol || 'auto';
  $('#cfgGeminiPath').value = cfg.geminiPath || '';
  $('#cfgAuthStyle').value = cfg.authStyle || 'both';
  $('#cfgImageFirst').value = cfg.imageFirst === false ? '0' : '1';
  $('#cfgTimeout').value = cfg.timeoutSec || 300;
  $('#cfgRetries').value = cfg.maxRetries ?? 2;
  $('#cfgOpenaiPath').value = cfg.openaiPath || '';
  $('#cfgOpenaiEditPath').value = cfg.openaiEditPath || '';
  $('#cfgMediaPath').value = cfg.mediaPath || '';
  $('#cfgMediaStatusPath').value = cfg.mediaStatusPath || '';
  $('#cfgAlapiPath').value = cfg.alapiPath || '';
  $('#cfgAlapiAsyncPath').value = cfg.alapiAsyncPath || '';
  $('#cfgAlapiTaskPath').value = cfg.alapiTaskPath || '';
  $('#cfgOptimizerBaseUrl').value = cfg.optimizerBaseUrl || '';
  $('#cfgPollInterval').value = cfg.pollIntervalSec || 5;
  $('#cfgTaskTimeout').value = cfg.taskTimeoutSec || 900;
  $('#cfgSuffix').value = cfg.suffix || '_修图';
  updateSettingsHints();
  updateConnPill(cfg);
}

$('#cfgProvider').addEventListener('change', () => {
  const provKey = $('#cfgProvider').value;
  const prov = providerOf(provKey);
  if (prov) $('#cfgBaseUrl').value = prov.baseUrl;
  const protoKey = renderProtocolOptions(provKey, '');
  // 换来源后，原来的模型可能不在这个来源下 —— 直接切到该来源的首选模型，
  // 否则会带着一个用不了的模型名去请求
  const names = renderModelOptions(provKey, protoKey, $('#cfgModel').value.trim());
  const cur = $('#cfgModel').value.trim();
  if (cur && !names.includes(cur) && names.length) {
    $('#cfgModel').value = names[0];
    toast(`已把模型切换为 ${names[0]}（原来那个不在这个来源下）`);
  }
  syncKeyField(provKey, state.config || {});
  updateSettingsHints();
  refreshModelMenus();
});
$('#cfgProtocol').addEventListener('change', () => {
  // 协议只改变候选排序，不强行改已填的模型名（可能是用户自己填的自定义模型）
  renderModelOptions($('#cfgProvider').value, $('#cfgProtocol').value, $('#cfgModel').value.trim());
  updateSettingsHints();
});
$('#cfgModel').addEventListener('input', () => {
  updateSettingsHints();
  refreshModelMenus();
});
$('#cfgApiKey').addEventListener('input', () => {
  const p = providerOf($('#cfgProvider').value);
  if (p) state.keys[p.keyField] = $('#cfgApiKey').value;
});
$('#btnResetBaseUrl').addEventListener('click', () => {
  const prov = providerOf($('#cfgProvider').value);
  if (prov) $('#cfgBaseUrl').value = prov.baseUrl;
  updateSettingsHints();
});

/** 顶部栏只在「没填 Key」时出提示，配好了就不占位置 */
function updateConnPill(cfg) {
  const pill = $('#connState');
  const prov = providerOf(cfg && cfg.provider);
  const key = prov ? cfg[prov.keyField] : cfg && cfg.apiKey;
  const hasKey = !!key;
  if (pill) {
    pill.hidden = hasKey;
    pill.className = 'pill ' + (hasKey ? 'pill-ok' : 'pill-bad');
    pill.textContent = hasKey ? '' : '未配置 Key';
  }
  const badge = $('#modelBadge');
  if (badge && cfg && cfg.model) badge.textContent = cfg.model;
}

function openSettings() {
  fillSettings(state.config || {});
  $('#testBox').hidden = true;
  $('#settingsMask').hidden = false;
}
function closeSettings() {
  $('#settingsMask').hidden = true;
}

$('#btnSettings').addEventListener('click', openSettings);
$('#btnCloseSettings').addEventListener('click', closeSettings);
$('#btnCancelSettings').addEventListener('click', closeSettings);
$('#settingsMask').addEventListener('click', (e) => {
  if (e.target === $('#settingsMask')) closeSettings();
});
$('#btnToggleKey').addEventListener('click', () => {
  const input = $('#cfgApiKey');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  $('#btnToggleKey').textContent = show ? '隐藏' : '显示';
});

function collectSettings() {
  const provider = $('#cfgProvider').value || 'agg';
  const p = providerOf(provider);
  const patch = {
    provider,
    baseUrl: $('#cfgBaseUrl').value.trim(),
    model: $('#cfgModel').value.trim() || 'banana-2',
    protocol: $('#cfgProtocol').value,
    optimizerModel: $('#cfgOptimizerModel').value.trim() || 'gem-3.8-flash',
    optimizerProtocol: $('#cfgOptimizerProtocol').value,
    geminiPath: $('#cfgGeminiPath').value.trim(),
    authStyle: $('#cfgAuthStyle').value,
    imageFirst: $('#cfgImageFirst').value === '1',
    timeoutSec: Number($('#cfgTimeout').value) || 300,
    maxRetries: Number($('#cfgRetries').value) || 0,
    openaiPath: $('#cfgOpenaiPath').value.trim(),
    openaiEditPath: $('#cfgOpenaiEditPath').value.trim(),
    mediaPath: $('#cfgMediaPath').value.trim(),
    mediaStatusPath: $('#cfgMediaStatusPath').value.trim(),
    alapiPath: $('#cfgAlapiPath').value.trim(),
    alapiAsyncPath: $('#cfgAlapiAsyncPath').value.trim(),
    alapiTaskPath: $('#cfgAlapiTaskPath').value.trim(),
    optimizerBaseUrl: $('#cfgOptimizerBaseUrl').value.trim(),
    pollIntervalSec: Number($('#cfgPollInterval').value) || 5,
    taskTimeoutSec: Number($('#cfgTaskTimeout').value) || 900,
    suffix: $('#cfgSuffix').value.trim() || '_修图'
  };
  // 两个 Key 都带上，来源切换不会把另一个抹掉
  patch.apiKey = state.keys.agg != null ? state.keys.agg : (state.config && state.config.apiKey) || '';
  patch.alapiKey = state.keys.alapi != null ? state.keys.alapi : (state.config && state.config.alapiKey) || '';
  if (p) patch[p.keyField] = $('#cfgApiKey').value.trim();
  return patch;
}

$('#btnSaveSettings').addEventListener('click', async () => {
  const patch = collectSettings();
  const r = await api('/api/config', patch);
  if (!r.ok) return toast(r.error || '保存失败', 'err');
  applyConfig(r.config);
  closeSettings();
  toast('设置已保存', 'ok');
});

$('#btnTest').addEventListener('click', async () => {
  const box = $('#testBox');
  box.hidden = false;
  box.className = 'test-box';
  box.textContent = '正在请求模型…（同步协议等结果，异步协议会轮询到出图，最长可能几分钟）';
  const t0 = Date.now();
  try {
    const r = await api('/api/test', Object.assign(collectSettings(), paramPayload(false)));
    box.className = 'test-box ' + (r.ok ? 'ok' : 'err');
    const head = `${r.provider || ''} ${r.protocol || ''} · ${r.model || ''}`.trim();
    // 参数被降级过（ALAPI 的 2k/4k 出不了 → 退回 1k）时，这一行必须露出来，
    // 否则「测试连接」成功会让人以为发出去的真是自己选的那一档
    const extra = (r.notes || []).length ? '\n' + r.notes.map((n) => '· ' + n).join('\n') : '';
    box.textContent = r.ok
      ? `✓ ${r.message} · ${head}\n${r.url || ''}\n耗时 ${fmtMs(Date.now() - t0)}${extra}${r.text ? '\n模型附言：' + r.text : ''}`
      : `✗ ${r.message}${head ? '\n' + head : ''}${r.url ? '\n' + r.url : ''}${r.params ? '\n已发参数：' + JSON.stringify(r.params) : ''}${extra}`;
  } catch (e) {
    box.className = 'test-box err';
    box.textContent = '✗ ' + e.message;
  }
});

/* 设置窗口里跳转到两家接口平台：充值 / 查 Key / 看文档 */
function openExternal(url) {
  const w = window.open(url, '_blank', 'noopener,noreferrer');
  if (!w) toast('浏览器拦截了新窗口，请手动访问 ' + url, 'err');
}
$('#btnOpenAgg').addEventListener('click', () => openExternal('https://jc.lk888.ai'));
$('#btnOpenAlapi').addEventListener('click', () => openExternal('https://www.alapi.cn'));


/* ============================================================
   图片查看器：滚轮缩放、拖拽平移、左右切换、下载、顺手标注
   ============================================================ */

// px/py：本次按下的起点（算滑动位移用）；sx/sy：拖拽平移的基准（含当前偏移）
const viewerState = { list: [], idx: 0, scale: 1, tx: 0, ty: 0, dragging: false, sx: 0, sy: 0, px: 0, py: 0 };

function applyViewerTransform() {
  $('#viewerImg').style.transform = `translate(${viewerState.tx}px, ${viewerState.ty}px) scale(${viewerState.scale})`;
  $('#viewerZoom').textContent = Math.round(viewerState.scale * 100) + '%';
}

/**
 * 查看器的翻页范围 = **当前这条对话里所有能看的图**，不是打开时那一组。
 * 顺序完全跟着屏幕走（按 DOM 顺序读 [data-full]）：
 *   用户气泡的参考图 → AI 气泡的结果图 → 批量气泡的结果图（含没画成缩略图的那部分）。
 * 批量明细行里的「原图 ↔ 结果」是行级的 A/B 对比，不参与这里的翻页。
 * 清单是每次打开查看器时现算的，所以新出的图会自动进来，删记录后也不会留下幽灵。
 */
function convImageList() {
  const host = $('#chatList');
  if (!host) return [];
  const out = [];
  const seen = new Set();
  const push = (u) => {
    if (!u || seen.has(u)) return;
    seen.add(u);
    out.push(u);
  };
  host.querySelectorAll('img[data-full], [data-more-fulls]').forEach((el) => {
    if (el.dataset.moreFulls) {
      try {
        JSON.parse(el.dataset.moreFulls).forEach(push);
      } catch (e) {
        /* 清单坏了就当没有这一批，不影响其它图 */
      }
    } else {
      push(el.dataset.full);
    }
  });
  return out;
}

/** 点了某张图 → 在整个对话的范围里打开它，并定位到它那一张 */
function openViewerInConv(full) {
  const list = convImageList();
  const i = list.indexOf(full);
  if (!list.length || i < 0) return openViewer([full], 0);
  openViewer(list, i);
}

function renderViewer() {
  const url = viewerState.list[viewerState.idx];
  $('#viewerImg').src = url;
  $('#viewerName').textContent = `${viewerState.idx + 1} / ${viewerState.list.length}`;
  $('#viewerName').title = viewerState.list.length > 1 ? '本对话的图，用 ← → 或左右按钮切换' : '';
  const dl = $('#viewerDownload');
  dl.href = url;
  dl.download = `AI_IMG_HUB_${viewerState.idx + 1}.png`;
  const many = viewerState.list.length > 1;
  $('#viewerPrev').hidden = !many;
  $('#viewerNext').hidden = !many;
  applyViewerTransform();
}

function openViewer(list, idx) {
  const urls = (list || []).filter(Boolean);
  if (!urls.length) return;
  viewerState.list = urls;
  viewerState.idx = Math.max(0, Math.min(urls.length - 1, Number(idx) || 0));
  viewerState.scale = 1;
  viewerState.tx = 0;
  viewerState.ty = 0;
  $('#imageViewer').hidden = false;
  renderViewer();
}

function closeViewer() {
  $('#imageViewer').hidden = true;
  $('#viewerImg').src = '';
}

function stepViewer(d) {
  if (viewerState.list.length < 2) return;
  viewerState.idx = (viewerState.idx + d + viewerState.list.length) % viewerState.list.length;
  viewerState.scale = 1;
  viewerState.tx = 0;
  viewerState.ty = 0;
  renderViewer();
}

function zoomViewer(factor) {
  viewerState.scale = Math.max(0.15, Math.min(8, viewerState.scale * factor));
  applyViewerTransform();
}

(function initViewer() {
  $('#viewerClose').addEventListener('click', closeViewer);
  $('#viewerPrev').addEventListener('click', () => stepViewer(-1));
  $('#viewerNext').addEventListener('click', () => stepViewer(1));
  $('#viewerZoomIn').addEventListener('click', () => zoomViewer(1.25));
  $('#viewerZoomOut').addEventListener('click', () => zoomViewer(1 / 1.25));
  $('#viewerReset').addEventListener('click', () => {
    viewerState.scale = 1;
    viewerState.tx = 0;
    viewerState.ty = 0;
    applyViewerTransform();
  });
  $('#viewerAnnotate').addEventListener('click', () => {
    const url = viewerState.list[viewerState.idx];
    if (!url) return;
    openDoodle(url, (dataUrl) => {
      useDataUrlAsRef(dataUrl, '标注图');
      closeViewer();
    });
  });

  const stage = $('#viewerStage');
  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      zoomViewer(e.deltaY < 0 ? 1.15 : 1 / 1.15);
    },
    { passive: false }
  );
  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    viewerState.dragging = true;
    viewerState.sx = e.clientX - viewerState.tx;
    viewerState.sy = e.clientY - viewerState.ty;
    viewerState.px = e.clientX;
    viewerState.py = e.clientY;
    stage.classList.add('is-drag');
  });
  stage.addEventListener('pointermove', (e) => {
    if (!viewerState.dragging) return;
    viewerState.tx = e.clientX - viewerState.sx;
    viewerState.ty = e.clientY - viewerState.sy;
    applyViewerTransform();
  });
  stage.addEventListener('pointerup', (e) => {
    if (!viewerState.dragging) return;
    viewerState.dragging = false;
    stage.classList.remove('is-drag');
    /**
     * 位移一律用「起点 → 终点」算，不累加 movementX：
     * 触摸屏上 pointermove 的 movementX 经常是 0，累加出来的位移永远是 0，
     * 于是一次滑动会被当成「点了一下空白」，查看器直接关掉。
     */
    const dx = e.clientX - viewerState.px;
    const dy = e.clientY - viewerState.py;
    const moved = Math.abs(dx) + Math.abs(dy);
    /**
     * 没放大时的横向滑动 = 上一张 / 下一张。
     * 图片是原尺寸（scale 1）时拖不动、也不需要拖，这个手势空着也是空着；
     * 放大之后横向拖动是平移，不能被抢走。
     */
    if (viewerState.scale <= 1.01 && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      return stepViewer(dx < 0 ? 1 : -1);
    }
    // 没放大时图不会超出窗口，拖拽本就没有意义，松手让它回原位（没到切图阈值的那些）
    if (viewerState.scale <= 1.01 && (viewerState.tx || viewerState.ty)) {
      viewerState.tx = 0;
      viewerState.ty = 0;
      applyViewerTransform();
    }
    // 没拖动就是「点了一下空白」——关掉
    if (moved < 5 && e.target === stage) closeViewer();
  });
  // 触摸被系统打断（来电、手势返回）时只清状态，不当成一次点击
  stage.addEventListener('pointercancel', () => {
    viewerState.dragging = false;
    stage.classList.remove('is-drag');
  });
  stage.addEventListener('dblclick', () => {
    viewerState.scale = viewerState.scale > 1 ? 1 : 2;
    viewerState.tx = 0;
    viewerState.ty = 0;
    applyViewerTransform();
  });
  document.addEventListener('keydown', (e) => {
    if ($('#imageViewer').hidden) return;
    if (e.key === 'Escape') closeViewer();
    else if (e.key === 'ArrowLeft') stepViewer(-1);
    else if (e.key === 'ArrowRight') stepViewer(1);
    else if (e.key === '+' || e.key === '=') zoomViewer(1.25);
    else if (e.key === '-') zoomViewer(1 / 1.25);
  });
})();

/* ============================================================
   涂鸦标注：画笔 / 矩形 / 文字，完成后作为参考图送回输入框

   性能是这块的主线：**画的时候只往画布上补「这一小段」**，绝不整张重画。
   底图动辄 2000+ 像素，整张重画一次就是 clearRect + drawImage + 重放全部笔画，
   几十 MB 的像素搬运，表现就是笔迹怎么都追不上鼠标（而且笔画越多越卡）。
   整张重画只在开局 / 撤销 / 清空这类低频时刻发生。

   矩形也一样：拖动时只用一层 CSS 方框做预览，落笔了才真正画到画布上。
   组织方式参考 000.html（dCtx.lineTo + stroke 的增量画法）。
   ============================================================ */

/** 画布最长边上限。涂鸦结果是拿去当参考图的，2560 足够，
    再大只会拖慢「完成」时的 toDataURL 和上传体积。 */
const DOODLE_MAX_SIDE = 2560;

const doodle = {
  img: null,
  tool: 'brush',
  color: '#ff0000',
  size: 5,
  opacity: 1,
  fill: false,
  ops: [],
  drawing: false,
  last: null, // 画笔上一个点（增量连线用）
  startClient: null, // 矩形起点（视口坐标，给预览方框用）
  zoom: 1, // 显示倍数，1 = 画布 100%（不是「适应窗口」，读数要如实）
  fitScale: 1, // 适应窗口时的倍数，开局和点「适应」用
  space: false, // 空格按住 = 平移模式
  panning: false,
  panFrom: null,
  onSave: null
};

function doodleCanvas() {
  return $('#doodleCanvas');
}
function doodleCtx() {
  return doodleCanvas().getContext('2d');
}

/**
 * 画布像素 / 屏幕像素 的比值。
 * 滑杆上的「粗细」「文字大小」一律按**屏幕**像素算（跟 000.html 一致），
 * 否则同一档粗细在 4000px 的图上会细得看不见。
 */
function doodleScale() {
  const cv = doodleCanvas();
  const r = cv.getBoundingClientRect();
  return r.width ? cv.width / r.width : 1;
}

/* ---- 缩放 / 平移 ----------------------------------------------------
   画布最长边可以到 2560，铺满窗口时往往只有 40% 显示 —— 想标细节就得放大。
   做法跟 000.html 一致：滚轮在画布上缩放（以光标为锚点）、按住空格拖拽平移。
   读数如实显示，100% = 画布原始像素，不玩「100% 其实是适应窗口」那种花样。
   ------------------------------------------------------------------- */

const DOODLE_MIN_ZOOM = 0.05;
const DOODLE_MAX_ZOOM = 8;

/** 铺满窗口需要的倍数（不放大小图，跟 000.html 一样最多到 1） */
function doodleFitScale() {
  const cv = doodleCanvas();
  const stage = $('#doodleStage');
  if (!cv.width || !cv.height || !stage) return 1;
  const w = stage.clientWidth - 32; // 减掉 .doodle-stage 的 padding
  const h = stage.clientHeight - 32;
  if (w <= 0 || h <= 0) return 1; // 还没布局出来，先按 100% 摆着
  return Math.min(1, w / cv.width, h / cv.height);
}

function applyDoodleScale() {
  const cv = doodleCanvas();
  cv.style.width = Math.round(cv.width * doodle.zoom) + 'px';
  cv.style.height = Math.round(cv.height * doodle.zoom) + 'px';
  const txt = $('#doodleZoomTxt');
  if (txt) txt.textContent = Math.round(doodle.zoom * 100) + '%';
}

/**
 * 以某个屏幕点为锚点缩放：缩完让「光标底下那个点」还停在原来的屏幕位置。
 * 直接乘 zoom 的话，放大时光标下的内容会往右下跑，手感很差。
 */
function doodleZoomAt(clientX, clientY, factor) {
  const cv = doodleCanvas();
  const stage = $('#doodleStage');
  const before = cv.getBoundingClientRect();
  const next = Math.max(DOODLE_MIN_ZOOM, Math.min(DOODLE_MAX_ZOOM, doodle.zoom * factor));
  if (Math.abs(next - doodle.zoom) < 1e-4) return;
  const rx = before.width ? (clientX - before.left) / before.width : 0.5;
  const ry = before.height ? (clientY - before.top) / before.height : 0.5;
  doodle.zoom = next;
  applyDoodleScale();
  const after = cv.getBoundingClientRect();
  stage.scrollLeft += after.left - before.left + rx * (after.width - before.width);
  stage.scrollTop += after.top - before.top + ry * (after.height - before.height);
}

function doodleZoomFit() {
  doodle.fitScale = doodleFitScale();
  doodle.zoom = doodle.fitScale;
  applyDoodleScale();
  const stage = $('#doodleStage');
  stage.scrollLeft = (stage.scrollWidth - stage.clientWidth) / 2;
  stage.scrollTop = (stage.scrollHeight - stage.clientHeight) / 2;
}

function doodleCursor() {
  const cv = doodleCanvas();
  if (doodle.panning) cv.style.cursor = 'grabbing';
  else if (doodle.space) cv.style.cursor = 'grab';
  else cv.style.cursor = doodle.tool === 'text' ? 'text' : 'crosshair';
}

function drawDoodleOp(ctx, op) {
  ctx.save();
  ctx.globalAlpha = op.opacity == null ? 1 : op.opacity;
  ctx.strokeStyle = op.color;
  ctx.fillStyle = op.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (op.tool === 'brush') {
    ctx.lineWidth = op.w;
    ctx.beginPath();
    op.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    if (op.pts.length === 1) ctx.lineTo(op.pts[0].x + 0.1, op.pts[0].y + 0.1);
    ctx.stroke();
  } else if (op.tool === 'rect') {
    ctx.lineWidth = op.w;
    const x = Math.min(op.x1, op.x2);
    const y = Math.min(op.y1, op.y2);
    const w = Math.abs(op.x2 - op.x1);
    const h = Math.abs(op.y2 - op.y1);
    if (op.fill) ctx.fillRect(x, y, w, h);
    else ctx.strokeRect(x, y, w, h);
  } else if (op.tool === 'text') {
    ctx.font = `bold ${Math.max(12, op.font)}px -apple-system, "Microsoft YaHei", sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillText(op.text, op.x, op.y);
  }
  ctx.restore();
}

/** 只重画底图（不含笔画）—— 开局用 */
function paintDoodleBase() {
  const cv = doodleCanvas();
  const ctx = doodleCtx();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (!doodle.img) return;
  // 大图会在这里等比降采样，质量调高一点，别糊
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(doodle.img, 0, 0, cv.width, cv.height);
}

/** 整张重画：只在开局 / 撤销 / 清空时调用，不要放进 pointermove */
function redrawDoodle() {
  paintDoodleBase();
  const ctx = doodleCtx();
  doodle.ops.forEach((op) => drawDoodleOp(ctx, op));
}

function openDoodle(src, onSave) {
  doodle.onSave = onSave || null;
  doodle.ops = [];
  doodle.drawing = false;
  doodle.last = null;
  doodle.startClient = null;
  doodle.space = false;
  doodle.panning = false;
  doodle.panFrom = null;
  hideDoodleRect();
  setDoodleTool('brush');
  $('#doodleMask').hidden = false;
  const img = new Image();
  img.onload = () => {
    const cv = doodleCanvas();
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    // 超过上限就等比降采样：标注线和像素都在同一坐标系里，比例一致就行
    const k = Math.min(1, DOODLE_MAX_SIDE / Math.max(iw, ih));
    cv.width = Math.max(1, Math.round(iw * k));
    cv.height = Math.max(1, Math.round(ih * k));
    doodle.img = img;
    paintDoodleBase();
    // 开局先铺满窗口（大图多半要放大看，这里只是给个合适的起点）
    doodle.fitScale = doodleFitScale();
    doodle.zoom = doodle.fitScale;
    applyDoodleScale();
  };
  img.onerror = () => {
    $('#doodleMask').hidden = true;
    toast('这张图加载失败，没法标注', 'err');
  };
  img.src = src;
}

function closeDoodle() {
  $('#doodleMask').hidden = true;
  hideDoodleRect();
  doodle.img = null;
  doodle.ops = [];
  doodle.last = null;
  doodle.drawing = false;
  doodle.space = false;
  doodle.panning = false;
  doodle.panFrom = null;
}

function setDoodleTool(tool) {
  doodle.tool = tool;
  $$('#doodleMask .doodle-toolbar button[data-tool]').forEach((b) => b.classList.toggle('is-active', b.dataset.tool === tool));
  $('#rectFillWrap').hidden = tool !== 'rect';
  doodleCursor();
}

function doodlePos(e) {
  const cv = doodleCanvas();
  const rect = cv.getBoundingClientRect();
  return {
    x: ((e.clientX - rect.left) / rect.width) * cv.width,
    y: ((e.clientY - rect.top) / rect.height) * cv.height
  };
}

/* ---- 画笔：起笔后每来一个新点只补一小段，不重画 ---- */

/** 每段都重新设一遍样式（5 个属性赋值，几乎不花钱）；
    用 save/restore 反而怕中途漏配对把画布状态带脏 */
function doodleStrokeStyle(ctx, op) {
  ctx.globalAlpha = op.opacity;
  ctx.strokeStyle = op.color;
  ctx.fillStyle = op.color;
  ctx.lineWidth = op.w;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
}

function beginBrush(p) {
  const ctx = doodleCtx();
  const op = {
    tool: 'brush',
    color: doodle.color,
    size: doodle.size,
    opacity: doodle.opacity,
    w: doodle.size * doodleScale(),
    pts: [p]
  };
  doodle.ops.push(op);
  doodleStrokeStyle(ctx, op);
  // 点一下也要留下一个点，不然「点」等于没反应
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(p.x + 0.01, p.y + 0.01);
  ctx.stroke();
  doodle.last = p;
}

function extendBrush(p) {
  const op = doodle.ops[doodle.ops.length - 1];
  if (!op) return;
  const ctx = doodleCtx();
  const a = doodle.last || p;
  doodleStrokeStyle(ctx, op);
  // 每段独立成路径：路径长度不随笔画变长，开销是常数
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(p.x, p.y);
  ctx.stroke();
  op.pts.push(p);
  doodle.last = p;
}

function endBrush() {
  doodle.last = null;
}

/* ---- 矩形：拖动时只动一层 CSS 方框 ---- */

function hexToRgba(hex, alpha) {
  const m = String(hex || '').replace('#', '');
  const s = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  const n = parseInt(s || 'ff0000', 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function hideDoodleRect() {
  const el = $('#doodleRect');
  if (el) el.hidden = true;
}

function showDoodleRect(fromX, fromY, toX, toY) {
  const el = $('#doodleRect');
  if (!el) return;
  el.hidden = false;
  el.style.left = Math.min(fromX, toX) + 'px';
  el.style.top = Math.min(fromY, toY) + 'px';
  el.style.width = Math.abs(toX - fromX) + 'px';
  el.style.height = Math.abs(toY - fromY) + 'px';
  if (doodle.fill) {
    el.classList.add('is-fill');
    el.style.borderColor = 'transparent';
    el.style.background = hexToRgba(doodle.color, Math.min(0.6, doodle.opacity * 0.55));
  } else {
    el.classList.remove('is-fill');
    el.style.background = 'transparent';
    el.style.borderColor = hexToRgba(doodle.color, Math.max(0.4, doodle.opacity));
  }
}

(function initDoodle() {
  $$('#doodleMask .doodle-toolbar button[data-tool]').forEach((b) => b.addEventListener('click', () => setDoodleTool(b.dataset.tool)));
  $('#doodleColor').addEventListener('input', (e) => (doodle.color = e.target.value));
  $('#doodleSize').addEventListener('input', (e) => (doodle.size = Number(e.target.value) || 5));
  $('#doodleOpacity').addEventListener('input', (e) => (doodle.opacity = Number(e.target.value) || 1));
  $('#doodleFill').addEventListener('change', (e) => (doodle.fill = e.target.checked));
  $('#doodleUndo').addEventListener('click', () => {
    doodle.ops.pop();
    redrawDoodle();
  });
  $('#doodleClear').addEventListener('click', () => {
    doodle.ops = [];
    redrawDoodle();
  });
  $('#doodleCancel').addEventListener('click', closeDoodle);
  $('#doodleSave').addEventListener('click', () => {
    const dataUrl = doodleCanvas().toDataURL('image/png');
    const cb = doodle.onSave;
    closeDoodle();
    if (cb) cb(dataUrl);
  });

  const cv = $('#doodleCanvas');
  const stage = $('#doodleStage');

  // 缩放：滚轮（以光标为锚点）+ 工具栏加减 / 适应
  stage.addEventListener(
    'wheel',
    (e) => {
      if (!doodle.img) return;
      e.preventDefault();
      doodleZoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 1 / 1.15 : 1.15);
    },
    { passive: false }
  );
  $('#doodleZoomIn').addEventListener('click', () => {
    const r = stage.getBoundingClientRect();
    doodleZoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.25);
  });
  $('#doodleZoomOut').addEventListener('click', () => {
    const r = stage.getBoundingClientRect();
    doodleZoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.25);
  });
  $('#doodleZoomFit').addEventListener('click', doodleZoomFit);

  // 空格 = 平移模式（跟 000.html 一样），Esc = 取消
  window.addEventListener('keydown', (e) => {
    if ($('#doodleMask').hidden) return;
    if (e.code === 'Space') {
      e.preventDefault();
      if (!doodle.space) {
        doodle.space = true;
        doodleCursor();
      }
    } else if (e.key === 'Escape') {
      closeDoodle();
    }
  });
  window.addEventListener('keyup', (e) => {
    if (e.code !== 'Space' || !doodle.space) return;
    doodle.space = false;
    doodle.panning = false;
    doodle.panFrom = null;
    doodleCursor();
  });
  // 窗口变大变小后，「适应」的倍数要重算
  window.addEventListener('resize', () => {
    if ($('#doodleMask').hidden || !doodle.img) return;
    doodle.fitScale = doodleFitScale();
  });

  cv.addEventListener('pointerdown', (e) => {
    if (!doodle.img || e.button !== 0) return;
    // 空格按住时左键是抓手，不是画笔
    if (doodle.space) {
      doodle.panning = true;
      doodle.panFrom = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop };
      doodleCursor();
      try {
        cv.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      e.preventDefault();
      return;
    }
    const p = doodlePos(e);
    if (doodle.tool === 'text') {
      const text = window.prompt('要写什么字？');
      if (!text) return;
      const font = Math.max(12, doodle.size * 6 * doodleScale());
      const op = { tool: 'text', color: doodle.color, opacity: doodle.opacity, font, x: p.x, y: p.y, text };
      doodle.ops.push(op);
      drawDoodleOp(doodleCtx(), op);
      return;
    }
    e.preventDefault();
    doodle.drawing = true;
    // 指针捕获是锦上添花：某些情况下（合成事件、指针已经抬起）会直接抛错，
    // 不能让它把后面真正画线的代码挡掉 —— 所以状态先置好，捕获单独 try。
    try {
      cv.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    if (doodle.tool === 'brush') {
      beginBrush(p);
    } else {
      doodle.startClient = { x: e.clientX, y: e.clientY };
      showDoodleRect(e.clientX, e.clientY, e.clientX, e.clientY);
    }
  });

  cv.addEventListener('pointermove', (e) => {
    if (doodle.panning && doodle.panFrom) {
      stage.scrollLeft = doodle.panFrom.left - (e.clientX - doodle.panFrom.x);
      stage.scrollTop = doodle.panFrom.top - (e.clientY - doodle.panFrom.y);
      return;
    }
    if (!doodle.drawing) return;
    if (doodle.tool === 'brush') {
      // 高刷鼠标一帧能报好几个点，全部补上，线才顺
      const pts = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
      if (pts && pts.length) pts.forEach((ev) => extendBrush(doodlePos(ev)));
      else extendBrush(doodlePos(e));
      return;
    }
    if (doodle.startClient) showDoodleRect(doodle.startClient.x, doodle.startClient.y, e.clientX, e.clientY);
  });

  ['pointerup', 'pointercancel'].forEach((ev) =>
    cv.addEventListener(ev, (e) => {
      if (doodle.panning) {
        doodle.panning = false;
        doodle.panFrom = null;
        doodleCursor();
        return;
      }
      if (!doodle.drawing) return;
      doodle.drawing = false;
      if (doodle.tool === 'brush') {
        endBrush();
        return;
      }
      const from = doodle.startClient;
      doodle.startClient = null;
      hideDoodleRect();
      if (!from) return;
      // 预览方框用的是视口坐标，落笔时才换算成画布坐标
      const r = cv.getBoundingClientRect();
      const toCanvas = (cx, cy) => ({ x: ((cx - r.left) / r.width) * cv.width, y: ((cy - r.top) / r.height) * cv.height });
      const p0 = toCanvas(from.x, from.y);
      const p1 = toCanvas(e.clientX, e.clientY);
      if (Math.abs(p1.x - p0.x) < 2 && Math.abs(p1.y - p0.y) < 2) return; // 点一下没拖开，不算一个框
      const op = {
        tool: 'rect',
        color: doodle.color,
        opacity: doodle.opacity,
        fill: doodle.fill,
        w: doodle.size * doodleScale(),
        x1: p0.x,
        y1: p0.y,
        x2: p1.x,
        y2: p1.y
      };
      doodle.ops.push(op);
      drawDoodleOp(doodleCtx(), op);
    })
  );
})();

/* ------------------------------------------------------------ 提示词优化 */

let optBusy = false;

/** 「开始优化」跟「采用」是两步：优化进行中两个都不能点；采用只有在右边有内容时才亮 */
function setOptBusy(busy) {
  optBusy = busy;
  const start = $('#btnOptStart');
  start.disabled = busy;
  start.textContent = busy ? '优化中…' : '开始优化';
  $$('#optTask button').forEach((b) => {
    b.disabled = busy;
  });
  syncOptApply();
}

/** 右边有内容才允许「采用」（左右两边都可编辑，手写也能采用） */
function syncOptApply() {
  $('#btnOptApply').disabled = optBusy || !$('#optNewText').value.trim();
}

/* 任务类型：决定系统提示词走哪条分支 */
const OPT_TASK_HINT = {
  t2i: '没有参考图，从零构建完整画面；不会写「保持不变」',
  i2i: '有原图，先锚定原图，再写改什么、保留什么',
  batch: '同一段提示词套用到一整批不同的图，只写通用要求'
};

function setOptTask(task) {
  const t = task === 't2i' || task === 'batch' ? task : 'i2i';
  $$('#optTask button').forEach((b) => b.classList.toggle('is-active', b.dataset.task === t));
  $('#optTaskHint').textContent = OPT_TASK_HINT[t];
  return t;
}

function getOptTask() {
  const hit = $$('#optTask button').find((b) => b.classList.contains('is-active'));
  return hit ? hit.dataset.task : 'i2i';
}

function onOptTextInput() {
  const t = $('#optNewText').value;
  $('#optNewLen').textContent = t.trim() ? t.trim().length + ' 字' : '';
  syncOptApply();
}

function onOptOrigInput() {
  const t = $('#optOrigText').value;
  $('#optOrigLen').textContent = t.trim() ? t.trim().length + ' 字' : '（空，将生成一段通用提示词）';
}

/** 打开弹窗时记住「原文是从哪个输入框拿的」，采用时原样写回去 */
let optSourceEl = null;

/**
 * 打开优化弹窗：只把内容摆好，**不发请求**。
 * 要不要真的调模型，由用户点「开始优化」决定。
 */
function openOptimize() {
  const ta = activePromptEl();
  optSourceEl = ta;
  const isBatch = state.mode === 'batch';
  // 每次打开都按当前状态重设默认值：批量 → batch；单张有参考图 → i2i；单张无参考图 → t2i
  setOptTask(isBatch ? 'batch' : state.single.refs.length ? 'i2i' : 't2i');
  $('#optOrigText').value = ta.value;
  $('#optNewText').value = '';
  onOptOrigInput();
  onOptTextInput();
  $('#optMeta').innerHTML =
    state.config && state.config.apiKey
      ? `点「开始优化」调用 <code>${escapeHtml(state.config.optimizerModel || 'gem-3.8-flash')}</code> 改写左侧原文；左右两侧都能直接编辑。`
      : '<span class="bad">还没填聚合引擎的 API Key</span>，点「开始优化」会先带你去设置。';
  $('#optFoot').textContent = '改完点「采用」，把右边的文字写回输入框。';
  setOptBusy(false);
  closePillPops();
  $('#optMask').hidden = false;
  setTimeout(() => $('#optOrigText').focus(), 0);
}

/** 真正发请求。只有用户点「开始优化」才会走到这里。 */
async function runOptimize() {
  if (optBusy) return;
  const task = getOptTask();
  const isBatch = state.mode === 'batch';
  const raw = $('#optOrigText').value;
  const shown = recordParamsOf(isBatch);
  const ratio = shown.ratio;
  const size = shown.size;

  if (!state.config || !state.config.apiKey) {
    toast('提示词优化用的是聚合引擎的文本模型，请先在设置里填聚合引擎的 API Key', 'err');
    return openSettings();
  }

  closePillPops();
  onOptOrigInput();
  // 先把旧结果留着，等新的回来再替换 —— 失败时不会被清空
  $('#optMeta').innerHTML = `正在调用 <code>${escapeHtml(state.config.optimizerModel || 'gem-3.8-flash')}</code> 改写…`;
  $('#optFoot').textContent = '';
  setOptBusy(true);

  try {
    const r = await api('/api/optimize-prompt', {
      prompt: raw,
      task,
      mode: isBatch ? 'batch' : 'single',
      aspectRatio: ratio,
      imageSize: size
    });
    if (!r.ok) {
      $('#optMeta').innerHTML = '<span class="bad">优化失败</span>';
      $('#optFoot').textContent = r.error;
      toast('优化失败：' + r.error, 'err');
      return;
    }
    $('#optNewText').value = r.text;
    $('#optMeta').innerHTML =
      `模型 <code>${escapeHtml(r.model)}</code> · 协议 <code>${escapeHtml(r.protocol)}</code> · 耗时 ${fmtMs(r.ms)}<br>` +
      `<span class="muted">${escapeHtml(r.url)}</span>`;
    $('#optFoot').textContent = '可以直接在两边编辑，改完点「采用」';
    onOptTextInput();
    toast('优化完成', 'ok');
  } catch (e) {
    $('#optMeta').innerHTML = '<span class="bad">请求异常</span>';
    $('#optFoot').textContent = e.message;
    toast('优化失败：' + e.message, 'err');
  } finally {
    setOptBusy(false);
  }
}

function closeOpt() {
  $('#optMask').hidden = true;
}

$('#btnOptimize').addEventListener('click', () => openOptimize());
$('#btnOptClose').addEventListener('click', closeOpt);
$('#btnOptCancel').addEventListener('click', closeOpt);
$('#optMask').addEventListener('click', (e) => {
  if (e.target === $('#optMask')) closeOpt();
});
$('#btnOptStart').addEventListener('click', () => runOptimize());
$('#optOrigText').addEventListener('input', onOptOrigInput);
$('#optNewText').addEventListener('input', onOptTextInput);
$$('#optTask button').forEach((b) => {
  b.addEventListener('click', () => setOptTask(b.dataset.task));
});

$('#btnOptApply').addEventListener('click', () => {
  const txt = $('#optNewText').value.trim();
  if (!txt) return toast('右边还没有内容，先点「开始优化」或直接在右侧输入', 'err');
  const ta = optSourceEl || activePromptEl();
  ta.value = txt;
  ta.dispatchEvent(new Event('input'));
  closeOpt();
  toast('已采用优化后的提示词', 'ok');
});


/* 诊断详情弹窗已移除：失败原因直接写在批量气泡的明细行里 */

/* ------------------------------------------- 弹窗通用行为（Esc + 焦点管理） */
//
// 原来：4 个弹窗都只能点 ✕ 或遮罩关闭，键盘按 Esc 没反应；
// 打开后焦点还留在背后的页面上，Tab 能一路走到被遮住的按钮。

const MODAL_SELECTORS = ['#optMask', '#settingsMask'];

function visibleModals() {
  return MODAL_SELECTORS.map((s) => $(s)).filter((el) => el && !el.hidden);
}

let currentModal = null;
let lastFocusEl = null;

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = visibleModals();
  if (!open.length) return;
  // 关掉最上面那一层（这几个弹窗关闭都只是把 hidden 置回去）
  open[open.length - 1].hidden = true;
});

function syncModalFocus() {
  const open = visibleModals();
  if (open.length) {
    const top = open[open.length - 1];
    if (top !== currentModal) {
      currentModal = top;
      lastFocusEl = document.activeElement;
      const first = top.querySelector(
        'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (first) first.focus();
    }
  } else if (currentModal) {
    currentModal = null;
    if (lastFocusEl && document.contains(lastFocusEl)) lastFocusEl.focus();
    lastFocusEl = null;
  }
}

const modalObserver = new MutationObserver(syncModalFocus);
MODAL_SELECTORS.forEach((s) => {
  const el = $(s);
  if (el) modalObserver.observe(el, { attributes: true, attributeFilter: ['hidden'] });
});


/* ------------------------------------------------------------ 流式 / 网格 两种视图 */

const ICON_GRID =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M4 4h4v4H4V4zm6 0h4v4h-4V4zM4 10h4v4H4v-4zm6 0h4v4h-4v-4zM4 16h4v4H4v-4zm6 0h4v4h-4v-4zm6-12h4v4h-4V4zm0 6h4v4h-4v-4zm0 6h4v4h-4v-4z"/></svg>';
const ICON_FLOW = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/></svg>';

function applyViewMode() {
  const grid = state.viewMode === 'grid';
  document.body.classList.toggle('card-mode', grid);
  const btn = $('#btnViewMode');
  btn.innerHTML = grid ? ICON_FLOW : ICON_GRID;
  btn.title = grid ? '切换流式视图' : '切换网格视图';
}

$('#btnViewMode').addEventListener('click', () => {
  // 先记下当前视图停在哪，切完再按比例落回去
  scrollMemo[state.viewMode] = currentScrollRatio();
  state.viewMode = state.viewMode === 'grid' ? 'flow' : 'grid';
  saveUiState({ viewMode: state.viewMode, scroll: scrollMemo });
  applyViewMode();
  restoreScrollRatio();
});

/* ------------------------------------------------------------ 侧边栏开关 */

function applySidebar() {
  document.body.classList.toggle('sb-collapsed', !!state.sidebarCollapsed);
  const t = $('#btnSidebarToggle');
  if (t) t.title = state.sidebarCollapsed ? '展开侧边栏' : '收起侧边栏';
}

function setSidebar(collapsed) {
  state.sidebarCollapsed = !!collapsed;
  saveUiState({ sidebarCollapsed: state.sidebarCollapsed });
  applySidebar();
}

const toggleSidebar = () => setSidebar(!state.sidebarCollapsed);
$('#btnSidebarToggle').addEventListener('click', toggleSidebar);
$('#btnSidebarOpen').addEventListener('click', toggleSidebar);

/**
 * 窄屏时侧栏是浮层（带投影、会压住聊天区）。
 * 注意要放过「展开侧栏」那颗按钮：它也在聊天区里，点它会先 toggle 展开，
 * 事件再冒泡到这里又被立刻收起来 —— 表现就是「点图标没反应」。
 */
function sidebarIsOverlay() {
  return window.matchMedia('(max-width: 860px)').matches;
}
function closeSidebarIfOverlay() {
  if (!state.sidebarCollapsed && sidebarIsOverlay()) setSidebar(true);
}
$('#chatMain').addEventListener('click', (e) => {
  if (e.target.closest('#sidebar') || e.target.closest('#btnSidebarOpen')) return;
  closeSidebarIfOverlay();
});
/**
 * 浮层形态下（就是有投影那种），点侧栏里任何一个入口都顺手收起来 ——
 * 用户已经选完了，别让它继续挡着聊天区。
 * 宽屏时侧栏是常驻的一栏（没有投影），点了什么都不收。
 */
$('#sidebar').addEventListener('click', (e) => {
  // 收起键自己会切状态，别在这里再收一次（会变成点了没反应）
  if (e.target.closest('#btnSidebarToggle')) return;
  closeSidebarIfOverlay();
});

/* ------------------------------------------------------------ 确认框 */

/**
 * 一个通用确认框，返回 Promise<boolean>：
 * 确认 = true；取消 / Esc / 点遮罩 = false。
 * 复用设置弹窗那套 .modal-mask / .modal 样式，视觉上是一家的。
 */
function askConfirm({ title = '确认', text = '', okText = '确定', cancelText = '取消', danger = true } = {}) {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    const box = document.createElement('div');
    box.className = 'modal modal-sm';
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-modal', 'true');

    const head = document.createElement('div');
    head.className = 'modal-head';
    const h = document.createElement('h2');
    h.textContent = title;
    head.appendChild(h);

    const body = document.createElement('div');
    body.className = 'modal-body';
    const p = document.createElement('div');
    p.className = 'ask-text';
    p.textContent = text;
    body.appendChild(p);

    const foot = document.createElement('div');
    foot.className = 'modal-foot';
    const spacer = document.createElement('span');
    spacer.className = 'spacer';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-ghost btn-sm';
    cancel.textContent = cancelText;
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = 'btn btn-sm' + (danger ? ' btn-danger' : ' btn-primary');
    ok.textContent = okText;
    foot.append(spacer, cancel, ok);
    box.append(head, body, foot);
    mask.appendChild(box);
    document.body.appendChild(mask);

    const prevFocus = document.activeElement;
    let done = false;
    const finish = (yes) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey, true);
      mask.remove();
      if (prevFocus && prevFocus.isConnected && prevFocus.focus) prevFocus.focus();
      resolve(yes);
    };
    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation(); // 别让别的 Esc 处理也来插一脚
        finish(false);
      } else if (e.key === 'Enter' && document.activeElement === ok) {
        finish(true);
      }
    }
    cancel.addEventListener('click', () => finish(false));
    ok.addEventListener('click', () => finish(true));
    mask.addEventListener('click', (e) => {
      if (e.target === mask) finish(false);
    });
    document.addEventListener('keydown', onKey, true);
    ok.focus();
  });
}

/* ------------------------------------------------------------ 记录：删除 */

/**
 * 删单条记录（AI 气泡右上角那颗 ✕）。
 * 会连磁盘上这条记录的结果图一起删掉，不可恢复，所以走一次二次确认。
 */
async function deleteRecord(rec) {
  if (!rec || !rec.id) return;
  const n = (rec.images || []).length;
  const lines = [`「${convTitleOf(rec.prompt)}」`];
  lines.push(n ? `这条记录和磁盘上的 ${n} 张结果图会被删掉。` : '这条记录会被删掉。');
  lines.push('删除后无法恢复。');

  const yes = await askConfirm({ title: '删除这条记录？', text: lines.join('\n'), okText: '删除' });
  if (!yes) return;

  const r = await api('/api/records/delete', { id: rec.id });
  if (r.ok) {
    state.records = r.records || [];
    renderRecords();
    toast('已删除这条记录', 'ok');
  } else {
    toast(r.error, 'err');
  }
}

/* ------------------------------------------------------------ 对话：删除 */

/** 一条对话里都有些什么（生图记录 / 批量任务 / 还没落盘的生成中） */
function convContents(id) {
  const recs = (state.records || []).filter((r) => convIdOf(r) === id);
  const jobs = (state.batchJobs || []).filter((j) => convIdOf(j) === id);
  const pends = (state.pendingRecords || []).filter((p) => convIdOf(p) === id);
  return { recs, jobs, pends, images: recs.reduce((n, r) => n + (r.images || []).length, 0) };
}

async function deleteConversation(id) {
  if (!id) return;
  const { recs, jobs, pends, images } = convContents(id);
  const isCurrent = id === state.convId;
  if (!recs.length && !jobs.length && !pends.length) {
    // 空对话（刚开还没生成）也能删，就是把它从列表里去掉 —— 直接开一条新的即可
    if (isCurrent) startNewConversation();
    return;
  }

  let label = '这条对话';
  if (id === CONV_LEGACY) label = '早年的对话';
  else if (recs[0]) label = convTitleOf(recs[0].prompt);
  else if (jobs[0]) label = convTitleOf((jobs[0].options || {}).prompt);
  else if (recs.length === 0 && jobs.length === 0) label = '新对话';
  const lines = [];
  if (recs.length) lines.push(`「${label}」里的 ${recs.length} 条生图记录会一并删除，磁盘上的 ${images} 张结果图也会被删掉。`);
  else lines.push(`「${label}」会被删掉。`);
  if (jobs.length) lines.push(`${jobs.length} 个批量任务只删记录，输出文件夹里的图不动。`);
  if (pends.length) lines.push(`正在生成的 ${pends.length} 张也会从列表里去掉，结果不再保留。`);
  lines.push('删除后无法恢复。');

  // 浮层形态先收起来：确认框是居中的，被侧栏压住一半会很难看
  closeSidebarIfOverlay();

  const yes = await askConfirm({ title: '删除这条对话？', text: lines.join('\n'), okText: '删除' });
  if (!yes) return;

  // 这两个接口每次都会回全量列表，顺着删完，最后一次的结果就是最终结果
  for (const r of recs) {
    const res = await api('/api/records/delete', { id: r.id });
    if (res && res.ok) state.records = res.records || [];
    else if (res && res.error) toast(res.error, 'err');
  }
  for (const j of jobs) {
    const res = await api('/api/batch/job/delete', { id: j.id });
    if (res && res.ok) state.batchJobs = (state.batchJobs || []).filter((x) => x.id !== j.id);
    else if (res && res.error) toast(res.error, 'err');
  }

  if (isCurrent) startNewConversation(); // 删的就是当前这条：开一条新的（输入框不动，见 startNewConversation）
  else {
    renderConversations();
    renderRecords();
  }
  toast('已删除这条对话', 'ok');
}

// 两种入口都开新对话：左侧栏那颗主按钮，和顶栏那个铅笔图标
$$('.js-new-chat').forEach((b) => b.addEventListener('click', () => startNewConversation()));

/* ------------------------------------------------------------ 启动 */

async function boot() {
  const ui = loadUiState();
  try {
    const r = await api('/api/bootstrap');
    if (!r.ok) throw new Error(r.error || '初始化失败');
    state.config = r.config;
    state.ratios = r.defaults.aspectRatios;
    state.sizes = r.defaults.imageSizes;
    state.counts = r.defaults.countOptions || [1, 2, 3, 4];
    state.providers = r.providers || [];
    state.protocols = r.protocols || [];
    state.nativeNBlocked = new Set(r.nativeNBlocked || []);
    state.models = r.models || {};
    state.resolutions = r.resolutions || {};
    state.quickModels = r.quickModels || [];
    state.keys = { agg: r.config.apiKey || '', alapi: r.config.alapiKey || '' };
    state.single.count = Math.min(4, Math.max(1, Number(r.config.count) || 1));
    // 胶囊的取值属于界面记忆（服务端不需要它们，不进 config.json）
    const savedPicks = ui.picks || {};
    state.single.picks = Object.assign(emptyPicks(), savedPicks.single || {});
    state.batch.picks = Object.assign(emptyPicks(), savedPicks.batch || {});
    // 老版本的 quality 键（画质胶囊刚上线时的记忆）继续认，升级后不至于丢选择
    const qUI = ui.quality || {};
    if (!state.single.picks.tier && typeof qUI.single === 'string') state.single.picks.tier = qUI.single;
    if (!state.batch.picks.tier && typeof qUI.batch === 'string') state.batch.picks.tier = qUI.batch;
    // 还没选过的角色按当前模型的必填/默认档补齐（换过模型时失效的值也在这里被清掉）
    normalizePicks(false);
    normalizePicks(true);
    state.mode = ui.mode === 'batch' ? 'batch' : 'single';
    state.viewMode = ui.viewMode === 'grid' ? 'grid' : 'flow';
    // 每次打开页面都是新对话（跟 DeepSeek 一样），历史对话在左边栏里点。
    state.convId = newConvId();
    // 侧栏折叠状态：没记过就按窗口宽度定（窄屏默认收起，免得挤掉聊天区）
    state.sidebarCollapsed = ui.sidebarCollapsed == null ? window.innerWidth < 860 : !!ui.sidebarCollapsed;
    applySidebar();
    // 滚动位置的记忆只在本次会话内有效：新对话是空的，把上次的位置带进来没有意义
    scrollMemo.flow = null;
    scrollMemo.grid = null;

    // 顺手把桌面助手预热掉：这样第一次点「选择文件夹」也是秒开
    warmDesktop();

    // 设置面板在启动时就填好，否则「测试连接」读到的来源与协议都是空的
    fillSettings(state.config);
    mountModelMenu('Top');
    refreshModelMenus();
    applyViewMode();

    // 参数胶囊（比例/尺寸、分辨率、画质…）由 syncComposer 里的 renderParamPills() 按模型生成
    buildCountSeg($('#countSegSingle'), state.single.count, (v) => {
      state.single.count = v;
      updateCountHint();
      syncComposer();
      api('/api/config', { count: v }).catch(() => {});
    });
    updateCountHint();

    // 批量这几个勾选项以前存在 config.json 里，但服务端只从请求体读它们，所以固定成默认值
    $('#batchConcurrency').value = r.config.concurrency || 3;
    $('#optRecursive').checked = false;
    $('#optExtra').checked = false;
    $('#optSkip').checked = true;
    $('#optCsv').checked = true;
    $('#optDebug').checked = false;
    $('#optFollowRatio').checked = true;
    updateRatioNote();

    // 提示词属于界面记忆，存在浏览器本地
    $('#singlePrompt').value = ui.singlePrompt || '';
    $('#batchPrompt').value = ui.batchPrompt || ui.prompt || '';
    // 文件夹**不还原**：打开页面输入框一律是干净的（跟参考图一样只在内存里）。
    // 上次跑过的目录留在 ui.lastInputDir，点「选择文件夹」时会从那儿开始。
    $('#batchInput').value = '';
    autoGrow($('#singlePrompt'));
    autoGrow($('#batchPrompt'));

    updateConnPill(state.config);
    renderRefs();
    syncComposer();

    await loadRecords();
    await loadBatchJobs();
    convCacheReady = true; // 从这里开始才允许刷新侧栏缓存
    renderRecords();
    renderConversations();
    connectEvents();
    scrollChatToBottom();

    if (!state.config.apiKey && !state.config.alapiKey) {
      setTimeout(() => toast('首次使用：请点左下角「设置」选择接口来源并填写 Key'), 500);
    }
  } catch (e) {
    toast('初始化失败：' + e.message, 'err');
  }
}

// 先用上次的缓存把侧栏画出来（同步执行），再去拉接口 —— 点刷新不再闪一下空白
restoreConvsFromCache();
boot();
