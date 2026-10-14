/**
 * Cloudflare Worker: 沉浸式英日双语外语阅读器 (Polyglot Edge Reader)
 * 功能：网页正文代理抓取 + 单击词义(行内下方) + 长按多词翻译 + 双击整句翻译与句型结构分析 + 三击收藏 + 高度自定义排版
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. CORS 预检处理
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    // 2. 路由分发：外部新闻/网页抓取代理
    if (url.pathname === "/api/proxy" && request.method === "POST") {
      return handleProxyArticle(request);
    }

    // 3. 路由分发：单词释义、短语翻译与双击句型结构解析
    if (url.pathname === "/api/analyze" && request.method === "POST") {
      return handleAnalyze(request, env);
    }

    // 4. 默认返回阅读器主页面 (SPA)
    return new Response(READER_HTML, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache"
      }
    });
  }
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  };
}

/**
 * 抓取外部新闻或网页并提取干净的正文段落
 */
async function handleProxyArticle(request) {
  try {
    const { targetUrl } = await request.json();
    if (!targetUrl || !/^https?:\/\//i.test(targetUrl)) {
      return jsonResponse({ error: "请输入有效的 http/https 网址" }, 400);
    }

    const res = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,ja;q=0.8,zh-CN;q=0.7"
      }
    });

    const html = await res.text();

    // 提取标题
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const rawTitle = titleMatch ? cleanHtmlEntities(titleMatch[1].trim()) : targetUrl;

    // 清理脚本、样式、导航与广告标签，提取正文段落
    let cleaned = html
      .replace(/<(script|style|noscript|svg|iframe|nav|footer|header|aside|form)[^>]*>[\s\S]*?<\/\1>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "");

    const paragraphs = [];
    const pRegex = /<(p|h1|h2|h3|blockquote|article)[^>]*>([\s\S]*?)<\/\1>/gi;
    let match;
    while ((match = pRegex.exec(cleaned)) !== null) {
      const text = cleanHtmlEntities(match[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
      // 过滤过短的导航碎片文本
      if (text.length > 20 || (match[1].startsWith("h") && text.length > 4)) {
        paragraphs.push({
          tag: match[1].toLowerCase(),
          text
        });
      }
    }

    // 如果常规 <p> 提取过少，回退到全文块提取
    if (paragraphs.length === 0) {
      const fallbackText = cleanHtmlEntities(cleaned.replace(/<[^>]+>/g, "\n"))
        .split(/\n+/)
        .map(s => s.trim())
        .filter(s => s.length > 25);
      fallbackText.forEach(t => paragraphs.push({ tag: "p", text: t }));
    }

    return jsonResponse({
      title: rawTitle,
      sourceUrl: targetUrl,
      paragraphs: paragraphs.slice(0, 120)
    });
  } catch (err) {
    return jsonResponse({ error: "抓取网页失败: " + err.message }, 500);
  }
}

/**
 * 处理单词查询、短语翻译与句子语法结构拆解
 */
async function handleAnalyze(request, env) {
  try {
    const { text, mode, contextSentence, targetLang = "zh-CN" } = await request.json();
    if (!text) return jsonResponse({ error: "缺少待解析文本" }, 400);

    // 模式 A: 单击单词 或 长按多词短语 -> 快速返回简明释义
    if (mode === "word" || mode === "phrase") {
      const trans = await quickTranslate(text, targetLang);
      return jsonResponse({
        text,
        meaning: trans.meaning,
        phonetic: trans.phonetic || ""
      });
    }

    // 模式 B: 双击句子 -> 翻译整句 + 提取短语 + 句型结构剖析 (如 It is + adj + to do)
    if (mode === "sentence") {
      // 如果配置了大模型 API (OpenAI 兼容接口或 Cloudflare Workers AI)，优先使用 AI 进行深度句法分析
      if (env && (env.AI_API_KEY || env.AI)) {
        const aiResult = await analyzeSentenceWithAI(text, env);
        if (aiResult) return jsonResponse(aiResult);
      }

      // 零配置兜底：使用免费翻译接口 + 内置英日核心句型语法识别器
      const trans = await quickTranslate(text, targetLang);
      const patterns = detectGrammarPatterns(text);
      return jsonResponse({
        sentence: text,
        translation: trans.meaning,
        patterns
      });
    }

    return jsonResponse({ error: "未知模式" }, 400);
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
}

/**
 * 免费快速词典与翻译接口（結合 Google GTX 词典详情）
 */
async function quickTranslate(text, tl = "zh-CN") {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(tl)}&dt=t&dt=bd&dt=rm&q=${encodeURIComponent(text)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" }
  });
  const data = await res.json();

  // 拼接主翻译
  let mainTranslation = "";
  let phonetic = "";
  if (Array.isArray(data[0])) {
    for (const seg of data[0]) {
      if (seg[0]) mainTranslation += seg[0];
      if (seg[3]) phonetic = seg[3];
    }
  }

  // 如果有词典词性释义 (dt=bd)，提取最核心的词性解释供行内展示
  let dictMeanings = [];
  if (Array.isArray(data[1])) {
    for (const posBlock of data[1].slice(0, 2)) {
      const pos = posBlock[0] || "";
      const terms = (posBlock[1] || []).slice(0, 2).join(" / ");
      if (terms) dictMeanings.push(`${pos ? pos + "." : ""}${terms}`);
    }
  }

  return {
    meaning: dictMeanings.length > 0 ? dictMeanings.join("；") : mainTranslation,
    phonetic
  };
}

/**
 * 内置英/日经典句型结构与短语检测器（无需 API Key 即可识别核心语法）
 */
function detectGrammarPatterns(sentence) {
  const results = [];
  const s = sentence.trim();

  // 英语高频句型结构库
  const enRules = [
    {
      regex: /\b(it\s+(?:is|was|seems|appears|becomes)\s+[a-zA-Z\-]+(?:\s+for\s+[a-zA-Z]+)?\s+to\s+[a-zA-Z]+)/i,
      pattern: "It is + adj. + (for sb.) + to do sth.",
      explanation: "形式主语句型：It 作形式主语，真正的主语是后面的不定式 to do，用于避免句子头重脚轻。"
    },
    {
      regex: /\b(it\s+(?:is|was)\s+[a-zA-Z\-]+\s+that\s+)/i,
      pattern: "It is/was + ... + that ... (强调句或主语从句)",
      explanation: "强调句型或形式主语从句：突出 that 引导的核心事实或被强调成分。"
    },
    {
      regex: /\b(so\s+[a-zA-Z\-]+\s+that\b|such\s+[a-zA-Z\s\-]+\s+that\b)/i,
      pattern: "so / such ... that ...",
      explanation: "结果状语从句：表示“如此……以至于……”。"
    },
    {
      regex: /\b(not\s+only\b[\s\S]+?\bbut\s+(?:also)?)/i,
      pattern: "not only ... but (also) ...",
      explanation: "递进并列结构：“不仅……而且……”，若置于句首则前一部分需部分倒装。"
    },
    {
      regex: /\b(the\s+(?:more|less|[a-z]+er)\b[\s\S]+?,\s*the\s+(?:more|less|[a-z]+er)\b)/i,
      pattern: "The + 比较级 ..., the + 比较级 ...",
      explanation: "比较状语结构：表示“越……，就越……”。"
    },
    {
      regex: /\b(as\s+long\s+as|so\s+long\s+as|provided\s+that)\b/i,
      pattern: "as long as / provided that (条件状语从句)",
      explanation: "表示充分条件：“只要……；在……条件下”。"
    },
    {
      regex: /\b(would\s+rather\s+[a-z]+\s+than\s+[a-z]+)/i,
      pattern: "would rather do A than do B",
      explanation: "取舍句型：表示“宁愿做 A 而不愿做 B”。"
    },
    {
      regex: /\b(have\s+no\s+choice\s+but\s+to\s+[a-z]+|cannot\s+help\s+[a-z]+ing)\b/i,
      pattern: "have no choice but to do / cannot help doing",
      explanation: "固定短语结构：“别无选择只能……” 或 “情不自禁做某事”。"
    },
    {
      regex: /,\s*(which|who|whom|whose|where|when)\s+/i,
      pattern: ", + which/who/where ... (非限制性定语从句)",
      explanation: "对先行词或整个主句进行补充说明，不可用 that 替换。"
    }
  ];

  // 日语高频语法句型库 (N3~N1)
  const jaRules = [
    {
      regex: /(わけにはいかない|わけにはゆかない)/,
      pattern: "〜わけにはいかない",
      explanation: "由于社会常识、道义或心理原因，“不能做某事 / 没法……”。"
    },
    {
      regex: /(ざるを得ない|ざるをえない)/,
      pattern: "〜ざるを得ない（不得不……）",
      explanation: "表示虽然不情愿，但迫于形势“不得不做某事”。"
    },
    {
      regex: /(にとどまらず|に留まらず)/,
      pattern: "〜にとどまらず（不仅限于……）",
      explanation: "表示范围不仅局限于前项，还进一步扩大到后项。"
    },
    {
      regex: /(というわけではない|という訳ではない)/,
      pattern: "〜というわけではない（并非……）",
      explanation: "部分否定句型，委婉表示“并不是说完全……”。"
    },
    {
      regex: /(に違いない|にちがいない)/,
      pattern: "〜に違いない（一定…… / 肯定……）",
      explanation: "说话人根据依据做出的强烈确信推断。"
    },
    {
      regex: /(おかげで|おかげだ|せいで|せいだ)/,
      pattern: "〜おかげで（多亏）/ 〜せいで（怪……）",
      explanation: "表示原因与结果：前者用于积极结果，后者用于消极结果。"
    },
    {
      regex: /(ばいい|たらいい|といい)/,
      pattern: "〜ばいい / 〜たらいい（如果……就好了 / 只要……就行）",
      explanation: "用于提出建议或表达愿望。"
    },
    {
      regex: /(ている|てある|ておく|てしまう)/,
      pattern: "动词て形补助结构（〜ている/てある/ておく/てしまう）",
      explanation: "表示动作持续/结果状态存续/事先准备/动作彻底完成或遗憾。"
    }
  ];

  for (const r of [...enRules, ...jaRules]) {
    const m = s.match(r.regex);
    if (m) {
      results.push({
        matched: m[0],
        pattern: r.pattern,
        explanation: r.explanation
      });
    }
  }

  // 如果未命中特定固定句式，自动提取句中的核心介词短语/不定式结构提示
  if (results.length === 0) {
    const infMatch = s.match(/\b(to\s+[a-z]{3,}\s+[a-z]{3,})\b/i);
    if (infMatch) {
      results.push({
        matched: infMatch[1],
        pattern: "to + V. (动词不定式短语)",
        explanation: "在句中可作目的状语、后置定语或宾语补足语。"
      });
    } else {
      results.push({
        matched: s.slice(0, 28) + (s.length > 28 ? "..." : ""),
        pattern: "标准陈述/复合句结构",
        explanation: "可在 Worker 环境变量中配置 AI_API_KEY 解锁任意长难句的完整从句与短语拆解。"
      });
    }
  }

  return results;
}

/**
 * 可选：若配置了 env.AI_API_KEY 或 env.AI，调用大模型深度剖析句法结构
 */
async function analyzeSentenceWithAI(sentence, env) {
  const prompt = `请分析以下外语句子，返回严格 JSON 格式：
句子："${sentence}"
JSON 字段要求：
{
  "sentence": "原句",
  "translation": "自然流畅的中文翻译",
  "patterns": [
    {
      "matched": "句中对应的短语片段",
      "pattern": "句型结构公式（如 It is + adj. + to do 或 〜わけにはいかない）",
      "explanation": "简明语法作用与中文解释"
    }
  ]
}`;

  try {
    if (env.AI_API_KEY) {
      const apiBase = env.AI_BASE_URL || "https://api.openai.com/v1";
      const model = env.AI_MODEL || "gpt-4o-mini";
      const res = await fetch(`${apiBase}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${env.AI_API_KEY}`
        },
        body: JSON.stringify({
          model,
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: prompt }]
        })
      });
      const data = await res.json();
      return JSON.parse(data.choices[0].message.content);
    }
  } catch (e) {
    return null;
  }
  return null;
}

function cleanHtmlEntities(str) {
  return str
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders()
    }
  });
}

/**
 * 前端 SPA 完整界面与手势交互引擎
 */
const READER_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <title>Edge Polyglot Reader | 沉浸式英日阅读器</title>
  <style>
    :root {
      --bg-color: #f8f5ec;
      --card-bg: #ffffff;
      --text-color: #2c2e33;
      --sub-text: #6e737b;
      --accent-color: #2563eb;
      --accent-bg: rgba(37, 99, 235, 0.1);
      --saved-color: #d97706;
      --saved-bg: rgba(245, 158, 11, 0.16);
      --border-color: rgba(0, 0, 0, 0.09);
      /* 动态排版变量（由屏幕分辨率自动初始化并支持手动调节） */
      --reader-font: 'Georgia', 'Hiragino Mincho ProN', 'Yu Mincho', 'Noto Serif JP', serif;
      --reader-font-size: 19px;
      --reader-line-height: 2.1;
      --reader-letter-spacing: 0.02em;
      --reader-word-spacing: 0.12em;
      --reader-max-width: 780px;
    }

    [data-theme="dark"] {
      --bg-color: #131519;
      --card-bg: #1e2128;
      --text-color: #e2e6ee;
      --sub-text: #949ba6;
      --accent-color: #60a5fa;
      --accent-bg: rgba(96, 165, 250, 0.15);
      --saved-color: #fbbf24;
      --saved-bg: rgba(251, 191, 36, 0.18);
      --border-color: rgba(255, 255, 255, 0.1);
    }

    [data-theme="light"] {
      --bg-color: #ffffff;
      --card-bg: #f3f4f6;
      --text-color: #111827;
      --sub-text: #6b7280;
    }

    * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }

    body {
      margin: 0;
      padding: 0;
      background-color: var(--bg-color);
      color: var(--text-color);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      transition: background-color 0.25s, color 0.25s;
      overflow-x: hidden;
    }

    /* 顶部网址与切换栏 */
    .top-bar {
      max-width: var(--reader-max-width);
      margin: 0 auto;
      padding: 14px 18px;
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      border-bottom: 1px solid var(--border-color);
      transition: transform 0.3s ease, opacity 0.3s ease;
    }
    .top-bar.hidden-bar {
      transform: translateY(-100%);
      opacity: 0;
      pointer-events: none;
    }
    .url-input {
      flex: 1;
      min-width: 180px;
      padding: 9px 12px;
      border-radius: 8px;
      border: 1px solid var(--border-color);
      background: var(--card-bg);
      color: var(--text-color);
      font-size: 14px;
      outline: none;
    }
    .btn {
      padding: 8px 13px;
      border-radius: 8px;
      border: 1px solid var(--border-color);
      background: var(--card-bg);
      color: var(--text-color);
      font-size: 13px;
      cursor: pointer;
      font-weight: 500;
      transition: all 0.15s;
    }
    .btn-primary {
      background: var(--accent-color);
      color: #fff;
      border-color: var(--accent-color);
    }
    .btn:active { transform: scale(0.97); }

    /* 手势提示条 */
    .gesture-hint {
      max-width: var(--reader-max-width);
      margin: 10px auto 0;
      padding: 8px 18px;
      font-size: 12.5px;
      color: var(--sub-text);
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      justify-content: space-between;
      align-items: center;
    }
    .badge {
      display: inline-block;
      padding: 2px 7px;
      border-radius: 5px;
      background: var(--accent-bg);
      color: var(--accent-color);
      font-weight: 600;
      margin-right: 4px;
    }

    /* 核心文章阅读区域 */
    .reader-container {
      max-width: var(--reader-max-width);
      margin: 0 auto;
      padding: 16px 20px 140px;
      font-family: var(--reader-font);
      font-size: var(--reader-font-size);
      line-height: var(--reader-line-height);
      letter-spacing: var(--reader-letter-spacing);
      word-spacing: var(--reader-word-spacing);
    }

    .article-title {
      font-size: 1.45em;
      line-height: 1.4;
      margin-bottom: 0.8em;
      font-weight: 700;
    }

    .paragraph {
      margin-bottom: 1.35em;
      text-align: justify;
    }

    .sentence {
      display: inline;
      border-radius: 4px;
      transition: background-color 0.2s;
    }
    .sentence.active-sentence {
      background-color: var(--accent-bg);
    }

    /* 单词容器：支持点击后在正下方显示意思 */
    .word-unit {
      display: inline-flex;
      flex-direction: column;
      align-items: center;
      vertical-align: top;
      position: relative;
      cursor: pointer;
      border-radius: 4px;
      padding: 0 2px;
      margin: 0 1px;
      user-select: text;
      transition: background 0.15s;
    }
    .word-unit:hover {
      background-color: rgba(128, 128, 128, 0.12);
    }
    .word-unit.word-active {
      background-color: var(--accent-bg);
    }
    .word-unit.word-saved .word-text {
      border-bottom: 2px solid var(--saved-color);
      background-color: var(--saved-bg);
      border-radius: 3px;
    }
    .word-unit.phrase-selected {
      background-color: rgba(16, 185, 129, 0.22);
    }

    .word-text {
      line-height: 1.45;
    }

    /* 单击单词：紧贴在单词正下方的行内释义 */
    .word-sub-meaning {
      display: none;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 0.62em;
      line-height: 1.25;
      color: var(--accent-color);
      background: var(--card-bg);
      border: 1px solid var(--accent-color);
      border-radius: 4px;
      padding: 2px 6px;
      margin-top: 2px;
      margin-bottom: 4px;
      max-width: 170px;
      text-align: center;
      white-space: normal;
      box-shadow: 0 2px 6px rgba(0,0,0,0.08);
      z-index: 5;
    }
    .word-unit.show-meaning .word-sub-meaning {
      display: block;
      animation: fadeIn 0.15s ease;
    }

    /* 双击句子 或 长按多词：嵌入在句子下方的语法与翻译面板 */
    .sentence-analysis-box {
      display: block;
      margin: 10px 0 14px;
      padding: 12px 15px;
      background: var(--card-bg);
      border-left: 4px solid var(--accent-color);
      border-radius: 8px;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 0.78em;
      line-height: 1.55;
      box-shadow: 0 4px 14px rgba(0,0,0,0.06);
      animation: fadeIn 0.2s ease;
    }
    .analysis-trans {
      font-weight: 600;
      color: var(--text-color);
      margin-bottom: 8px;
    }
    .pattern-item {
      background: var(--accent-bg);
      padding: 6px 10px;
      border-radius: 6px;
      margin-top: 6px;
      font-size: 0.92em;
    }
    .pattern-formula {
      font-weight: 700;
      color: var(--accent-color);
    }

    /* 底部悬浮控制栏（阅读滚动时自动隐藏） */
    .bottom-dock {
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      gap: 10px;
      padding: 8px 16px;
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 999px;
      box-shadow: 0 8px 28px rgba(0, 0, 0, 0.16);
      z-index: 100;
      transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.35s ease;
    }
    .bottom-dock.dock-hidden {
      transform: translate(-50%, 130%);
      opacity: 0;
      pointer-events: none;
    }

    /* 设置抽屉弹窗 */
    .settings-panel {
      position: fixed;
      bottom: 78px;
      left: 50%;
      transform: translateX(-50%);
      width: min(92vw, 460px);
      background: var(--card-bg);
      border: 1px solid var(--border-color);
      border-radius: 16px;
      padding: 18px;
      box-shadow: 0 12px 36px rgba(0, 0, 0, 0.22);
      z-index: 101;
      display: none;
      font-size: 13.5px;
    }
    .settings-panel.open { display: block; animation: fadeIn 0.18s ease; }
    .setting-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
      gap: 10px;
    }
    .setting-row label { font-weight: 600; color: var(--sub-text); min-width: 82px; }
    .setting-row input[type="range"] { flex: 1; }
    .setting-row select {
      flex: 1;
      padding: 6px 8px;
      border-radius: 6px;
      background: var(--bg-color);
      color: var(--text-color);
      border: 1px solid var(--border-color);
    }

    /* 提示 Toast */
    .toast {
      position: fixed;
      top: 18px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(17, 24, 39, 0.92);
      color: #fff;
      padding: 8px 16px;
      border-radius: 99px;
      font-size: 13px;
      z-index: 200;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.25s;
    }
    .toast.show { opacity: 1; }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(-3px); }
      to { opacity: 1; transform: translateY(0); }
    }
  </style>
</head>
<body>

  <!-- 顶部网址抓取与示例切换栏 -->
  <header class="top-bar" id="topBar">
    <input type="url" id="urlInput" class="url-input" placeholder="输入英语/日语新闻或文章网址 (如 BBC / NHK / 博客链接)..." />
    <button class="btn btn-primary" onclick="fetchExternalUrl()">访问网页</button>
    <button class="btn" onclick="loadSample('en')">英语示例</button>
    <button class="btn" onclick="loadSample('ja')">日语示例</button>
  </header>

  <!-- 操作手势指南与分辨率状态 -->
  <div class="gesture-hint">
    <div>
      <span><b class="badge">单击</b>词下显义</span>
      <span><b class="badge">双击</b>译整句+句型结构</span>
      <span><b class="badge">三击</b>收藏单词</span>
      <span><b class="badge">长按/划选</b>多词短语翻译</span>
    </div>
    <div id="screenInfo" style="font-size:11.5px;opacity:0.8;"></div>
  </div>

  <!-- 文章主阅读区 -->
  <main class="reader-container" id="readerContainer">
    <h1 class="article-title" id="articleTitle">Loading...</h1>
    <div id="articleBody"></div>
  </main>

  <!-- 底部自定义设置面板 -->
  <div class="settings-panel" id="settingsPanel">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
      <strong style="font-size:15px;">阅读排版与生词本设置</strong>
      <button class="btn" style="padding:3px 9px;" onclick="togglePanel('settingsPanel')">关闭</button>
    </div>

    <div class="setting-row">
      <label>字体类型</label>
      <select id="fontFamilySelect" onchange="updateTypography()">
        <option value="'Georgia', 'Hiragino Mincho ProN', 'Noto Serif JP', serif">经典衬线 / 明朝体 (Serif)</option>
        <option value="-apple-system, BlinkMacSystemFont, 'Hiragino Sans', 'Meiryo', sans-serif">现代无衬线 / 黑体 (Sans)</option>
        <option value="'Palatino Linotype', 'Book Antiqua', Palatino, serif">学术书籍体 (Palatino)</option>
        <option value="'Courier New', Consolas, monospace">等宽代码体 (Monospace)</option>
      </select>
    </div>

    <div class="setting-row">
      <label>字体大小</label>
      <input type="range" id="fontSizeRange" min="14" max="30" step="1" oninput="updateTypography()" />
      <span id="fontSizeVal">19px</span>
    </div>

    <div class="setting-row">
      <label>行距高低</label>
      <input type="range" id="lineHeightRange" min="1.4" max="3.0" step="0.1" oninput="updateTypography()" />
      <span id="lineHeightVal">2.1</span>
    </div>

    <div class="setting-row">
      <label>字间间距</label>
      <input type="range" id="letterSpacingRange" min="-0.02" max="0.2" step="0.01" oninput="updateTypography()" />
      <span id="letterSpacingVal">0.02em</span>
    </div>

    <div class="setting-row">
      <label>词间间距</label>
      <input type="range" id="wordSpacingRange" min="0" max="0.4" step="0.02" oninput="updateTypography()" />
      <span id="wordSpacingVal">0.12em</span>
    </div>

    <div class="setting-row">
      <label>版心宽度</label>
      <input type="range" id="maxWidthRange" min="480" max="1200" step="20" oninput="updateTypography()" />
      <span id="maxWidthVal">780px</span>
    </div>

    <div class="setting-row">
      <label>护眼主题</label>
      <div style="display:flex;gap:6px;flex:1;">
        <button class="btn" style="flex:1" onclick="setTheme('sepia')">羊皮纸</button>
        <button class="btn" style="flex:1" onclick="setTheme('light')">纯白</button>
        <button class="btn" style="flex:1" onclick="setTheme('dark')">夜间</button>
      </div>
    </div>

    <hr style="border:none;border-top:1px solid var(--border-color);margin:12px 0;" />
    <div>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <strong>三击收藏的生词本 (<span id="vocabCount">0</span>)</strong>
        <button class="btn" style="padding:2px 8px;font-size:12px;" onclick="exportVocab()">导出 JSON</button>
      </div>
      <div id="vocabList" style="max-height:110px;overflow-y:auto;font-size:12.5px;color:var(--sub-text);"></div>
    </div>
  </div>

  <!-- 底部悬浮栏（阅读时自动隐藏） -->
  <nav class="bottom-dock" id="bottomDock">
    <button class="btn" onclick="togglePanel('settingsPanel')">⚙️ 排版与生词本</button>
    <button class="btn" onclick="autoAdaptScreen(true)">📐 屏幕自适应重置</button>
    <button class="btn" onclick="clearAllAnnotations()">🧹 收起全部注释</button>
  </nav>

  <div class="toast" id="toast"></div>

  <script>
    // 内置英语与日语示例文章（包含典型句型结构供立刻测试单/双/三击与长按）
    const SAMPLES = {
      en: {
        title: "Why Deep Reading Matters in an Age of AI",
        paragraphs: [
          {
            tag: "p",
            text: "It is essential for university students to cultivate deep reading habits when information is fragmented across digital screens. Not only does immersive reading expand vocabulary naturally, but it also strengthens critical reasoning."
          },
          {
            tag: "p",
            text: "The more frequently you encounter complex phrases in authentic news articles, the easier it becomes to grasp subtle grammatical structures. Many learners have no choice but to rely on rote memorization, which often fades within weeks."
          },
          {
            tag: "p",
            text: "As long as you analyze sentence patterns directly within context, acquiring a second language transforms from a tedious chore into an engaging exploration."
          }
        ]
      },
      ja: {
        title: "デジタル時代における多読と語学学習の新しい形",
        paragraphs: [
          {
            tag: "p",
            text: "外国語のニュース記事を毎日読むことは、単に単語を暗記するにとどまらず、生きた文脈の中で自然な表現を身につける最良の方法であるに違いない。"
          },
          {
            tag: "p",
            text: "どれほど便利な翻訳ツールが普及したとしても、基礎的な文構造を理解する努力を怠るわけにはいかない。自分の力で長文を読み解いたおかげで、読解スピードが飛躍的に向上したという学習者は多い。"
          }
        ]
      }
    };

    // 状态管理
    let savedWords = JSON.parse(localStorage.getItem("polyglot_vocab") || "{}");
    const wordCache = new Map();
    let clickState = { el: null, count: 0, timer: null };
    let longPressTimer = null;
    let longPressStartEl = null;

    // 1. 根据屏幕分辨率与 DPR 自动调节初始阅读参数
    function autoAdaptScreen(showNotice = false) {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const dpr = window.devicePixelRatio || 1;

      let fontSize = 19;
      let lineHeight = 2.1;
      let maxWidth = 760;

      if (w < 480) {
        // 手机小屏
        fontSize = 17;
        lineHeight = 2.05;
        maxWidth = w - 24;
      } else if (w < 900) {
        // 平板或折叠屏
        fontSize = 19;
        lineHeight = 2.15;
        maxWidth = Math.min(720, w - 48);
      } else if (w >= 1600) {
        // 高分桌面大屏
        fontSize = 21;
        lineHeight = 2.2;
        maxWidth = 860;
      }

      document.getElementById("fontSizeRange").value = fontSize;
      document.getElementById("lineHeightRange").value = lineHeight;
      document.getElementById("maxWidthRange").value = maxWidth;
      document.getElementById("letterSpacingRange").value = 0.02;
      document.getElementById("wordSpacingRange").value = 0.12;

      updateTypography();
      document.getElementById("screenInfo").textContent =
        \`屏幕自适应: \${w}×\${h} (DPR \${dpr.toFixed(1)}x)\`;

      if (showNotice) showToast(\`已根据当前屏幕 (\${w}×\${h}) 自动优化字号与间距\`);
    }

    function updateTypography() {
      const root = document.documentElement;
      const font = document.getElementById("fontFamilySelect").value;
      const size = document.getElementById("fontSizeRange").value;
      const lh = document.getElementById("lineHeightRange").value;
      const ls = document.getElementById("letterSpacingRange").value;
      const ws = document.getElementById("wordSpacingRange").value;
      const mw = document.getElementById("maxWidthRange").value;

      root.style.setProperty("--reader-font", font);
      root.style.setProperty("--reader-font-size", size + "px");
      root.style.setProperty("--reader-line-height", lh);
      root.style.setProperty("--reader-letter-spacing", ls + "em");
      root.style.setProperty("--reader-word-spacing", ws + "em");
      root.style.setProperty("--reader-max-width", mw + "px");

      document.getElementById("fontSizeVal").textContent = size + "px";
      document.getElementById("lineHeightVal").textContent = lh;
      document.getElementById("letterSpacingVal").textContent = ls + "em";
      document.getElementById("wordSpacingVal").textContent = ws + "em";
      document.getElementById("maxWidthVal").textContent = mw + "px";
    }

    function setTheme(theme) {
      if (theme === "sepia") {
        document.documentElement.removeAttribute("data-theme");
      } else {
        document.documentElement.setAttribute("data-theme", theme);
      }
    }

    // 2. 使用 Intl.Segmenter 渲染文章（支持英日分词与分句）
    function renderArticle(article) {
      document.getElementById("articleTitle").textContent = article.title;
      const body = document.getElementById("articleBody");
      body.innerHTML = "";

      const fullSample = article.paragraphs.map(p => p.text).join(" ");
      const isJapanese = /[\\u3040-\\u30ff\\u4e00-\\u9faf]/.test(fullSample);
      const lang = isJapanese ? "ja" : "en";

      const sentenceSegmenter = new Intl.Segmenter(lang, { granularity: "sentence" });
      const wordSegmenter = new Intl.Segmenter(lang, { granularity: "word" });

      article.paragraphs.forEach(pObj => {
        const pEl = document.createElement("div");
        pEl.className = "paragraph";

        const sentences = sentenceSegmenter.segment(pObj.text);
        for (const sSeg of sentences) {
          const sSpan = document.createElement("span");
          sSpan.className = "sentence";
          sSpan.dataset.sentence = sSeg.segment.trim();

          const words = wordSegmenter.segment(sSeg.segment);
          for (const wSeg of words) {
            if (!wSeg.isWordLike) {
              sSpan.appendChild(document.createTextNode(wSeg.segment));
              continue;
            }

            const wUnit = document.createElement("span");
            wUnit.className = "word-unit";
            const cleanWord = wSeg.segment.trim();
            wUnit.dataset.word = cleanWord;

            if (savedWords[cleanWord.toLowerCase()]) {
              wUnit.classList.add("word-saved");
            }

            const wText = document.createElement("span");
            wText.className = "word-text";
            wText.textContent = wSeg.segment;

            const wMeaning = document.createElement("span");
            wMeaning.className = "word-sub-meaning";

            wUnit.appendChild(wText);
            wUnit.appendChild(wMeaning);
            sSpan.appendChild(wUnit);
          }

          pEl.appendChild(sSpan);
        }
        body.appendChild(pEl);
      });

      renderVocabList();
    }

    // 3. 核心交互引擎：单击词下显义、双击句子语法拆解、三击收藏、长按多词翻译
    const readerContainer = document.getElementById("readerContainer");

    readerContainer.addEventListener("click", (e) => {
      const wordUnit = e.target.closest(".word-unit");
      if (!wordUnit) return;

      // 如果刚刚触发了长按或划词翻译，忽略本次 click
      if (window.getSelection && window.getSelection().toString().trim().length > 0) {
        return;
      }

      if (clickState.el !== wordUnit) {
        if (clickState.timer) clearTimeout(clickState.timer);
        clickState.el = wordUnit;
        clickState.count = 0;
      }

      clickState.count += 1;

      if (clickState.count === 3) {
        clearTimeout(clickState.timer);
        clickState.count = 0;
        handleTripleClickWord(wordUnit);
        return;
      }

      clearTimeout(clickState.timer);
      const currentCount = clickState.count;
      clickState.timer = setTimeout(() => {
        if (currentCount === 1) {
          handleSingleClickWord(wordUnit);
        } else if (currentCount === 2) {
          handleDoubleClickSentence(wordUnit);
        }
        clickState.count = 0;
      }, 255);
    });

    // 长按单词：自动联合后面 1~2 个单词组成多词短语并翻译
    readerContainer.addEventListener("pointerdown", (e) => {
      const wordUnit = e.target.closest(".word-unit");
      if (!wordUnit) return;
      longPressStartEl = wordUnit;
      longPressTimer = setTimeout(() => {
        handleLongPressPhrase(wordUnit);
      }, 460);
    });

    readerContainer.addEventListener("pointerup", () => {
      clearTimeout(longPressTimer);
      // 检查用户是否通过拖拽/划词选中了 2~4 个词
      setTimeout(checkSelectionPhrase, 60);
    });
    readerContainer.addEventListener("pointermove", () => clearTimeout(longPressTimer));

    // 单击：在该单词正下方显示意思
    async function handleSingleClickWord(wordUnit) {
      const word = wordUnit.dataset.word;
      const subEl = wordUnit.querySelector(".word-sub-meaning");

      // 再次单击已展开的单词则收起
      if (wordUnit.classList.contains("show-meaning")) {
        wordUnit.classList.remove("show-meaning", "word-active");
        return;
      }

      wordUnit.classList.add("show-meaning", "word-active");
      if (wordCache.has(word)) {
        subEl.textContent = wordCache.get(word);
        return;
      }

      subEl.textContent = "...";
      try {
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: word, mode: "word" })
        });
        const data = await res.json();
        const meaning = data.meaning || "未找到释义";
        wordCache.set(word, meaning);
        subEl.textContent = meaning;
      } catch (err) {
        subEl.textContent = "查询失败";
      }
    }

    // 双击：翻译该单词所在的整句 + 解析短语与句子结构（如 It is + adj + to do）
    async function handleDoubleClickSentence(wordUnit) {
      const sentenceEl = wordUnit.closest(".sentence");
      if (!sentenceEl) return;

      // 如果已存在解析框则切换收起
      const nextEl = sentenceEl.nextElementSibling;
      if (nextEl && nextEl.classList.contains("sentence-analysis-box")) {
        nextEl.remove();
        sentenceEl.classList.remove("active-sentence");
        return;
      }

      sentenceEl.classList.add("active-sentence");
      const box = document.createElement("div");
      box.className = "sentence-analysis-box";
      box.innerHTML = "<div class='analysis-trans'>⏳ 正在翻译整句并拆解句型结构...</div>";
      sentenceEl.insertAdjacentElement("afterend", box);

      try {
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: sentenceEl.dataset.sentence,
            mode: "sentence"
          })
        });
        const data = await res.json();

        let patternsHtml = "";
        if (Array.isArray(data.patterns)) {
          patternsHtml = data.patterns.map(p => \`
            <div class="pattern-item">
              <div class="pattern-formula">📐 句型/短语结构：\${p.pattern}</div>
              <div style="margin-top:3px;">🔹 匹配片段：<code>\${p.matched}</code></div>
              <div style="margin-top:2px;color:var(--sub-text);">💡 解析：\${p.explanation}</div>
            </div>
          \`).join("");
        }

        box.innerHTML = \`
          <div class="analysis-trans">🌐 整句翻译：\${data.translation || "翻译失败"}</div>
          \${patternsHtml}
        \`;
      } catch (err) {
        box.innerHTML = "<div class='analysis-trans'>解析失败，请稍后重试</div>";
      }
    }

    // 三击：收藏该单词至生词本
    function handleTripleClickWord(wordUnit) {
      const word = wordUnit.dataset.word;
      const key = word.toLowerCase();
      const meaning = wordCache.get(word) || "";

      if (savedWords[key]) {
        delete savedWords[key];
        document.querySelectorAll(\`.word-unit[data-word="\${CSS.escape(word)}"]\`).forEach(el => {
          el.classList.remove("word-saved");
        });
        showToast(\`已取消收藏: \${word}\`);
      } else {
        savedWords[key] = { word, meaning, time: new Date().toLocaleDateString() };
        document.querySelectorAll(\`.word-unit[data-word="\${CSS.escape(word)}"]\`).forEach(el => {
          el.classList.add("word-saved");
        });
        showToast(\`⭐ 已三击收藏单词: \${word}\`);
      }

      localStorage.setItem("polyglot_vocab", JSON.stringify(savedWords));
      renderVocabList();
    }

    // 长按单词：自动抓取当前词与后方相邻的 1~2 个单词进行短语组合翻译
    async function handleLongPressPhrase(startWordUnit) {
      const sentenceEl = startWordUnit.closest(".sentence");
      if (!sentenceEl) return;

      const allWords = Array.from(sentenceEl.querySelectorAll(".word-unit"));
      const idx = allWords.indexOf(startWordUnit);
      const phraseUnits = allWords.slice(idx, idx + 3);
      phraseUnits.forEach(u => u.classList.add("phrase-selected"));

      const phraseText = phraseUnits.map(u => u.dataset.word).join(" ");
      await showPhraseMeaningUnderUnit(startWordUnit, phraseText, phraseUnits);
    }

    // 划选 2~5 个词时直接显示词组意思
    async function checkSelectionPhrase() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return;
      const selectedText = sel.toString().trim();
      if (selectedText.length < 2 || selectedText.length > 65) return;

      const anchorUnit = sel.anchorNode?.parentElement?.closest(".word-unit");
      if (!anchorUnit) return;

      await showPhraseMeaningUnderUnit(anchorUnit, selectedText, [anchorUnit]);
      sel.removeAllRanges();
    }

    async function showPhraseMeaningUnderUnit(targetUnit, phraseText, highlightUnits) {
      const subEl = targetUnit.querySelector(".word-sub-meaning");
      targetUnit.classList.add("show-meaning");
      subEl.style.maxWidth = "240px";
      subEl.textContent = \`[\${phraseText}] 翻译中...\`;

      try {
        const res = await fetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: phraseText, mode: "phrase" })
        });
        const data = await res.json();
        subEl.textContent = \`\${phraseText}: \${data.meaning}\`;
      } catch (e) {
        subEl.textContent = "词组翻译失败";
      }

      setTimeout(() => {
        highlightUnits.forEach(u => u.classList.remove("phrase-selected"));
      }, 1800);
    }

    // 4. 访问外部新闻/网页代理
    async function fetchExternalUrl() {
      const input = document.getElementById("urlInput").value.trim();
      if (!input) return showToast("请输入要访问的外语文章网址");

      showToast("正在通过 Cloudflare 边缘节点抓取正文...");
      try {
        const res = await fetch("/api/proxy", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetUrl: input })
        });
        const data = await res.json();
        if (data.error) return showToast(data.error);
        renderArticle(data);
        showToast("网页正文解析完成！");
      } catch (err) {
        showToast("抓取失败: " + err.message);
      }
    }

    function loadSample(lang) {
      renderArticle(SAMPLES[lang]);
      showToast(lang === "en" ? "已加载英语示例文章" : "已加载日语示例文章");
    }

    function clearAllAnnotations() {
      document.querySelectorAll(".word-unit.show-meaning").forEach(el => {
        el.classList.remove("show-meaning", "word-active");
      });
      document.querySelectorAll(".sentence-analysis-box").forEach(el => el.remove());
      document.querySelectorAll(".sentence.active-sentence").forEach(el => el.classList.remove("active-sentence"));
    }

    function togglePanel(id) {
      document.getElementById(id).classList.toggle("open");
    }

    function renderVocabList() {
      const keys = Object.keys(savedWords);
      document.getElementById("vocabCount").textContent = keys.length;
      const container = document.getElementById("vocabList");
      if (keys.length === 0) {
        container.textContent = "暂无收藏单词（在正文中快速三击任意单词即可收藏）";
        return;
      }
      container.innerHTML = keys.map(k => {
        const item = savedWords[k];
        return \`<div style="padding:3px 0;border-bottom:1px dashed var(--border-color);">
          <b>\${item.word}</b> <span style="opacity:0.85">\${item.meaning || ""}</span>
        </div>\`;
      }).join("");
    }

    function exportVocab() {
      const blob = new Blob([JSON.stringify(savedWords, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "vocabulary.json";
      a.click();
    }

    function showToast(msg) {
      const t = document.getElementById("toast");
      t.textContent = msg;
      t.classList.add("show");
      setTimeout(() => t.classList.remove("show"), 2200);
    }

    // 5. 阅读滚动时自动隐藏底部设置栏与顶部栏
    let lastScrollY = window.scrollY;
    window.addEventListener("scroll", () => {
      const currentY = window.scrollY;
      const dock = document.getElementById("bottomDock");
      const topBar = document.getElementById("topBar");
      const panel = document.getElementById("settingsPanel");

      if (currentY > lastScrollY + 12 && currentY > 70) {
        // 向下滚动阅读中 -> 自动隐藏设置栏
        dock.classList.add("dock-hidden");
        topBar.classList.add("hidden-bar");
        panel.classList.remove("open");
      } else if (currentY < lastScrollY - 10 || currentY < 40) {
        // 向上滚动 -> 唤出控制栏
        dock.classList.remove("dock-hidden");
        topBar.classList.remove("hidden-bar");
      }
      lastScrollY = currentY;
    }, { passive: true });

    // 监听窗口尺寸变化动态适应
    window.addEventListener("resize", () => autoAdaptScreen(false));

    // 初始化
    autoAdaptScreen(false);
    loadSample("en");
  </script>
</body>
</html>`;