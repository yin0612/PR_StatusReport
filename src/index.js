import { SummaryError as ApiError, SUMMARY_MODEL, createSummaryDraft } from "./cloudflare-summary.js";

const ALLOWED_ORIGINS = new Set([
  "https://pr-statusreport.media-monitoring-worker.workers.dev",
  "https://yin0612.github.io",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
  "http://localhost:8787",
  "http://127.0.0.1:8787",
]);

const MAX_REQUEST_CHARS = 24_000;
const MAX_PAGE_CHARS = 1_200_000;
const MAX_SOURCE_CHARS = 16_000;
const MAX_REDIRECTS = 5;

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

const fetchPublicPage = async (rawUrl, options = {}) => {
  let current = assertPublicUrl(rawUrl).href;
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    const response = await fetchWithTimeout(current, {
      redirect: "manual",
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.4",
        "accept-language": "zh-TW,zh;q=0.9,en;q=0.6",
      },
    }, options.timeoutMs || 15_000);
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
  .replace(/<[^>]+>/g, " ")), 120_000);

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
      }
    } catch {
      // Invalid JSON-LD is common on publisher pages; other extractors still run.
    }
  }
  return values.filter(Boolean);
};

const articleMarkupText = (html) => {
  // Prefer the actual body over <main>, which often contains unrelated news.
  for (const opening of html.matchAll(/<(div|section|article)\b[^>]*>/gi)) {
    const marker = `${attributeValue(opening[0], "id")} ${attributeValue(opening[0], "class")}`;
    if (attributeValue(opening[0], "itemprop") !== "articleBody"
      && !/(?:^|\s)(?:caas-body|article[-_]content|article[-_]body|article[-_]text|newsContent|story[-_]content)(?:\s|$)/i.test(marker)) continue;
    const start = opening.index + opening[0].length;
    const tags = new RegExp(`<\\/?${opening[1]}\\b[^>]*>`, "gi");
    tags.lastIndex = start;
    let depth = 1;
    for (let next = tags.exec(html); next; next = tags.exec(html)) {
      depth += /^<\//.test(next[0]) ? -1 : /\/>$/.test(next[0]) ? 0 : 1;
      if (!depth) {
        const text = htmlToText(html.slice(start, next.index));
        if (text.length >= 90) return text;
        break;
      }
    }
  }
  const article = /<article\b[^>]*>([\s\S]{0,500000}?)<\/article>/i.exec(html)?.[1];
  return htmlToText(article);
};

const googleNewsArticleId = (rawUrl) => {
  const url = new URL(rawUrl);
  if (!/(^|\.)news\.google\.com$/i.test(url.hostname)) return "";
  const parts = url.pathname.split("/").filter(Boolean);
  const marker = parts.findIndex((part) => part === "articles" || part === "read");
  return marker >= 0 ? parts[marker + 1] || "" : "";
};

const resolveGoogleNewsUrl = async (rawUrl, options = {}) => {
  const articleId = googleNewsArticleId(rawUrl);
  if (!articleId) return rawUrl;
  const articlePage = await fetchPublicPage(`https://news.google.com/articles/${encodeURIComponent(articleId)}?hl=zh-TW&gl=TW&ceid=TW:zh-Hant`, options);
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
  }, options.timeoutMs || 15_000);
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

const extractArticle = async (rawUrl, options = {}) => {
  const resolvedUrl = await resolveGoogleNewsUrl(rawUrl, options);
  const page = await fetchPublicPage(resolvedUrl, options);
  const description = trimText(metaValue(page.html, ["og:description", "twitter:description", "description"]), 1_500);
  const title = trimText(metaValue(page.html, ["og:title", "twitter:title"]), 500);
  const body = articleMarkupText(page.html) || jsonLdValues(page.html).sort((a, b) => b.length - a.length)[0] || "";
  const primary = (body || description).split(/(?:延伸閱讀|其他人也在看|檢視留言|新聞關鍵字[：:])/)[0].trim();
  const truncated = primary.length > MAX_SOURCE_CHARS;
  const sourceText = truncated ? `${primary.slice(0, 11_000)}\n（中段節略）\n${primary.slice(-4_950)}` : primary;
  if (sourceText.length < 90) {
    throw new ApiError(422, "原文可公開讀取的內容不足，可能受付費牆、登入或網站限制影響；請改以人工整理。", { allowMetadataFallback: true });
  }
  return {
    canonicalUrl: canonicalFromHtml(page.html, page.url),
    pageTitle: title,
    sourceText,
    sourceCharacters: sourceText.length,
    sourceMode: body ? "public_article" : "public_excerpt",
    sourceWarnings: [
      ...(!body ? ["僅取得媒體頁的描述節錄，未取得完整內文；請核對原文。"] : []),
      ...(truncated ? ["文章超過16,000字，摘要依前後段節錄產生，並非完整內文。"] : []),
    ],
    truncated,
  };
};

const sourceAccessWarning = (error) => {
  const status = Number(error?.sourceStatus);
  if (status === 429) return "原文網站暫時限制自動讀取（429）。";
  if (status) return `原文網站暫時無法讀取（${status}）。`;
  return "原文暫時無法讀取。";
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

const extractSummarySource = async (metadata, env) => {
  const pastedText = usefulSourceText(metadata.articleText, 60);
  if (pastedText) return metadataArticle(metadata);
  const cached = env.ARTICLE_CACHE?.items?.[metadata.url];
  if (cached && cached.title === metadata.title && usefulSourceText(cached.sourceText)
    && Date.parse(cached.fetchedAt) > Date.now() - 48 * 60 * 60 * 1000) {
    return { ...cached, sourceMode: cached.sourceMode === "public_article" ? "cached_article" : cached.sourceMode };
  }
  try {
    return await extractArticle(metadata.url);
  } catch (error) {
    if (!(error instanceof ApiError) || !error.allowMetadataFallback) throw error;
    return metadataArticle(metadata, error);
  }
};

const configuredSummaryService = (request, env) => {
  const requiredAccessKey = String(env.PR_SUMMARY_ACCESS_KEY || "").trim();
  if (!requiredAccessKey) return { error: "摘要功能尚未設定工作台存取碼。", status: 503 };
  if (!constantTimeEqual(request.headers.get("x-pr-summary-key"), requiredAccessKey)) {
    return { error: "摘要存取碼不正確或尚未啟用。", status: 401 };
  }
  // Fail closed until the owner has checked Workers Free in the account dashboard.
  // This flag is an attestation, not a billing API query. Keep the account on Free.
  if (String(env.PR_SUMMARY_FREE_PLAN_CONFIRMED) !== "true") {
    return { error: "免費摘要尚未啟用：請先確認 Cloudflare Workers 為 Free 方案，再設定 PR_SUMMARY_FREE_PLAN_CONFIRMED=true。", status: 503 };
  }
  if (typeof env.AI?.run !== "function") return { error: "Cloudflare AI 綁定尚未啟用，請重新部署或新增名稱為 AI 的 Workers AI binding。", status: 503 };
  return { model: SUMMARY_MODEL };
};

const parseRequest = async (request) => {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > MAX_REQUEST_CHARS * 4) throw new ApiError(413, "摘要請求內容過大。");
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
    const article = await extractSummarySource(metadata, env);
    const draft = await createSummaryDraft(env, metadata, article);
    return jsonResponse(request, 200, {
      draft: {
        status: "ready",
        ...draft,
        canonicalUrl: article.canonicalUrl,
        sourceCharacters: article.sourceCharacters,
        sourceMode: draft.sourceMode,
        sourceFetchedAt: article.fetchedAt || null,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    const status = error instanceof ApiError ? error.status : 502;
    if (!(error instanceof ApiError)) console.error("Unexpected summary error", error);
    return jsonResponse(request, status, { error: { message: error?.message || "摘要服務暫時無法使用。", ...(error?.providerCode ? { code: error.providerCode } : {}), ...(error?.retryAt ? { retryAt: error.retryAt } : {}) } });
  }
};

const handleSummaryStatusRequest = async (request, env) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request) });
  if (request.method !== "POST") return jsonResponse(request, 405, { error: { message: "只支援 POST 請求。" } });
  const configured = configuredSummaryService(request, env);
  if (configured.error) return jsonResponse(request, configured.status, { error: { message: configured.error } });
  return jsonResponse(request, 200, {
    status: "ready", provider: "cloudflare", model: configured.model, freeOnly: true,
    message: "Cloudflare 免費摘要的存取碼、AI 綁定及 Free 方案確認設定已就緒；此檢查不執行模型，也不查詢今日剩餘額度。",
    articleCache: {
      generatedAt: env.ARTICLE_CACHE?.generatedAt || null,
      available: Object.keys(env.ARTICLE_CACHE?.items || {}).length,
      total: Number(env.ARTICLE_CACHE?.total) || 0,
    },
  });
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
