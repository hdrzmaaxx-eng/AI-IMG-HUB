/* ============================================================================
 * 提示词体检 · 纯逻辑（无 DOM 依赖，可在浏览器与 Node 下同时使用）
 *
 * 为什么需要它：
 *   图像模型不会「理解并执行」一段描述流程的文字，它会照着把流程画出来。
 *   真实案例：提示词里出现「分析 / 拆解 / 前后对比 / 标注 / 协议 / 矩阵 / 色卡」，
 *   模型直接输出了一张带英文标注、色卡、before/after 裁切的说明图，
 *   而不是修好的照片。
 *
 * 判断标准不是「长短」，是「语气」：
 *   描述画面（背景什么东西、光从哪来、阴影多深、边缘干不干净）→ 越长越细越好
 *   描述流程/交付物（先分析、再拆解、最后出一张对比图）        → 再短也会翻车
 * ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PromptLint = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 高危措辞：命中后模型倾向「把描述的东西画出来」
  const RISK_RULES = [
    {
      group: '对比类',
      re: /before\s*[\/\-—]?\s*after|前后对比|对比图|对比照|并排|并列展示|对比展示|before\s*and\s*after/gi,
      why: '模型会真的画出一张「前后对比图」'
    },
    {
      group: '分析类',
      re: /分析|拆解|解析|诊断|复盘/g,
      why: '「分析」会被画成带标注的图'
    },
    {
      group: '图示类',
      re: /标注|注释|箭头|引线|信息图|示意图|说明图|图解|色卡|配色卡|色板|矩阵|协议|infographic|diagram|annotation|palette|matrix|protocol|remaster/gi,
      why: '会被当成「在图上画这些东西」的指令'
    },
    {
      group: '排版类',
      re: /排版|拼贴|拼图|四宫格|九宫格|多宫格|多图|多角度展示|多个角度|多视图|网格排版|grid|collage/gi,
      why: '模型会输出多图排版，而不是单张成品'
    },
    {
      group: '流程类',
      re: /流程|步骤|工序|环节|workflow|process|step\s*\d/gi,
      why: '模型会画成流程示意图'
    },
    {
      group: '文档类',
      re: /报告|方案|规格书|参数表|说明文档|评测/gi,
      why: '偏文档措辞，容易诱导成信息图'
    }
  ];

  // 否定判定：命中点所在的那一句里，若前面出现过否定词、且中途没有转折词，
  // 说明这是「不要添加任何文字、标注、水印……」这类正确写法，整串都放过。
  const NEG_WORDS = ['不要', '不能', '不加', '不得', '禁止', '无需', '避免', '去掉', '去除', '清除', '切勿'];
  const TURN_WORDS = /(但|但是|然后|再|并且|以及|同时|而且|且|而是|之后)/;
  const SENTENCE_BREAK = ['\n', '。', '！', '？', '；'];

  function inNegatedContext(text, index) {
    let start = 0;
    for (const ch of SENTENCE_BREAK) {
      const i = text.lastIndexOf(ch, index - 1);
      if (i + 1 > start) start = i + 1;
    }
    const prefix = text.slice(start, index);
    let negIdx = -1;
    for (const w of NEG_WORDS) {
      const i = prefix.lastIndexOf(w);
      if (i > negIdx) negIdx = i;
    }
    if (negIdx < 0) return false;
    // 否定词之后出现了转折，说明已经是另一件事了
    return !TURN_WORDS.test(prefix.slice(negIdx));
  }

  // 值得补上的写法（缺失只提示，不报错）
  const GOOD_RULES = [
    {
      key: 'anchor',
      label: '开头点明「基于这张照片」',
      sentence: '基于我提供的这张照片修图。',
      where: 'start',
      test: /基于[^。\n]{0,10}(照片|图片|原图)|这张照片|这张图/,
      tip: '能显著提高参考图的权重，减少「换了个产品」'
    },
    {
      key: 'keep',
      label: '写清「保持不变」',
      sentence: '产品主体、形状、角度、颜色、材质、纹理和所有细节保持完全不变。',
      where: 'end',
      test: /不变|保持原样|原样保留|不要改动|不要改变|不要修改/,
      tip: '把要保留的东西列一遍，模型才知道哪些不能碰'
    },
    {
      key: 'avoid',
      label: '写清「不要添加」',
      sentence: '不要添加任何文字、标注、水印、边框、色块或额外元素。',
      where: 'end',
      test: /不要添加|不加|不得添加|禁止添加|不要出现|避免添加/,
      tip: '挡掉文字、水印、标注、边框、拼贴'
    }
  ];

  /**
   * 体检一段提示词
   * @param {string} text
   * @param {{task?: 't2i'|'i2i'|'batch'}} [opts] 任务类型。文生图没有原图，
   *   不检查「开头锚定原图」和「保持不变」这两条，只保留「不要添加」。
   * @returns {{risks: Array<{group:string,words:string[],why:string}>, missing: Array<object>, clean: boolean, length: number}}
   */
  function lint(text, opts) {
    const t = String(text || '').trim();
    if (!t) return { risks: [], missing: [], clean: true, length: 0, empty: true };
    const task = (opts && opts.task) || 'i2i';

    const risks = [];
    for (const rule of RISK_RULES) {
      rule.re.lastIndex = 0;
      let m;
      const hits = [];
      while ((m = rule.re.exec(t)) !== null) {
        if (m[0] === '') break; // 零宽匹配保护
        if (!inNegatedContext(t, m.index)) {
          if (!hits.includes(m[0])) hits.push(m[0]);
        }
        if (hits.length >= 4) break;
      }
      if (hits.length) risks.push({ group: rule.group, words: hits, why: rule.why });
    }

    // 文生图没有原图可锚定、也没有东西需要保持不变，只保留「不要添加」
    const good = task === 't2i' ? GOOD_RULES.filter((r) => r.key === 'avoid') : GOOD_RULES;
    const missing = good.filter((r) => !r.test.test(t));
    return { risks, missing, clean: !risks.length && !missing.length, length: t.length, empty: false };
  }

  return { lint, RISK_RULES, GOOD_RULES, inNegatedContext };
});
