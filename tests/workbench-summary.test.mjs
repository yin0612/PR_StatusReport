import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";
import { SUMMARY_VERSION, summaryInputKey, canReuseSummaryDraft } from "../dist/summary-cache.js";

const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
const script = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1]
  .replace(/^\s*import[^\n]+from "\.\/summary-cache\.js";\s*$/m, "")
  .replace("hydrate(); cleanOrder(); renderAll(true); persist(); loadMonitoringSnapshot();",
    "hydrate(); cleanOrder(); renderAll(true); persist(); globalThis.workbenchTest = { generateAiSummary, generateSelectedSummaries, checkSummarySetup, loadMonitoringSnapshot, renderDraft, setSelected, moveSelection, getState: () => state };");

const setup = (api, savedState) => {
  const elements = new Map();
  const storage = new Map();
  const listeners = new Map();
  const intervals = [];
  if (savedState) storage.set("pr-weekly-workbench-v3", JSON.stringify(savedState));
  const context = {
    SUMMARY_VERSION, summaryInputKey, canReuseSummaryDraft, URL, Date, Intl, console,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: (callback, ms) => { intervals.push({ callback, ms }); return 0; }, AbortSignal,
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    sessionStorage: { getItem: () => "test-access", setItem: () => {} },
    document: {
      querySelectorAll: () => [], addEventListener: (event, callback) => listeners.set(event, callback), visibilityState: "visible", activeElement: null,
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, { value: "", style: {}, addEventListener: () => {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} } });
        return elements.get(id);
      },
    },
    fetch: api,
  };
  vm.runInNewContext(script, context);
  return { harness: context.workbenchTest, elements, storage, listeners, intervals, document: context.document };
};
const draft = { status: "ready", summary: "測試企業宣布推出會員服務，首波與五十家商店合作。", note: "", warnings: [], provider: "cloudflare", version: SUMMARY_VERSION, sourceMode: "pasted_text" };

test("UI cache survives reload and avoids a second inference; source edits invalidate it", async () => {
  let calls = 0;
  const api = async () => { calls += 1; return Response.json({ draft }); };
  const first = setup(api);
  const item = first.harness.getState().news[0];
  item.aiSourceText = "貼入新聞原文。".repeat(20);
  await first.harness.generateAiSummary(item.id);
  assert.equal(calls, 1);
  assert.equal(item.summary, "遊戲服務與會員經營議題出現討論，建議關注使用者回饋與後續溝通節點。");
  assert.ok(first.elements.get("newsList").innerHTML.includes(draft.summary));
  assert.equal(first.elements.get("newsList").innerHTML.includes("aria-busy=\"true\""), false);
  const restored = setup(api, JSON.parse(first.storage.get("pr-weekly-workbench-v3")));
  await restored.harness.generateAiSummary(item.id);
  assert.equal(calls, 1);
  assert.ok(restored.elements.get("newsList").innerHTML.includes("已重用結果"));
  restored.harness.getState().news[0].aiSourceText += "新增內容。";
  await restored.harness.generateAiSummary(item.id);
  assert.equal(calls, 2);
});

test("UI persists quota stop across reloads, with full inline error and no retries", async () => {
  let calls = 0;
  const api = async () => { calls += 1; return Response.json({ error: { message: "今日免費額度用完", code: "cloudflare_free_quota_exhausted", retryAt: new Date(Date.now() + 60_000).toISOString() } }, { status: 429 }); };
  const first = setup(api);
  const item = first.harness.getState().news[0];
  await first.harness.generateAiSummary(item.id);
  assert.equal(calls, 1);
  assert.ok(first.elements.get("newsList").innerHTML.includes("cloudflare_free_quota_exhausted"));
  const restored = setup(api, JSON.parse(first.storage.get("pr-weekly-workbench-v3")));
  await restored.harness.generateAiSummary(item.id);
  assert.equal(calls, 1);
  assert.ok(restored.elements.get("newsList").innerHTML.includes("請等額度重置"));
});

test("unselected articles cannot trigger AI and missing setup stays visible", async () => {
  let calls = 0;
  const page = setup(async () => { calls += 1; return Response.json({ error: { message: "請先確認 Workers Free" } }, { status: 503 }); });
  const unselected = page.harness.getState().news.find((item) => !item.selected);
  await page.harness.generateAiSummary(unselected.id);
  assert.equal(calls, 0);
  await page.harness.checkSummarySetup();
  assert.equal(page.elements.get("summarySetupStatus").textContent, "請先確認 Workers Free");
});

test("old headline-only cache is retried and never silently reused", async () => {
  let calls = 0;
  const page = setup(async () => { calls += 1; return Response.json({ draft }); });
  const item = page.harness.getState().news[0];
  item.aiDraft = { summary: item.title, provider: "none", sourceMode: "headline", version: SUMMARY_VERSION, inputKey: await summaryInputKey(item) };
  await page.harness.generateAiSummary(item.id);
  assert.equal(calls, 1);
  assert.equal(item.aiDraft.provider, "cloudflare");
});

test("selected batch is sequential, continues past unreadable bodies and stops at quota", async () => {
  const calls = [];
  let active = 0;
  const page = setup(async (_, input) => {
    assert.equal(++active, 1);
    calls.push(JSON.parse(input.body).title);
    await Promise.resolve();
    active -= 1;
    if (calls.length === 1) return Response.json({ error: { code: "article_body_unavailable", message: "未取得內文" } }, { status: 422 });
    if (calls.length === 3) return Response.json({ error: { code: "cloudflare_free_quota_exhausted", message: "額度用完", retryAt: new Date(Date.now() + 60000).toISOString() } }, { status: 429 });
    return Response.json({ draft });
  });
  page.harness.getState().news.forEach(item => { item.selected = true; });
  await page.harness.generateSelectedSummaries();
  assert.equal(calls.length, 3);
  assert.ok(page.elements.get("summaryBatchStatus").textContent.includes("已整理 1 則，2 則未完成"));
  assert.ok(page.elements.get("summaryBatchStatus").textContent.includes("剩餘新聞未送出"));
  assert.equal(page.elements.get("summarizeSelected").disabled, false);
});

test("manual report edits update preview and invalidate previous human review", () => {
  const page = setup(async () => { throw new Error("AI must not run"); });
  const state = page.harness.getState();
  state.confirmations = [true, true, true];
  const text = "手動確認後的週報文字 <script>alert(1)</script>";
  page.listeners.get("input")({ target: { id: "draftOutput", dataset: {}, value: text } });
  assert.ok(page.elements.get("reportPreview").innerHTML.includes("手動確認後的週報文字"));
  assert.ok(page.elements.get("reportPreview").innerHTML.includes("&lt;script&gt;"));
  assert.equal(page.elements.get("reportPreview").innerHTML.includes("<script>"), false);
  assert.ok(state.confirmations.every(value => value === false));
  const restored = setup(async () => {}, JSON.parse(page.storage.get("pr-weekly-workbench-v3")));
  assert.equal(restored.elements.get("draftOutput").value, text);
  assert.ok(restored.elements.get("reportPreview").innerHTML.includes("手動確認後的週報文字"));
});

test("content and selection changes reset review but checking a box does not", () => {
  const page = setup(async () => {});
  const state = page.harness.getState();
  state.confirmations = [true, true, true];
  page.listeners.get("input")({ target: { dataset: { summary: state.news[0].id }, value: "修改後的新聞事實與數據" } });
  assert.ok(state.confirmations.every(value => !value));
  page.listeners.get("change")({ target: { dataset: { confirm: "0" }, checked: true } });
  assert.equal(state.confirmations[0], true);
  state.confirmations = [true, true, true];
  page.harness.setSelected(state.news[0].id, false);
  assert.ok(state.confirmations.every(value => !value));
});

test("background sync preserves manual draft, summaries, selection and order", async () => {
  let snapshot;
  const requests = [];
  const page = setup(async url => {
    requests.push(url);
    return Response.json(String(url).includes("deployment-status") ? { builtAt: new Date().toISOString() } : snapshot);
  });
  const state = page.harness.getState();
  const item = state.news[0];
  const summary = item.summary;
  const order = item.order;
  const text = "已手動排版，不得被背景同步覆蓋";
  page.listeners.get("input")({ target: { id: "draftOutput", dataset: {}, value: text } });
  snapshot = { generatedAt: new Date().toISOString(), syncedAt: new Date().toISOString(), items: [{ ...item, excerpt: "來源新節錄" }] };
  await page.harness.loadMonitoringSnapshot();
  const merged = state.news.find(news => news.id === item.id);
  assert.equal(merged.summary, summary);
  assert.equal(merged.selected, true);
  assert.equal(merged.order, order);
  assert.equal(state.draft, text);
  assert.equal(page.elements.get("draftOutput").value, text);
  assert.ok(page.elements.get("syncDescription").textContent.includes("同步成功"));
  assert.ok(requests.every(url => !String(url).includes("/api/")));
});

test("invalid snapshots cannot erase existing work and stale data is visible", async () => {
  let snapshot = { items: [] };
  const page = setup(async () => Response.json(snapshot));
  const state = page.harness.getState();
  const original = JSON.stringify(state.news);
  await page.harness.loadMonitoringSnapshot();
  assert.equal(JSON.stringify(state.news), original);
  assert.match(page.elements.get("sourceStatusText").textContent, /無法載入/);
  snapshot = { generatedAt: "2020-01-01T00:00:00Z", syncedAt: "2020-01-01T00:00:00Z", items: [state.news[0]] };
  await page.harness.loadMonitoringSnapshot();
  assert.match(page.elements.get("sourceStatusText").textContent, /更新延遲/);
});

test("five-minute polling defers editor replacement and never triggers AI", async () => {
  let calls = 0;
  const page = setup(async () => { calls++; return Response.json({ items: [page.harness.getState().news[0]] }); });
  assert.equal(page.intervals.length, 1);
  assert.equal(page.intervals[0].ms, 300000);
  const before = JSON.stringify(page.harness.getState().news);
  page.document.activeElement = { tagName: "TEXTAREA" };
  await page.harness.loadMonitoringSnapshot();
  assert.equal(JSON.stringify(page.harness.getState().news), before);
  assert.equal(calls, 1);
});


test("monitoring publisher links reach summary requests and body errors open recovery", async () => {
  let sent;
  const page = setup(async (url, input) => {
    if (input?.method === "POST") {
      sent = JSON.parse(input.body);
      return Response.json({ error: { code: "article_body_unavailable", message: "原文讀取受限" } }, { status: 422 });
    }
    if (String(url).includes("deployment-status")) return Response.json({ builtAt: new Date().toISOString() });
    return Response.json({ items: [{ id: "publisher-test", title: "測試新聞", source: "太報", date: "2026-08-13", url: "https://news.google.com/rss/articles/example", publisherUrl: "https://www.taisounds.com/news/content/76/283040" }] });
  });
  await page.harness.loadMonitoringSnapshot();
  const item = page.harness.getState().news.find(item => item.id === "publisher-test");
  page.harness.setSelected(item.id, true);
  await page.harness.generateAiSummary(item.id);
  assert.equal(sent.publisherUrl, item.publisherUrl);
  assert.ok(page.elements.get("newsList").innerHTML.includes('summary-source-details" open'));
  assert.ok(page.elements.get("newsList").innerHTML.includes('href="https://www.taisounds.com/news/content/76/283040"'));
});
