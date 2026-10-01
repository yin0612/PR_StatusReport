import assert from "node:assert/strict";
import { test } from "node:test";
import { handleSummaryRequest, handleSummaryStatusRequest } from "../src/index.js";

const env = { PR_SUMMARY_ACCESS_KEY: "test-access", OPENAI_API_KEY: "test-api-key" };
const request = () => new Request("https://example.com/api/summarize", {
  method: "POST",
  headers: { "content-type": "application/json", "x-pr-summary-key": env.PR_SUMMARY_ACCESS_KEY },
  body: JSON.stringify({ title: "測試新聞", url: "https://example.com/news", articleText: "企業宣布推出新的支付服務，並說明使用方式與推出時程。".repeat(5) }),
});
const modelOutput = { summary: "企業宣布推出新的支付服務，並說明使用方式與推出時程。", note: "", warnings: [] };
const message = (text) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });

test("reads raw REST output after reasoning items without auto-applying it", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls += 1;
    assert.equal(url, "https://api.openai.com/v1/responses");
    const body = JSON.parse(options.body);
    assert.equal(body.store, false);
    assert.equal(body.max_output_tokens, 650);
    assert.equal(body.reasoning.effort, "low");
    assert.equal(body.text.format.type, "json_schema");
    return Response.json({ status: "completed", output: [{ type: "reasoning", summary: [] }, message(JSON.stringify(modelOutput))] });
  });
  const result = await handleSummaryRequest(request(), env);
  const payload = await result.json();
  assert.equal(result.status, 200);
  assert.equal(payload.draft.summary, modelOutput.summary);
  assert.equal(payload.draft.sourceMode, "pasted_text");
  assert.equal(calls, 1);
});

for (const [code, type, expected] of [
  ["credit_balance_exhausted", "insufficient_quota", "預付額度已用完"],
  ["project_spend_limit_exceeded", "insufficient_quota", "支出上限"],
  ["organization_spend_limit_exceeded", "insufficient_quota", "支出上限"],
  ["organization_usage_limit_exceeded", "insufficient_quota", "核准的用量上限"],
  ["insufficient_quota", "insufficient_quota", "額度不足"],
  ["rate_limit_exceeded", "rate_limit_error", "請求太頻繁"],
  ["slow_down", "rate_limit_error", "請求太頻繁"],
  [null, "unknown_error", "未提供可辨識的原因"],
]) {
  test(`distinguishes 429 ${code || "unknown"} without retrying`, async (t) => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async () => {
      calls += 1;
      return Response.json({ error: { type, code } }, { status: 429 });
    });
    const result = await handleSummaryRequest(request(), env);
    const payload = await result.json();
    assert.equal(result.status, 502);
    assert.ok(payload.error.message.includes(expected));
    assert.equal(payload.error.code, code || type);
    assert.equal(calls, 1);
  });
}

test("rejects incomplete output even if a partial JSON draft is present", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ status: "incomplete", output: [message(JSON.stringify(modelOutput))] }));
  const result = await handleSummaryRequest(request(), env);
  const payload = await result.json();
  assert.equal(payload.error.code, "incomplete_response");
  assert.equal(payload.draft, undefined);
});

test("does not parse a refusal as a summary", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "Cannot comply." }] }] }));
  const result = await handleSummaryRequest(request(), env);
  assert.equal(result.status, 422);
  assert.equal((await result.json()).error.code, "model_refusal");
});

test("free configuration check does not claim to verify billing or generation", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://api.openai.com/v1/models/gpt-6-astra");
    assert.equal(options.method, undefined);
    return Response.json({ id: "gpt-6-astra" });
  });
  const result = await handleSummaryStatusRequest(request(), env);
  assert.ok((await result.json()).message.includes("不驗證 API 餘額或摘要生成權限"));
});

test("invalid workspace access code never calls the paid API", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("Must not be called"); });
  const result = await handleSummaryRequest(new Request("https://example.com/api/summarize", { method: "POST" }), env);
  assert.equal(result.status, 401);
});
