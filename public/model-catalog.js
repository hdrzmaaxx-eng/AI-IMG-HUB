/* ============================================================================
 * 模型目录 · 只保留实际要用的三个组合
 *   聚合引擎  banana-2 / tt-image-2
 *   ALAPI     gpt-image-2
 *
 * 参数 schema 来源：平台的模型详情接口（2026-10-01 按 jc.lk888.ai/apidoc 复核后固化）
 *   GET https://api.lingkeai.ai/gongkai/apidoc/moxing-xiangqing?mingcheng=<模型名>
 *   GET https://api.lk888.ai/v1/skills/models/<模型名>（带 Key，字段名更贴近实际下发）
 * 固化而不是每次现拉：断网可用，且「测试连接」不必先联网。
 *
 * 注意：聚合引擎的旗舰图像模型在平台上的官方名就是 tt-image-2，
 *   老的 gpt-image-2 是它的别名（GET /v1/skills/models/gpt-image-2 返回的 name
 *   仍然是 tt-image-2，参数表完全一样），本目录统一用官方名。
 *
 * 想用平台上的其他模型？直接往「设置 → 模型」里手输模型名即可，
 * 不在表里的模型按当前协议原样提交，只是比例/分辨率不做自动换算。
 * ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ModelCatalog = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 聚合引擎可选的模型 */
  var ENGINE_MODELS = [
  {
    "name": "banana-2",
    "display": "Banana 2",
    "vendor": "聚合引擎",
    "provider": "agg",
    "defaultProtocol": "gemini",
    "note": "Gemini 系原生协议。参考图权重高，适合保留主体、换背景、精修质感。",
    "paramHints": {
      "aspectRatio": "文档里的 14 个比例都在这儿，比 tt-image-2 多了 1:4 / 4:1 / 1:8 / 8:1 四个超宽档。",
      "imageSize": "清晰度档 0.5K / 1K / 2K / 4K（tt-image-2 没有 0.5K）。文档给的是「每个比例一套像素」：16:9 → 1376×768 / 2752×1536 / 5504×3072，1:1 → 512 / 1024 / 2048 / 4096。档位原样发给上游，本地不换算。",
      "thinkingLevel": "模型的思考深度（minimal / high），不是清晰度；清晰度看「分辨率」那颗胶囊。"
    },
    "protocols": [
      "media",
      "gemini",
      "openai"
    ],
    "params": [
      {
        "name": "aspectRatio",
        "type": "enum",
        "required": true,
        "values": [
          "1:1",
          "2:3",
          "3:2",
          "3:4",
          "4:3",
          "4:5",
          "5:4",
          "9:16",
          "16:9",
          "21:9",
          "1:4",
          "4:1",
          "1:8",
          "8:1"
        ],
        "desc": "Image aspect ratio"
      },
      {
        "name": "imageSize",
        "type": "enum",
        "required": true,
        "values": [
          "0.5K",
          "1K",
          "2K",
          "4K"
        ],
        "desc": "Image clarity"
      },
      {
        "name": "thinkingLevel",
        "type": "enum",
        "required": false,
        "values": [
          "minimal",
          "high"
        ],
        "desc": "Control the model thinking depth"
      }
    ],
    "maxRefs": 14
  },
  {
    "name": "tt-image-2",
    "display": "TT Image 2",
    "vendor": "聚合引擎",
    "provider": "agg",
    "defaultProtocol": "openai",
    "note": "聚合引擎的旗舰图像模型，官方名即 tt-image-2；老的 gpt-image-2 是它的别名，仍可照常传。",
    "paramHints": {
      "size": "文档把比例和清晰度合成 size 一个字段（11 种比例 × 1K/2K/4K，共 33 个像素尺寸；同一档各家像素不一样，1:1 的 4K 是 2880×2880）。界面已按官方选项拆成「比例」「分辨率」两颗胶囊，选完合成官方要求的像素写法提交——文档明确：只传「1K」「16:9」这种档位会报 400。",
      "quality": "出图质量档（auto / high / medium / low）；留「默认」就是 auto。它管的是压缩质量，清晰度看「分辨率」那颗胶囊。"
    },
    "protocols": [
      "media",
      "openai"
    ],
    "params": [
      {
        "name": "size",
        "type": "enum",
        "required": true,
        "values": [
          "auto",
          "1024x1024",
          "1024x1536",
          "1536x1024",
          "960x1280",
          "1280x960",
          "1088x1920",
          "1920x1088",
          "1024x1280",
          "1280x1024",
          "960x1920",
          "1920x960",
          "2048x2048",
          "2048x3072",
          "3072x2048",
          "1920x2560",
          "2560x1920",
          "1440x2560",
          "2560x1440",
          "2048x2560",
          "2560x2048",
          "1280x2560",
          "2560x1280",
          "2880x2880",
          "2336x3456",
          "3456x2336",
          "2400x3200",
          "3200x2400",
          "2160x3840",
          "3840x2160",
          "2560x3200",
          "3200x2560",
          "1920x3840",
          "3840x1920"
        ],
        "optionLabels": {
          "auto": "自适应",
          "1024x1024": "正方形 (1:1)",
          "1024x1536": "竖版 (2:3)",
          "1536x1024": "横版 (3:2)",
          "960x1280": "竖版 (3:4)",
          "1280x960": "横版 (4:3)",
          "1088x1920": "竖版 (9:16)",
          "1920x1088": "横版 (16:9)",
          "1024x1280": "竖版 (4:5)",
          "1280x1024": "横版 (5:4)",
          "960x1920": "竖版 (1:2)",
          "1920x960": "横版 (2:1)",
          "2048x2048": "2K 正方形 (1:1)",
          "2048x3072": "2K 竖版 (2:3)",
          "3072x2048": "2K 横版 (3:2)",
          "1920x2560": "2K 竖版 (3:4)",
          "2560x1920": "2K 横版 (4:3)",
          "1440x2560": "2K 竖版 (9:16)",
          "2560x1440": "2K 横版 (16:9)",
          "2048x2560": "2K 竖版 (4:5)",
          "2560x2048": "2K 横版 (5:4)",
          "1280x2560": "2K 竖版 (1:2)",
          "2560x1280": "2K 横版 (2:1)",
          "2880x2880": "4K 正方形 (1:1)",
          "2336x3456": "4K 竖版 (2:3)",
          "3456x2336": "4K 横版 (3:2)",
          "2400x3200": "4K 竖版 (3:4)",
          "3200x2400": "4K 横版 (4:3)",
          "2160x3840": "4K 竖版 (9:16)",
          "3840x2160": "4K 横版 (16:9)",
          "2560x3200": "4K 竖版 (4:5)",
          "3200x2560": "4K 横版 (5:4)",
          "1920x3840": "4K 竖版 (1:2)",
          "3840x1920": "4K 横版 (2:1)"
        },
        "desc": "Generated image size. Recommended: auto, determined by the model. Note: 2K/4K ti"
      },
      {
        "name": "quality",
        "type": "enum",
        "required": false,
        "values": [
          "auto",
          "high",
          "medium",
          "low"
        ],
        "desc": "Generated image quality. Recommended: auto, determined by the model."
      }
    ],
    "maxRefs": 14
  }
];

  /** ALAPI 可选的模型 */
  var ALAPI_MODELS = [
  {
    "name": "gpt-image-2",
    "display": "GPT Image 2",
    "vendor": "ALAPI",
    "provider": "alapi",
    "defaultProtocol": "alapi_async",
    "note": "ALAPI 独立模型，参数自成一套。官方推荐用异步接口。1k / 2k / 4k 都列着（2k 计 2 次、4k 计 3 次），4k 只有六个超宽 / 宽屏比例支持。",
    "paramHints": {
      "size": "文档里 size 传比例（也接受 1024x1024 这种像素），这里按比例给你选。",
      "resolution": "1k / 2k / 4k，价格不同（2k 计 2 次、4k 计 3 次）。文档的 4k 一栏只有 16:9 / 9:16 / 2:1 / 1:2 / 21:9 / 9:21 六个比例有值，选了别的比例会自动降到 2k；上游若出不了这一档（渠道目前只保证 1k），会逐档往下退重发：4k → 2k → 1k，2k → 1k。"
    },
    "protocols": [
      "alapi_async",
      "alapi"
    ],
    "maxRefs": 10,
    "params": [
      {
        "name": "n",
        "type": "enum",
        "required": false,
        "values": [
          "1",
          "2",
          "3",
          "4"
        ],
        "desc": "同时生成数量，支持 1-4 张"
      },
      {
        "name": "size",
        "type": "enum",
        "required": false,
        "values": [
          "auto",
          "1:1",
          "3:2",
          "2:3",
          "4:3",
          "3:4",
          "5:4",
          "4:5",
          "16:9",
          "9:16",
          "2:1",
          "1:2",
          "21:9",
          "9:21"
        ],
        "desc": "尺寸比例，也可传 1024x1024 这种具体像素"
      },
      {
        "name": "resolution",
        "type": "enum",
        "required": false,
        "values": [
          "1k",
          "2k",
          "4k"
        ],
        "desc": "分辨率，不同分辨率价格不同"
      }
    ]
  }
];

  /* ==========================================================================
   * 「1K / 2K / 4K」到底是多少像素：**三家各不相同，按各自文档固化**
   *
   *   banana-2（聚合引擎）  imageSize = 0.5K / 1K / 2K / 4K
   *                         同一档在不同比例下像素不一样，4K 16:9 是 5504×3072
   *   tt-image-2（聚合引擎）没有 imageSize，清晰度藏在 size 的像素枚举里
   *                         1K / 2K / 4K，4K 16:9 是 3840×2160，且没有 0.5K
   *   gpt-image-2（ALAPI）  resolution = 1k / 2k / 4k（价格不同：2k 计 2 次、4k 计 3 次）
   *                         4k 官方只有 16:9 / 9:16 / 2:1 / 1:2 / 21:9 / 9:21 六个比例支持
   *
   * 字段说明（全部取自官方文档，2026-10-06 逐格复核）：
   *   核对来源：ALAPI gpt-image-2.md / 聚合引擎 tt-image-2.md / 聚合引擎 banana-2.md
   *   三张表共 126 格，已用脚本逐格比对，与本表完全一致。
   *   tt-image-2 的 size 支持自定义尺寸，官方规则：宽高均为 16 的倍数、宽高比在
   *   1:3~3:1 之间、总像素 655360~8294400、单边不超过 3840 —— 本表里的 4K 值
   *   （如 2336×3456 = 8,073,216 px）都在这个范围内，因此能原样下发。
   *   另注：该文档明确 size 只稳定决定宽高比档位，部分价格优先渠道会降采样返回，
   *        真实像素以下载到的图为准；要稳准高清请用 4K 档。
   *   field    档位提交到哪个字段名
   *   tiers    可选档位，从低到高（界面胶囊上的顺序）
   *   ratios   比例 → 该比例支持的档位（不写 = 全支持）；ALAPI 的 4k 就靠这个卡
   *   pixels   比例 → 档位 → 文档给的像素写法（openai / gemini 这类要像素的协议用）
   *   fallback 上游出不了时按什么顺序退（只在请求真的失败时用，见 server.js）
   * ======================================================================== */
  var RESOLUTION = {
    'banana-2@agg': {
      field: 'imageSize',
      tiers: ['0.5K', '1K', '2K', '4K'],
      pixels: {
        '1:1': ['512x512', '1024x1024', '2048x2048', '4096x4096'],
        '2:3': ['424x632', '848x1264', '1696x2528', '3392x5056'],
        '3:2': ['632x424', '1264x848', '2528x1696', '5056x3392'],
        '3:4': ['448x600', '896x1200', '1792x2400', '3584x4800'],
        '4:3': ['600x448', '1200x896', '2400x1792', '4800x3584'],
        '4:5': ['464x576', '928x1152', '1856x2304', '3712x4608'],
        '5:4': ['576x464', '1152x928', '2304x1856', '4608x3712'],
        '9:16': ['384x688', '768x1376', '1536x2752', '3072x5504'],
        '16:9': ['688x384', '1376x768', '2752x1536', '5504x3072'],
        '21:9': ['792x336', '1584x672', '3168x1344', '6336x2688'],
        '1:4': ['256x1024', '512x2048', '1024x4096', '2048x8192'],
        '4:1': ['1024x256', '2048x512', '4096x1024', '8192x2048'],
        '1:8': ['192x1536', '384x3072', '768x6144', '1536x12288'],
        '8:1': ['1536x192', '3072x384', '6144x768', '12288x1536']
      }
    },
    'tt-image-2@agg': {
      field: 'size',
      tiers: ['1K', '2K', '4K'],
      pixels: {
        '1:1': ['1024x1024', '2048x2048', '2880x2880'],
        '2:3': ['1024x1536', '2048x3072', '2336x3456'],
        '3:2': ['1536x1024', '3072x2048', '3456x2336'],
        '3:4': ['960x1280', '1920x2560', '2400x3200'],
        '4:3': ['1280x960', '2560x1920', '3200x2400'],
        '4:5': ['1024x1280', '2048x2560', '2560x3200'],
        '5:4': ['1280x1024', '2560x2048', '3200x2560'],
        '9:16': ['1088x1920', '1440x2560', '2160x3840'],
        '16:9': ['1920x1088', '2560x1440', '3840x2160'],
        '1:2': ['960x1920', '1280x2560', '1920x3840'],
        '2:1': ['1920x960', '2560x1280', '3840x1920']
      }
    },
    'gpt-image-2@alapi': {
      field: 'resolution',
      tiers: ['1k', '2k', '4k'],
      // 文档里 4k 一栏只有这六个比例有值，其它比例标 ❌
      ratios: {
        '1:1': ['1k', '2k'],
        '3:2': ['1k', '2k'],
        '2:3': ['1k', '2k'],
        '4:3': ['1k', '2k'],
        '3:4': ['1k', '2k'],
        '5:4': ['1k', '2k'],
        '4:5': ['1k', '2k'],
        '16:9': ['1k', '2k', '4k'],
        '9:16': ['1k', '2k', '4k'],
        '2:1': ['1k', '2k', '4k'],
        '1:2': ['1k', '2k', '4k'],
        '21:9': ['1k', '2k', '4k'],
        '9:21': ['1k', '2k', '4k']
      },
      pixels: {
        '1:1': { '1k': '1024x1024', '2k': '2048x2048' },
        '3:2': { '1k': '1536x1024', '2k': '2048x1360' },
        '2:3': { '1k': '1024x1536', '2k': '1360x2048' },
        '4:3': { '1k': '1024x768', '2k': '2048x1536' },
        '3:4': { '1k': '768x1024', '2k': '1536x2048' },
        '5:4': { '1k': '1280x1024', '2k': '2560x2048' },
        '4:5': { '1k': '1024x1280', '2k': '2048x2560' },
        '16:9': { '1k': '1536x864', '2k': '2048x1152', '4k': '3840x2160' },
        '9:16': { '1k': '864x1536', '2k': '1152x2048', '4k': '2160x3840' },
        '2:1': { '1k': '2048x1024', '2k': '2688x1344', '4k': '3840x1920' },
        '1:2': { '1k': '1024x2048', '2k': '1344x2688', '4k': '1920x3840' },
        '21:9': { '1k': '2016x864', '2k': '2688x1152', '4k': '3840x1648' },
        '9:21': { '1k': '864x2016', '2k': '1152x2688', '4k': '1648x3840' }
      },
      // 文档：渠道限制，目前只保证 1k 能出 —— 2k / 4k 先照发的，上游说不行就退到 1k
      fallback: ['2k', '1k']
    }
  };

  /** 按「来源 + 模型」索引 */
  var BY_KEY = {
  "banana-2@agg": {
    "name": "banana-2",
    "display": "Banana 2",
    "vendor": "聚合引擎",
    "provider": "agg",
    "defaultProtocol": "gemini",
    "note": "Gemini 系原生协议。参考图权重高，适合保留主体、换背景、精修质感。",
    "paramHints": {
      "aspectRatio": "文档里的 14 个比例都在这儿，比 tt-image-2 多了 1:4 / 4:1 / 1:8 / 8:1 四个超宽档。",
      "imageSize": "清晰度档 0.5K / 1K / 2K / 4K（tt-image-2 没有 0.5K）。文档给的是「每个比例一套像素」：16:9 → 1376×768 / 2752×1536 / 5504×3072，1:1 → 512 / 1024 / 2048 / 4096。档位原样发给上游，本地不换算。",
      "thinkingLevel": "模型的思考深度（minimal / high），不是清晰度；清晰度看「分辨率」那颗胶囊。"
    },
    "protocols": [
      "media",
      "gemini",
      "openai"
    ],
    "params": [
      {
        "name": "aspectRatio",
        "type": "enum",
        "required": true,
        "values": [
          "1:1",
          "2:3",
          "3:2",
          "3:4",
          "4:3",
          "4:5",
          "5:4",
          "9:16",
          "16:9",
          "21:9",
          "1:4",
          "4:1",
          "1:8",
          "8:1"
        ],
        "desc": "Image aspect ratio"
      },
      {
        "name": "imageSize",
        "type": "enum",
        "required": true,
        "values": [
          "0.5K",
          "1K",
          "2K",
          "4K"
        ],
        "desc": "Image clarity"
      },
      {
        "name": "thinkingLevel",
        "type": "enum",
        "required": false,
        "values": [
          "minimal",
          "high"
        ],
        "desc": "Control the model thinking depth"
      }
    ],
    "maxRefs": 14
  },
  "tt-image-2@agg": {
    "name": "tt-image-2",
    "display": "TT Image 2",
    "vendor": "聚合引擎",
    "provider": "agg",
    "defaultProtocol": "openai",
    "note": "聚合引擎的旗舰图像模型，官方名即 tt-image-2；老的 gpt-image-2 是它的别名，仍可照常传。",
    "paramHints": {
      "size": "文档把比例和清晰度合成 size 一个字段（11 种比例 × 1K/2K/4K，共 33 个像素尺寸；同一档各家像素不一样，1:1 的 4K 是 2880×2880）。界面已按官方选项拆成「比例」「分辨率」两颗胶囊，选完合成官方要求的像素写法提交——文档明确：只传「1K」「16:9」这种档位会报 400。",
      "quality": "出图质量档（auto / high / medium / low）；留「默认」就是 auto。它管的是压缩质量，清晰度看「分辨率」那颗胶囊。"
    },
    "protocols": [
      "media",
      "openai"
    ],
    "params": [
      {
        "name": "size",
        "type": "enum",
        "required": true,
        "values": [
          "auto",
          "1024x1024",
          "1024x1536",
          "1536x1024",
          "960x1280",
          "1280x960",
          "1088x1920",
          "1920x1088",
          "1024x1280",
          "1280x1024",
          "960x1920",
          "1920x960",
          "2048x2048",
          "2048x3072",
          "3072x2048",
          "1920x2560",
          "2560x1920",
          "1440x2560",
          "2560x1440",
          "2048x2560",
          "2560x2048",
          "1280x2560",
          "2560x1280",
          "2880x2880",
          "2336x3456",
          "3456x2336",
          "2400x3200",
          "3200x2400",
          "2160x3840",
          "3840x2160",
          "2560x3200",
          "3200x2560",
          "1920x3840",
          "3840x1920"
        ],
        "optionLabels": {
          "auto": "自适应",
          "1024x1024": "正方形 (1:1)",
          "1024x1536": "竖版 (2:3)",
          "1536x1024": "横版 (3:2)",
          "960x1280": "竖版 (3:4)",
          "1280x960": "横版 (4:3)",
          "1088x1920": "竖版 (9:16)",
          "1920x1088": "横版 (16:9)",
          "1024x1280": "竖版 (4:5)",
          "1280x1024": "横版 (5:4)",
          "960x1920": "竖版 (1:2)",
          "1920x960": "横版 (2:1)",
          "2048x2048": "2K 正方形 (1:1)",
          "2048x3072": "2K 竖版 (2:3)",
          "3072x2048": "2K 横版 (3:2)",
          "1920x2560": "2K 竖版 (3:4)",
          "2560x1920": "2K 横版 (4:3)",
          "1440x2560": "2K 竖版 (9:16)",
          "2560x1440": "2K 横版 (16:9)",
          "2048x2560": "2K 竖版 (4:5)",
          "2560x2048": "2K 横版 (5:4)",
          "1280x2560": "2K 竖版 (1:2)",
          "2560x1280": "2K 横版 (2:1)",
          "2880x2880": "4K 正方形 (1:1)",
          "2336x3456": "4K 竖版 (2:3)",
          "3456x2336": "4K 横版 (3:2)",
          "2400x3200": "4K 竖版 (3:4)",
          "3200x2400": "4K 横版 (4:3)",
          "2160x3840": "4K 竖版 (9:16)",
          "3840x2160": "4K 横版 (16:9)",
          "2560x3200": "4K 竖版 (4:5)",
          "3200x2560": "4K 横版 (5:4)",
          "1920x3840": "4K 竖版 (1:2)",
          "3840x1920": "4K 横版 (2:1)"
        },
        "desc": "Generated image size. Recommended: auto, determined by the model. Note: 2K/4K ti"
      },
      {
        "name": "quality",
        "type": "enum",
        "required": false,
        "values": [
          "auto",
          "high",
          "medium",
          "low"
        ],
        "desc": "Generated image quality. Recommended: auto, determined by the model."
      }
    ],
    "maxRefs": 14
  },
  "gpt-image-2@alapi": {
    "name": "gpt-image-2",
    "display": "GPT Image 2",
    "vendor": "ALAPI",
    "provider": "alapi",
    "defaultProtocol": "alapi_async",
    "note": "ALAPI 独立模型，参数自成一套。官方推荐用异步接口。1k / 2k / 4k 都列着（2k 计 2 次、4k 计 3 次），4k 只有六个超宽 / 宽屏比例支持。",
    "paramHints": {
      "size": "文档里 size 传比例（也接受 1024x1024 这种像素），这里按比例给你选。",
      "resolution": "1k / 2k / 4k，价格不同（2k 计 2 次、4k 计 3 次）。文档的 4k 一栏只有 16:9 / 9:16 / 2:1 / 1:2 / 21:9 / 9:21 六个比例有值，选了别的比例会自动降到 2k；上游若出不了这一档（渠道目前只保证 1k），会逐档往下退重发：4k → 2k → 1k，2k → 1k。"
    },
    "protocols": [
      "alapi_async",
      "alapi"
    ],
    "maxRefs": 10,
    "params": [
      {
        "name": "n",
        "type": "enum",
        "required": false,
        "values": [
          "1",
          "2",
          "3",
          "4"
        ],
        "desc": "同时生成数量，支持 1-4 张"
      },
      {
        "name": "size",
        "type": "enum",
        "required": false,
        "values": [
          "auto",
          "1:1",
          "3:2",
          "2:3",
          "4:3",
          "3:4",
          "5:4",
          "4:5",
          "16:9",
          "9:16",
          "2:1",
          "1:2",
          "21:9",
          "9:21"
        ],
        "desc": "尺寸比例，也可传 1024x1024 这种具体像素"
      },
      {
        "name": "resolution",
        "type": "enum",
        "required": false,
        "values": [
          "1k",
          "2k",
          "4k"
        ],
        "desc": "分辨率，不同分辨率价格不同"
      }
    ]
  }
};

  /** 生图页快速切换用的清单：每个模型配一个推荐协议 */
  var QUICK = ENGINE_MODELS.map(function (m) {
    return {
      provider: 'agg', providerLabel: '聚合引擎', protocol: m.defaultProtocol,
      model: m.name, display: m.display, note: m.note,
      maxRefs: m.maxRefs, aliasOf: m.aliasOf || ''
    };
  }).concat(ALAPI_MODELS.map(function (m) {
    return {
      provider: 'alapi', providerLabel: 'ALAPI', protocol: m.defaultProtocol,
      model: m.name, display: m.display, note: m.note,
      maxRefs: m.maxRefs, aliasOf: ''
    };
  }));

  /* ---------------------------------------------------- 分辨率档的工具（服务端 + 前端共用）
   * 三家模型的 1K/2K/4K 不是一个东西：这里都从上面的 RESOLUTION 表里查，
   * 查不到就返回空，由调用方退回原来的通用换算，绝不编造取值。
   */

  /** 该模型的分辨率表（不在表里的模型返回 null） */
  function resTableOf(model, provider) {
    return RESOLUTION[model + '@' + provider] || null;
  }

  /** 比例 × 档位 → 文档给的像素写法（'1024x1024'）；文档没这个组合就返回空串 */
  function pixelOf(key, ratio, tier) {
    var t = RESOLUTION[key];
    if (!t || !t.pixels) return '';
    var row = t.pixels[ratio];
    if (!row) return '';
    if (Array.isArray(row)) {
      var i = t.tiers.indexOf(tier);
      return i < 0 ? '' : row[i] || '';
    }
    return row[tier] || '';
  }

  /** 这个比例允许哪些档位（文档没列比例白名单 → 全支持；比例不在文档里 → 返回空数组） */
  function tiersAt(key, ratio) {
    var t = RESOLUTION[key];
    if (!t) return [];
    if (!t.ratios) return t.tiers.slice();
    return (t.ratios[ratio] || []).slice();
  }

  /** 这个比例能不能用这一档 */
  function tierAllowed(key, ratio, tier) {
    var t = RESOLUTION[key];
    if (!t) return false;
    if (!t.ratios) return t.tiers.indexOf(tier) >= 0;
    var ok = t.ratios[ratio];
    if (!ok) return false;
    return ok.indexOf(tier) >= 0;
  }

  /** 比例固定时，这一档落到文档里真正支持的哪一档（往下退）；没有可用档返回 '' */
  function degradeTier(key, ratio, tier) {
    var t = RESOLUTION[key];
    if (!t) return '';
    var allow = t.ratios ? tiersAt(key, ratio) : t.tiers.slice();
    if (!allow.length) return '';
    var want = t.tiers.indexOf(tier);
    if (want < 0) want = t.tiers.length - 1;
    for (var i = want; i >= 0; i--) {
      if (allow.indexOf(t.tiers[i]) >= 0) return t.tiers[i];
    }
    return allow[0] || '';
  }

  return {
    ENGINE_MODELS: ENGINE_MODELS,
    ALAPI_MODELS: ALAPI_MODELS,
    BY_KEY: BY_KEY,
    QUICK: QUICK,
    RESOLUTION: RESOLUTION,
    resTableOf: resTableOf,
    pixelOf: pixelOf,
    tiersAt: tiersAt,
    tierAllowed: tierAllowed,
    degradeTier: degradeTier
  };
});
