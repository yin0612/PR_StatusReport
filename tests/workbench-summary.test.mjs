import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";
import { SUMMARY_VERSION, summaryInputKey, canReuseSummaryDraft } from "../dist/summary-cache.js";

const html = await readFile(new URL("../dist/index.html", import.meta.url), "utf8");
const script = /<script type="module">([\s\S]*?)<\/script>/.exec(html)[1]
  .replace(/^\s*import[^\n]+from "\.\/summary-cache\.js";\s*$/m, "")
  .replace("hydrate(); cleanOrder(); renderAll(true); persist(); loadMonitoringSnapshot();",
    "hydrate(); cleanOrder(); renderAll(true); persist(); globalThis.workbenchTest = { generateAiSummary, checkSummarySetup, getState: () => state };");

const setup = (api, savedState) => {
  const elements = new Map();
  const storage = new Map();
  if (savedState) storage.set("pr-weekly-workbench-v3", JSON.stringify(savedState));
  const context = {
    SUMMARY_VERSION, summaryInputKey, canReuseSummaryDraft, URL, Date, Intl, console,
    setTimeout: () => 0, clearTimeout: () => {},
    localStorage: { getItem: (key) => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) },
    sessionStorage: { getItem: () => "test-access", setItem: () => {} },
    document: {
      querySelectorAll: () => [], addEventListener: () => {},
      getElementById: (id) => {
        if (!elements.has(id)) elements.set(id, { value: "", style: {}, addEventListener: () => {}, classList: { add: () => {}, remove: () => {}, toggle: () => {} } });
        return elements.get(id);
      },
    },
    fetch: api,
  };
  vm.runInNewContext(script, context);
  return { harness: context.workbenchTest, elements, storage };
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
