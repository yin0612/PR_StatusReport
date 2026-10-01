import assert from "node:assert/strict";
import { test } from "node:test";
import { taipeiDate, isStockOnly, isPaymentMetaphor, deduplicateSyndication } from "../src/monitoring-rules.js";

test("news dates use Taipei midnight, not the UTC date prefix", () => {
  assert.equal(taipeiDate("2026-09-30T23:59:56Z"), "2026-10-01");
  assert.equal(taipeiDate("2026-09-30T15:59:59Z"), "2026-09-30");
  assert.equal(taipeiDate("2026-09-30T16:00:00Z"), "2026-10-01");
  assert.equal(taipeiDate("2026-10-01"), "2026-10-01");
  assert.equal(taipeiDate("invalid"), null);
  assert.equal(taipeiDate(null), null);
});

test("stock-only headlines are excluded but operating and security news remain", () => {
  assert.equal(isStockOnly("盤中速報 - 宏碁遊戲-創股價殺至跌停"), true);
  assert.equal(isStockOnly("《外資》買超股：廣積、嘉晶、鈊象- 上市櫃"), true);
  assert.equal(isStockOnly("權證市場焦點－鈊象 目標價看千元"), true);
  assert.equal(isStockOnly("鈊象美國授權市場續增，TaDa拓中南美/歐洲"), false);
  assert.equal(isStockOnly("鈊象本公司網路資安事件說明"), false);
});

test("credit-card size is a metaphor, but actual payment features are not", () => {
  assert.equal(isPaymentMetaphor("Razer手機遊戲手把：信用卡大小、重量100克"), true);
  assert.equal(isPaymentMetaphor("信用卡大小手把支援感應刷卡付款"), false);
});

test("only equivalent syndicated titles merge; distinct stories retain their sources", () => {
  const records = [
    { id: "a", title: "微軟重整Xbox遊戲業務 | 商傳媒", source: "LINE TODAY", url: "https://example.com/a" },
    { id: "b", title: "微軟重整Xbox遊戲業務", source: "商傳媒", url: "https://example.com/b" },
    { id: "c", title: "討論牆 | 微軟重整Xbox遊戲業務", source: "LINE TODAY", url: "https://example.com/c" },
    { id: "d", title: "微軟推出新的Xbox遊戲", source: "媒體", url: "https://example.com/d" },
  ];
  const result = deduplicateSyndication(records);
  assert.equal(result.length, 2);
  assert.equal(result[0].relatedSources.length, 2);
  assert.equal(result[0].relatedSources[0].url, records[1].url);
  assert.equal(result[1].id, "d");
  assert.equal(records[0].relatedSources, undefined);
  assert.equal(deduplicateSyndication([{ title: "回饋1.5%" }, { title: "回饋15%" }]).length, 2);
});
