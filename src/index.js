const ALLOWED_ORIGINS = new Set([
  "https://pr-statusreport.media-monitoring-worker.workers.dev",
  "https://yin0612.github.io",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  "http://localhost:8787",
  "http://127.0.0.1:8787",
]);

const MAX_REQUEST_CHARS = 8_192;
const MAX_PAGE_CHARS = 1_200_000;
const MAX_SOURCE_CHARS = 8_000;
const MAX_REDIRECTS = 5;

class ApiError extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.status = status;
    Object.assign(this, details);
  }
}

const trimText = (value, limit = MAX_SOURCE_CHARS) => String(value || "")
  .replace(/\u00a0/g, " ")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, limit);

const isPlaceholderExcerpt = (value) => /google news rss 聚合僅提供標題與發布時間|由產業監測網篩選，請開啟原文後整理週報內文|請開啟原文並撰寫週報內文/i.test(String(value || ""));

const usefulSourceText = (value, minimumLength = 90) => {
  const text = trimText(value);
  return text.length >= minimumLength && !isPlaceholderExcerpt(text) ? text : "";
};

const plainDraftText = (value, limit) => String(value || "")
  .replace(/\r\n?/g, "\n")
  .replace(/[ \t]+\n/g, "\n")
  .trim()
  .slice(0, limit);

const corsHeaders = (request) => {
  const origin = request.headers.get("origin") || "";
  const headers = {
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-pr-summary-key",
    "access-control-max-age": "600",
    vary: "Origin",
  };
  if (ALLOWED_ORIGINS.has(origin)) headers["access-control-allow-origin"] = origin;
  return headers;
};

const jsonResponse = (request, status, body) => new Response(JSON.stringify(body), {
  status,
  headers: {
    ...corsHeaders(request),
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  },
});

const constantTimeEqual = (first, second) => {
  const left = String(first || "");
  const right = String(second || "");
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
};

const isPrivateIpv4 = (hostname) => {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return false;
  const octets = hostname.split(".").map(Number);
  if (octets.some((octet) => octet > 255)) return true;
  return octets[0] === 0
    || octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 169 && octets[1] === 254)
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
};

const assertPublicUrl = (value) => {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new ApiError(400, "原文連結格式不正確。");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new ApiError(400, "原文連結必須是公開的 HTTP 或 HTTPS 網址。");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const blockedHost = hostname === "localhost"
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname === "metadata.google.internal"
    || hostname === "::1"
    || hostname.startsWith("fe80:")
    || isPrivateIpv4(hostname);
  if (!hostname || blockedHost) throw new ApiError(400, "原文連結不是可安全擷取的公開網址。");
  return url;
};

const fetchWithTimeout = async (url, options = {}, timeoutMs = 15_000) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new ApiError(504, "擷取原文逾時，請稍後再試或改以人工整理。", { allowMetadataFallback: true });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

const fetchPublicPage = async (rawUrl) => {
  let current = assertPublicUrl(rawUrl).href;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetchWithTimeout(current, {
      redirect: "manual",
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.4",
        "accept-language": "zh-TW,zh;q=0.9,en;q=0.6",
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new ApiError(502, "原文連結轉址失敗，請改從原媒體網址擷取。");
      current = assertPublicUrl(new URL(location, current).href).href;
      continue;
    }
    if (!response.ok) {
      throw new ApiError(502, `原文頁面暫時無法讀取（${response.status}）。`, {
        sourceStatus: response.status,
        allowMetadataFallback: true,
      });
    }
    const contentType = response.headers.get("content-type") || "";
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      throw new ApiError(422, "這個連結不是可讀取的新聞網頁。", { allowMetadataFallback: true });
    }
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (declaredSize > MAX_PAGE_CHARS * 2) {
      throw new ApiError(422, "原文頁面過大，請改以人工整理。", { allowMetadataFallback: true });
    }
    const html = await response.text();
    if (!html.trim()) throw new ApiError(422, "原文頁面沒有可讀取內容。", { allowMetadataFallback: true });
    return { html: html.slice(0, MAX_PAGE_CHARS), url: current };
  }
  throw new ApiError(502, "原文連結轉址次數過多，請改從原媒體網址擷取。", { allowMetadataFallback: true });
};

const htmlDecode = (value) => String(value || "")
  .replace(/&nbsp;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, "<")
  .replace(/&gt;/gi, ">")
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));

const htmlToText = (value) => trimText(htmlDecode(String(value || "")
  .replace(/<(script|style|noscript|svg|iframe)[^>]*>[\s\S]*?<\/\1>/gi, " ")
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<\/(p|div|li|h[1-6]|section|article)>/gi, "\n")
  .replace(/<[^>]+>/g, " ")));

const attributeValue = (tag, name) => {
  const quoted = new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i").exec(tag);
  if (quoted) return htmlDecode(quoted[2]);
  const bare = new RegExp(`\\b${name}\\s*=\\s*([^\\s>]+)`, "i").exec(tag);
  return bare ? htmlDecode(bare[1]) : "";
};

const metaValue = (html, names) => {
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const element = tag[0];
    const key = (attributeValue(element, "property") || attributeValue(element, "name")).toLowerCase();
    if (names.includes(key)) return attributeValue(element, "content");
  }
  return "";
};

const canonicalFromHtml = (html, fallback) => {
  const link = /<link\b[^>]*\brel=(["'])canonical\1[^>]*>/i.exec(html)?.[0]
    || /<link\b[^>]*\bhref=(["'])[^"']+\1[^>]*\brel=(["'])canonical\2[^>]*>/i.exec(html)?.[0];
  const candidate = link ? attributeValue(link, "href") : fallback;
  try { return assertPublicUrl(new URL(candidate, fallback).href).href; } catch { return fallback; }
};

const jsonLdValues = (html) => {
  const values = [];
  for (const match of html.matchAll(/<script\b[^>]*type=(["'])application\/ld\+json\1[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(match[2].trim());
      const queue = Array.isArray(parsed) ? [...parsed] : [parsed];
      while (queue.length) {
        const item = queue.shift();
        if (!item || typeof item !== "object") continue;
        if (Array.isArray(item)) { queue.push(...item); continue; }
        if (Array.isArray(item["@graph"])) queue.push(...item["@graph"]);
        if (typeof item.articleBody === "string") values.push(htmlToText(item.articleBody));
        if (typeof item.description === "string") values.push(htmlToText(item.description));
      }
    } catch {
      // Invalid JSON-LD is common on publisher pages; other extractors still run.
    }
  }
  return values.filter(Boolean);
};

const articleMarkupText = (html) => {
  const article = /<article\b[^>]*>([\s\S]{0,500000}?)<\/article>/i.exec(html)?.[1];
  const main = /<main\b[^>]*>([\s\S]{0,500000}?)<\/main>/i.exec(html)?.[1];
  return [article, main].map(htmlToText).sort((left, right) => right.length - left.length)[0] || "";
};

const googleNewsArticleId = (rawUrl) => {
  const url = new URL(rawUrl);
  if (!/(^|\.)news\.google\.com$/i.test(url.hostname)) return "";
  const parts = url.pathname.split("/").filter(Boolean);
  const marker = parts.findIndex((part) => part === "articles" || part === "read");
  return marker >= 0 ? parts[marker + 1] || "" : "";
};

const resolveGoogleNewsUrl = async (rawUrl) => {
  const articleId = googleNewsArticleId(rawUrl);
  if (!articleId) return rawUrl;
  const articlePage = await fetchPublicPage(`https://news.google.com/articles/${encodeURIComponent(articleId)}?hl=zh-TW&gl=TW&ceid=TW:zh-Hant`);
  const signature = /data-n-a-sg="([^"]+)"/i.exec(articlePage.html)?.[1];
  const timestamp = /data-n-a-ts="(\d+)"/i.exec(articlePage.html)?.[1];
  if (!signature || !timestamp) {
    throw new ApiError(422, "Google News 原文跳轉暫時無法解析，請改從媒體原始連結擷取。", { allowMetadataFallback: true });
  }

  const rpcArgs = [
    "garturlreq",
    [["X", "X", ["X", "X"], null, null, 1, 1, "TW:zh-Hant", null, 1, null, null, null, null, null, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0],
    articleId,
    Number(timestamp),
    signature,
  ];
  const rpcPayload = [[["Fbv4je", JSON.stringify(rpcArgs), null, "generic"]]];
  const response = await fetchWithTimeout("https://news.google.com/_/DotsSplashUi/data/batchexecute", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: `f.req=${encodeURIComponent(JSON.stringify(rpcPayload))}`,
  });
  if (!response.ok) {
    throw new ApiError(502, "Google News 原文跳轉服務暫時無法讀取。", { allowMetadataFallback: true });
  }
  const responseText = await response.text();
  for (const block of responseText.split("\n\n")) {
    try {
      const parsed = JSON.parse(block);
      const entry = parsed.find((row) => Array.isArray(row) && row[1] === "Fbv4je");
      if (!entry || typeof entry[2] !== "string") continue;
      const decoded = JSON.parse(entry[2]);
      if (typeof decoded?.[1] === "string") return assertPublicUrl(decoded[1]).href;
    } catch {
      // The batchexecute response includes non-JSON framing blocks.
    }
  }
  throw new ApiError(422, "Google News 原文跳轉暫時無法解析，請改從媒體原始連結擷取。", { allowMetadataFallback: true });
};

const extractArticle = async (rawUrl) => {
  const resolvedUrl = await resolveGoogleNewsUrl(rawUrl);
  const page = await fetchPublicPage(resolvedUrl);
  const description = trimText(metaValue(page.html, ["og:description", "twitter:description", "description"]), 1_500);
  const title = trimText(metaValue(page.html, ["og:title", "twitter:title"]), 500);
  const candidates = [articleMarkupText(page.html), ...jsonLdValues(page.html), description]
    .map((value) => trimText(value))
    .filter((value) => value.length >= 50)
    .sort((left, right) => right.length - left.length);
  const primary = candidates[0] || "";
  const sourceText = trimText([description, primary].filter(Boolean).join("\n"));
  if (sourceText.length < 90) {
    throw new ApiError(422, "原文可公開讀取的內容不足，可能受付費牆、登入或網站限制影響；請改以人工整理。", { allowMetadataFallback: true });
  }
  return {
    canonicalUrl: canonicalFromHtml(page.html, page.url),
    pageTitle: title,
    sourceText,
    sourceCharacters: sourceText.length,
    sourceMode: "public_article",
    sourceWarnings: [],
  };
};

const sourceAccessWarning = (error) => {
  const status = Number(error?.sourceStatus);
  if (status === 429) return "原文網站暫時限制自動讀取（429）；此草稿僅依新聞標題產生，請開啟原文後人工核對。";
  if (status) return `原文網站暫時無法讀取（${status}）；此草稿僅依新聞標題產生，請開啟原文後人工核對。`;
  return "原文暫時無法讀取；此草稿僅依新聞標題產生，請開啟原文後人工核對。";
};

const metadataArticle = (metadata, error) => {
  const pastedText = usefulSourceText(metadata.articleText, 60);
  if (pastedText) {
    return {
      canonicalUrl: metadata.url,
      pageTitle: metadata.title,
      sourceText: pastedText,
      sourceCharacters: pastedText.length,
      sourceMode: "pasted_text",
      sourceWarnings: ["此草稿依貼入的原文／節錄產生，請確認內容完整且與原文一致。"],
    };
  }
  const monitoringExcerpt = usefulSourceText(metadata.excerpt);
  if (monitoringExcerpt) {
    return {
      canonicalUrl: metadata.url,
      pageTitle: metadata.title,
      sourceText: monitoringExcerpt,
      sourceCharacters: monitoringExcerpt.length,
      sourceMode: "monitoring_excerpt",
      sourceWarnings: ["此草稿依監測來源提供的摘要／節錄產生，請開啟原文後人工核對。"],
    };
  }
  const headlineText = [
    `新聞標題：${metadata.title}`,
    metadata.source ? `媒體：${metadata.source}` : "",
    metadata.date ? `日期：${metadata.date}` : "",
  ].filter(Boolean).join("\n");
  return {
    canonicalUrl: metadata.url,
    pageTitle: metadata.title,
    sourceText: headlineText,
    sourceCharacters: trimText(metadata.title, 500).length,
    sourceMode: "headline",
    sourceWarnings: [sourceAccessWarning(error)],
  };
};

const extractSummarySource = async (metadata) => {
  const pastedText = usefulSourceText(metadata.articleText, 60);
  if (pastedText) return metadataArticle(metadata);
  try {
    return await extractArticle(metadata.url);
  } catch (error) {
    if (!(error instanceof ApiError) || !error.allowMetadataFallback) throw error;
    return metadataArticle(metadata, error);
  }
};

const draftSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string", description: "一到兩句的繁體中文事實摘要，不用 markdown。" },
    note: { type: "string", description: "選填。需要時以『背景：』、『數據：』或『限制：』開頭的繁體中文補充；無則為空字串。" },
    warnings: { type: "array", items: { type: "string" }, description: "需人工查核的事項，最多三項。" },
  },
  required: ["summary", "note", "warnings"],
};

const openAiConfigurationMessage = (status, payload, model) => {
  const type = String(payload?.error?.type || "").toLowerCase();
  const code = String(payload?.error?.code || "").toLowerCase();
  if (status === 401 || type.includes("authentication") || code.includes("api_key")) {
    return "OpenAI API 金鑰無效、已撤銷，或不是 API 平台金鑰；請在 Cloudflare 更新 OPENAI_API_KEY。";
  }
  if (code === "credit_balance_exhausted") {
    return "OpenAI API 預付額度已用完；請到 Billing 加入 API 額度。ChatGPT 訂閱不含 API 額度。";
  }
  if (["organization_spend_limit_exceeded", "project_spend_limit_exceeded"].includes(code)) {
    return "OpenAI API 已達組織或專案支出上限；請到對應的 Limits 設定確認，不要重複按產生摘要。";
  }
  if (code === "organization_usage_limit_exceeded") {
    return "OpenAI API 已達帳號核准的用量上限；請到 Usage limits 確認或申請提高額度。";
  }
  if (code === "insufficient_quota" || type === "insufficient_quota") {
    return "OpenAI API 額度不足；請到 Billing 確認餘額及支出上限。重建金鑰或重複重試無法補充額度。";
  }
  if (type.includes("rate_limit") || ["rate_limit_exceeded", "slow_down"].includes(code)) {
    return "OpenAI API 請求太頻繁，暫時達到速率限制；請稍後再試，先不要連續按產生摘要。";
  }
  if (status === 429) {
    return "OpenAI API 回傳 429，但未提供可辨識的原因；請確認 Billing 和 Usage limits。";
  }
  if (status === 404 || code.includes("model")) {
    return `OpenAI API 無法使用模型 ${model}；請確認 OPENAI_MODEL 或帳號的模型存取權。`;
  }
  return `OpenAI API 暫時拒絕摘要請求（HTTP ${status || "未知"}）；請先使用「檢查設定」驗證金鑰與模型。`;
};

const safeProviderCode = (payload) => {
  const code = String(payload?.error?.code || payload?.error?.type || "").toLowerCase();
  return /^[a-z0-9_]{1,80}$/.test(code) ? code : "";
};

const responseOutputText = (payload) => {
  if (payload?.status === "incomplete") {
    throw new ApiError(502, "摘要回應未完成，尚未套用任何內容；請管理員檢查輸出長度或改用適合短摘要的模型。", { providerCode: "incomplete_response" });
  }
  if (payload?.status === "failed" || payload?.error) {
    throw new ApiError(502, "摘要模型執行失敗，尚未套用任何內容；請稍後再試。", { providerCode: safeProviderCode(payload) });
  }
  // Raw REST responses use output[].content[]; output_text is an SDK helper.
  const content = (Array.isArray(payload?.output) ? payload.output : [])
    .filter((item) => item?.type === "message" && item?.role === "assistant")
    .flatMap((item) => Array.isArray(item.content) ? item.content : []);
  if (content.some((item) => item?.type === "refusal")) {
    throw new ApiError(422, "模型未能為這則內容產生摘要；請改以人工整理。", { providerCode: "model_refusal" });
  }
  return content.filter((item) => item?.type === "output_text" && typeof item.text === "string")
    .map((item) => item.text).join("");
};

const configuredSummaryService = (request, env) => {
  const requiredAccessKey = String(env.PR_SUMMARY_ACCESS_KEY || "").trim();
  const openaiKey = String(env.OPENAI_API_KEY || "").trim();
  if (!requiredAccessKey || !openaiKey) return { error: "摘要功能尚未完成管理員設定。", status: 503 };
  if (!constantTimeEqual(request.headers.get("x-pr-summary-key"), requiredAccessKey)) {
    return { error: "摘要存取碼不正確或尚未啟用。", status: 401 };
  }
  return { requiredAccessKey, openaiKey, model: String(env.OPENAI_MODEL || "gpt-6-astra").trim() };
};

const createSummaryDraft = async (env, metadata, article) => {
  const model = String(env.OPENAI_MODEL || "gpt-6-astra").trim();
  const headlineOnly = article.sourceMode === "headline";
  const source = [
    `新聞標題：${metadata.title}`,
    `媒體：${metadata.source || "未註明"}`,
    `日期：${metadata.date || "未註明"}`,
    `可用資料模式：${headlineOnly ? "僅新聞標題，非原文全文" : article.sourceMode === "pasted_text" ? "使用者貼入的原文／節錄" : article.sourceMode === "monitoring_excerpt" ? "監測來源提供的摘要／節錄" : "公開原文"}`,
    `可用內容：${article.sourceText}`,
  ].join("\n\n");
  const response = await fetchWithTimeout("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      store: false,
      max_output_tokens: 650,
      ...(model === "gpt-6-astra" ? { reasoning: { effort: "low" } } : {}),
      instructions: `你是台灣企業公關週報編輯。只可依據提供的可用內容撰寫，不得猜測、補充外部知識或把標題視為已證實事實。以繁體中文輸出，語氣客觀、精簡，模仿企業週報：先寫主體、動作、關鍵事實或數字；若來源資訊不足，摘要要明確保留限制，並在 warnings 提醒人工核對。${headlineOnly ? "目前只有新聞標題：摘要必須明確寫成『標題顯示／報導標題提及』的保守說法，不得補出時程、原因、數字、合作細節或影響。" : ""}不要使用條列、網址、媒體名稱開頭、評價性語言或 Markdown。`,
      input: source,
      text: {
        format: {
          type: "json_schema",
          name: "weekly_pr_summary",
          strict: true,
          schema: draftSchema,
        },
      },
    }),
  }, 30_000);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error("OpenAI summary request failed", { status: response.status, type: payload?.error?.type });
    throw new ApiError(502, openAiConfigurationMessage(response.status, payload, model), { providerCode: safeProviderCode(payload) });
  }
  const output = responseOutputText(payload);
  let draft;
  try { draft = JSON.parse(output); } catch { throw new ApiError(502, "摘要模型回傳格式暫時無法讀取，請稍後再試。"); }
  const summary = plainDraftText(draft?.summary, 420);
  if (!summary) throw new ApiError(502, "摘要模型沒有產生可用草稿，請改以人工整理。");
  const note = plainDraftText(draft?.note, 300);
  const modelWarnings = Array.isArray(draft?.warnings)
    ? draft.warnings.map((warning) => plainDraftText(warning, 110)).filter(Boolean).slice(0, 3)
    : [];
  const warnings = [...new Set([...(article.sourceWarnings || []), ...modelWarnings])].slice(0, 3);
  return { summary, note, warnings, sourceMode: article.sourceMode || "public_article" };
};

const parseRequest = async (request) => {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_REQUEST_CHARS) throw new ApiError(413, "摘要請求內容過大。");
  const raw = await request.text();
  if (raw.length > MAX_REQUEST_CHARS) throw new ApiError(413, "摘要請求內容過大。");
  let body;
  try { body = JSON.parse(raw); } catch { throw new ApiError(400, "摘要請求格式不正確。"); }
  const title = plainDraftText(body?.title, 500);
  if (!title) throw new ApiError(400, "缺少新聞標題。");
  const url = assertPublicUrl(body?.url).href;
  return {
    title,
    url,
    source: plainDraftText(body?.source, 120),
    date: plainDraftText(body?.date, 24),
    excerpt: plainDraftText(body?.excerpt, 2_000),
    articleText: plainDraftText(body?.articleText, MAX_SOURCE_CHARS),
  };
};

const handleSummaryRequest = async (request, env) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
  if (request.method !== "POST") return jsonResponse(request, 405, { error: { message: "只支援 POST 請求。" } });
  const configured = configuredSummaryService(request, env);
  if (configured.error) return jsonResponse(request, configured.status, { error: { message: configured.error } });
  try {
    const metadata = await parseRequest(request);
    const article = await extractSummarySource(metadata);
    const draft = await createSummaryDraft(env, metadata, article);
    return jsonResponse(request, 200, {
      draft: {
        status: "ready",
        ...draft,
        canonicalUrl: article.canonicalUrl,
        sourceCharacters: article.sourceCharacters,
        sourceMode: draft.sourceMode,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 502;
    if (!(error instanceof ApiError)) console.error("Unexpected summary error", error);
    return jsonResponse(request, status, { error: { message: error?.message || "摘要服務暫時無法使用。", ...(error?.providerCode ? { code: error.providerCode } : {}) } });
  }
};

const handleSummaryStatusRequest = async (request, env) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
  if (request.method !== "POST") return jsonResponse(request, 405, { error: { message: "只支援 POST 請求。" } });
  const configured = configuredSummaryService(request, env);
  if (configured.error) return jsonResponse(request, configured.status, { error: { message: configured.error } });
  try {
    const response = await fetchWithTimeout(`https://api.openai.com/v1/models/${encodeURIComponent(configured.model)}`, {
      headers: { authorization: `Bearer ${configured.openaiKey}` },
    }, 12_000);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error("OpenAI summary configuration check failed", { status: response.status, type: payload?.error?.type });
      return jsonResponse(request, 200, {
        status: "error",
        model: configured.model,
        message: openAiConfigurationMessage(response.status, payload, configured.model),
        code: safeProviderCode(payload),
      });
    }
    return jsonResponse(request, 200, {
      status: "ready",
      model: configured.model,
      message: `金鑰驗證與模型 ${configured.model} 查詢通過；此檢查不驗證 API 餘額或摘要生成權限。`,
    });
  } catch (error) {
    const message = error instanceof ApiError
      ? "OpenAI API 設定檢查逾時，請稍後重試。"
      : "OpenAI API 設定暫時無法檢查，請稍後重試。";
    return jsonResponse(request, 200, { status: "error", model: configured.model, message });
  }
};

export { extractArticle, handleSummaryRequest, handleSummaryStatusRequest, resolveGoogleNewsUrl };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/summarize") return handleSummaryRequest(request, env);
    if (url.pathname === "/api/summary-status") return handleSummaryStatusRequest(request, env);
    return env.ASSETS.fetch(request);
  },
};
