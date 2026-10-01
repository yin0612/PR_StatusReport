import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import worker, { extractArticle, handleSummaryRequest, handleSummaryStatusRequest } from "../src/index.js";
import { buildArticleCache } from "../scripts/build-article-cache.mjs";
import { SUMMARY_MODEL, SUMMARY_VERSION } from "../src/cloudflare-summary.js";
import { summaryInputKey, canReuseSummaryDraft } from "../dist/summary-cache.js";

const articleText = "企業宣布推出新的支付服務，服務預計於十月上線，首波將與五十家商店合作，並說明會員使用方式。".repeat(4);
const modelOutput = { summary: "企業宣布十月推出新的支付服務，首波與五十家商店合作，並說明會員使用方式。", note: "", warnings: [] };
const completion = (draft = modelOutput, finish_reason = "stop") => ({ choices: [{ message: { role: "assistant", content: JSON.stringify(draft) }, finish_reason }] });
const envFor = (run) => ({ PR_SUMMARY_ACCESS_KEY: "test-access", PR_SUMMARY_FREE_PLAN_CONFIRMED: "true", AI: { run } });
const request = (body = {}, key = "test-access", headers = {}) => new Request("https://example.com/api/summarize", {
  method: "POST", headers: { "content-type": "application/json", "x-pr-summary-key": key, ...headers },
  body: JSON.stringify({ title: "測試新聞", url: "https://example.com/news", articleText, ...body }),
});

test("runs only the fixed free model, without an OpenAI key or network API", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("External API must not be called"); });
  let calls = 0;
  const env = envFor(async (model, input) => {
    calls += 1;
    assert.equal(model, SUMMARY_MODEL);
    assert.equal(input.stream, false);
    assert.equal(input.max_tokens, 900);
    assert.equal(input.response_format.type, "json_object");
    assert.ok(input.messages[0].content.includes("繁體中文"));
    return completion();
  });
  env.OPENAI_MODEL = "paid-model";
  env.CLOUDFLARE_AI_MODEL = "@cf/zai-org/glm-5.3";
  const response = await handleSummaryRequest(request(), env);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.draft.summary, modelOutput.summary);
  assert.equal(payload.draft.provider, "cloudflare");
  assert.equal(payload.draft.version, SUMMARY_VERSION);
  assert.equal(payload.draft.sourceMode, "pasted_text");
  assert.equal(calls, 1);
});

for (const value of [undefined, "false", "paid", ""]) {
  test(`fails closed when Free plan confirmation is ${String(value)}`, async () => {
    const env = envFor(() => { throw new Error("Must not run before plan confirmation"); });
    env.PR_SUMMARY_FREE_PLAN_CONFIRMED = value;
    const response = await handleSummaryRequest(request(), env);
    assert.equal(response.status, 503);
    assert.ok((await response.json()).error.message.includes("Free"));
  });
}

test("missing AI binding has an actionable error", async () => {
  const env = envFor(() => {});
  delete env.AI;
  const response = await handleSummaryRequest(request(), env);
  assert.equal(response.status, 503);
  assert.ok((await response.json()).error.message.includes("AI binding"));
});

test("invalid access key never calls AI", async () => {
  const response = await handleSummaryRequest(request({}, "wrong"), envFor(() => { throw new Error("Must not run"); }));
  assert.equal(response.status, 401);
});

test("configuration check is local and does not consume AI allocation", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("Must not call any API"); });
  const response = await handleSummaryStatusRequest(request(), envFor(() => { throw new Error("Must not run AI"); }));
  const payload = await response.json();
  assert.equal(payload.provider, "cloudflare");
  assert.equal(payload.freeOnly, true);
  assert.ok(payload.message.includes("不查詢今日剩餘額度"));
});

test("identical server input reuses the result; changed source runs once more", async () => {
  let calls = 0;
  const env = envFor(async () => { calls += 1; return completion(); });
  assert.equal((await (await handleSummaryRequest(request(), env)).json()).draft.cached, false);
  assert.equal((await (await handleSummaryRequest(request(), env)).json()).draft.cached, true);
  await handleSummaryRequest(request({ articleText: `${articleText} 新增資訊。` }), env);
  assert.equal(calls, 2);
});

test("concurrent identical requests share one inference", async () => {
  let calls = 0;
  let resolveRun;
  const waiting = new Promise((resolve) => { resolveRun = resolve; });
  let started;
  const hasStarted = new Promise((resolve) => { started = resolve; });
  const env = envFor(async () => { calls += 1; started(); return waiting; });
  const first = handleSummaryRequest(request(), env);
  await hasStarted;
  const second = handleSummaryRequest(request(), env);
  resolveRun(completion());
  const responses = await Promise.all([first, second]);
  assert.ok(responses.every((response) => response.status === 200));
  assert.equal(calls, 1);
});

test("3036 exhausts quota, blocks further calls and does not fall back", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("No paid fallback"); });
  let calls = 0;
  const env = envFor(async () => { calls += 1; throw new Error("AiError: 3036: You have used up your daily free allocation of 10,000 neurons."); });
  const first = await handleSummaryRequest(request(), env);
  const error = (await first.json()).error;
  assert.equal(first.status, 429);
  assert.equal(error.code, "cloudflare_free_quota_exhausted");
  assert.ok(Date.parse(error.retryAt) > Date.now());
  assert.equal(new Date(error.retryAt).getUTCHours(), 0);
  const second = await handleSummaryRequest(request({ title: "其他新聞" }), env);
  assert.equal((await second.json()).error.code, error.code);
  assert.equal(calls, 1);
});

for (const [code, expected] of [[5035, "cloudflare_paid_model_blocked"], [3040, "cloudflare_ai_busy"], [5016, "cloudflare_ai_access_required"]]) {
  test(`Cloudflare ${code} stops without retry or paid fallback`, async () => {
    let calls = 0;
    const env = envFor(async () => { calls += 1; throw { code }; });
    const response = await handleSummaryRequest(request(), env);
    assert.equal((await response.json()).error.code, expected);
    assert.equal(calls, 1);
  });
}

test("busy is not misreported as exhausted daily quota", async () => {
  let calls = 0;
  const env = envFor(async () => { calls += 1; if (calls === 1) throw { code: 3040 }; return completion(); });
  assert.equal((await (await handleSummaryRequest(request(), env)).json()).error.code, "cloudflare_ai_busy");
  assert.equal((await handleSummaryRequest(request(), env)).status, 200);
  assert.equal(calls, 2);
});

test("cached summaries remain available after daily quota exhaustion", async () => {
  let calls = 0;
  const env = envFor(async () => { calls += 1; if (calls > 1) throw { code: 3036 }; return completion(); });
  await handleSummaryRequest(request(), env);
  await handleSummaryRequest(request({ title: "另一則新聞" }), env);
  const result = await (await handleSummaryRequest(request(), env)).json();
  assert.equal(result.draft.cached, true);
  assert.equal(calls, 2);
});

test("unreadable article with headline only does not spend any AI allocation", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("limited", { status: 429 }));
  const env = envFor(() => { throw new Error("Do not rewrite headlines using AI"); });
  const response = await handleSummaryRequest(request({ articleText: "", excerpt: "Google News RSS 聚合僅提供標題與發布時間；請開啟原文閱讀完整內容。" }), env);
  const payload = await response.json();
  assert.equal(response.status, 422);
  assert.equal(payload.error.code, "article_body_unavailable");
  assert.equal(payload.draft, undefined);
  assert.ok(payload.error.message.includes("429"));
});

test("available monitoring excerpt is summarized when publisher blocks access", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("limited", { status: 429 }));
  const env = envFor(async () => completion());
  const draft = (await (await handleSummaryRequest(request({ articleText: "", excerpt: articleText }), env)).json()).draft;
  assert.equal(draft.sourceMode, "monitoring_excerpt");
  assert.ok(draft.warnings.length);
});

test("Chinese source body is not rejected just because UTF-8 uses multiple bytes", async () => {
  const body = { articleText: "中文新聞內容。".repeat(500) };
  const byteLength = Buffer.byteLength(JSON.stringify({ title: "測試新聞", url: "https://example.com/news", ...body }));
  assert.ok(byteLength > 8192);
  const response = await handleSummaryRequest(request(body, "test-access", { "content-length": String(byteLength) }), envFor(async () => completion()));
  assert.equal(response.status, 200);
});

for (const [output, code] of [
  [completion(modelOutput, "length"), "incomplete_response"],
  [completion({ summary: "", note: "", warnings: [] }), "invalid_summary_draft"],
  [{ choices: [{ message: { content: "not JSON" } }] }, "invalid_summary_json"],
  [{ choices: [{ message: { content: "<think>not finished" } }] }, "incomplete_response"],
]) {
  test(`invalid result (${code}) cannot enter the draft`, async () => {
    const response = await handleSummaryRequest(request(), envFor(async () => output));
    const payload = await response.json();
    assert.equal(payload.error.code, code);
    assert.equal(payload.draft, undefined);
  });
}

test("local cache survives JSON persistence and invalidates when source changes", async () => {
  const item = { title: "新聞", source: "媒體", url: "https://example.com/news", date: "2026-10-01", excerpt: "", aiSourceText: articleText };
  const inputKey = await summaryInputKey(item);
  const draft = JSON.parse(JSON.stringify({ ...modelOutput, provider: "cloudflare", version: SUMMARY_VERSION, inputKey }));
  assert.equal(canReuseSummaryDraft(draft, await summaryInputKey(item)), true);
  assert.equal(canReuseSummaryDraft(draft, await summaryInputKey({ ...item, aiSourceText: "不同內容" })), false);
  assert.equal(canReuseSummaryDraft({ ...draft, provider: "openai" }, inputKey), false);
  assert.equal(canReuseSummaryDraft({ ...draft, version: "old" }, inputKey), false);
});

test("production source contains no paid endpoint or API key dependency", async () => {
  const main = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
  const ai = await readFile(new URL("../src/cloudflare-summary.js", import.meta.url), "utf8");
  assert.equal(/api\.openai\.com|OPENAI_API_KEY|OPENAI_MODEL/.test(main + ai), false);
});

test("publisher body excludes larger navigation and recommendations, including nested divs", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(`<main><div class="news_content BL">${"側欄假新聞。".repeat(100)}</div><article><section class="article_body"><div><p>${articleText}</p></div><p>最後一段的重要條件：每月上限200點。</p></section><aside>${"相關新聞。".repeat(100)}</aside></article></main>`, { headers: { "content-type": "text/html" } }));
  const article = await extractArticle("https://example.com/news");
  assert.equal(article.sourceMode, "public_article");
  assert.ok(article.sourceText.includes("最後一段的重要條件"));
  assert.equal(article.sourceText.includes("側欄假新聞"), false);
  assert.equal(article.sourceText.includes("相關新聞"), false);
});

test("JSON-LD body is read in full; metadata description is not labelled a full article", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(`<script type="application/ld+json">${JSON.stringify({ "@type": "NewsArticle", articleBody: articleText, description: "短描述" })}</script>`, { headers: { "content-type": "text/html" } }));
  assert.equal((await extractArticle("https://example.com/news")).sourceText, articleText);
  t.mock.method(globalThis, "fetch", async () => new Response(`<meta name="description" content="${articleText}">`, { headers: { "content-type": "text/html" } }));
  const excerpt = await extractArticle("https://example.com/news");
  assert.equal(excerpt.sourceMode, "public_excerpt");
  assert.ok(excerpt.sourceWarnings[0].includes("未取得完整內文"));
});

test("long bodies retain the ending and disclose that the middle was shortened", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(`<article>${"正文。".repeat(6000)}最後關鍵數字123</article>`, { headers: { "content-type": "text/html" } }));
  const article = await extractArticle("https://example.com/news");
  assert.ok(article.sourceText.endsWith("最後關鍵數字123"));
  assert.ok(article.sourceText.length <= 16000);
  assert.equal(article.truncated, true);
  assert.ok(article.sourceWarnings[0].includes("並非完整內文"));
});

test("private build cache supplies body to AI when live fetching is blocked and does not return it", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("Cached source must avoid restricted live request"); });
  let inputText;
  const env = envFor(async (_, input) => { inputText = input.messages[1].content; return completion(); });
  env.ARTICLE_CACHE = { items: { "https://example.com/news": { title: "測試新聞", canonicalUrl: "https://example.com/original", sourceText: articleText, sourceCharacters: articleText.length, sourceMode: "public_article", sourceWarnings: [], fetchedAt: new Date().toISOString() } } };
  const response = await handleSummaryRequest(request({ articleText: "" }), env);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.draft.sourceMode, "cached_article");
  assert.equal(payload.draft.sourceCharacters, articleText.length);
  assert.ok(inputText.includes(articleText));
  assert.equal(JSON.stringify(payload).includes(articleText), false);
});

test("stale or mismatched caches cannot be used for a different article", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("blocked", { status: 403 }));
  for (const entry of [{ title: "其他文章", fetchedAt: new Date().toISOString() }, { title: "測試新聞", fetchedAt: "2020-01-01" }]) {
    const env = envFor(() => { throw new Error("No usable article, no AI"); });
    env.ARTICLE_CACHE = { items: { "https://example.com/news": { ...entry, sourceText: articleText } } };
    const response = await handleSummaryRequest(request({ articleText: "" }), env);
    assert.equal(response.status, 422);
  }
});

test("build collectors isolate source failures, preserve URLs, and never use AI", async () => {
  const cache = await buildArticleCache([{ title: "可讀", url: "https://example.com/read" }, { title: "受限", url: "https://example.com/blocked" }], async (url) => {
    if (url.endsWith("blocked")) throw { status: 403 };
    return { sourceText: articleText, sourceMode: "public_article" };
  });
  assert.equal(cache.total, 2);
  assert.equal(cache.items["https://example.com/read"].title, "可讀");
  assert.equal(cache.failures["https://example.com/blocked"].status, 403);
});

test("article cache is never a static asset or publicly exposed API", async () => {
  const config = JSON.parse(await readFile(new URL("../wrangler.json", import.meta.url), "utf8"));
  assert.equal(config.assets.directory, "./dist");
  const entry = await readFile(new URL("../src/worker.js", import.meta.url), "utf8");
  assert.ok(entry.includes("../.generated/article-cache.json"));
  const response = await worker.fetch(new Request("https://example.com/api/article-cache"), { ARTICLE_CACHE: { secret: articleText }, ASSETS: { fetch: () => new Response("public site") } });
  assert.equal(await response.text(), "public site");
});
