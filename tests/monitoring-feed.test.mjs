import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { aggregatedCandidates, fetchMonitoringApi, selectCandidates } from "../scripts/sync-media-feed.mjs";

test("official RSS OUSD news retains its publisher link and stablecoin placement", () => {
  const source = { id: "softworld-official-rss", label: "官方 RSS", maxAgeDays: 10, excerptMaxLength: 600 };
  const published = new Date().toISOString();
  const feed = { generated_at: published, articles: [
    { id: "rss-ousd", title: "Open Standard美元穩定幣OUSD正式上線", source: "iThome",
      url: "https://www.ithome.com.tw/news/179343", published_at: published,
      folder_ids: "folder_6", rule_ids: "stablecoin-core", excerpt: "文".repeat(1000) },
    { id: "ir", title: "公司公告", url: "https://example.com/ir", published_at: published,
      folder_ids: "folder_1", rule_ids: "softworld-ir" }
  ] };
  const { items, generatedAt } = aggregatedCandidates(feed, source);
  assert.equal(items.length, 1);
  assert.equal(items[0].sourceOrigin, source.id);
  assert.equal(items[0].source, "iThome");
  assert.equal(items[0].url, feed.articles[0].url);
  assert.equal(items[0].reportGroup, "industry-stablecoin");
  assert.equal(items[0].priority, "高");
  assert.equal(items[0].excerpt.length, 600);
  assert.equal(generatedAt, published);
});

test("official RSS date cutoff uses article publication, not snapshot freshness", () => {
  const feed = { generated_at: new Date().toISOString(), articles: [
    { title: "舊穩定幣新聞", url: "https://example.com/old", published_at: "2020-01-01T00:00:00Z",
      folder_ids: "folder_6", rule_ids: "stablecoin-core" }
  ] };
  assert.equal(aggregatedCandidates(feed, { id: "rss", maxAgeDays: 10 }).items.length, 0);
});

test("scheduled sync uses the full API without truncation or a ten-day cutoff", async () => {
  const config = JSON.parse(await readFile(new URL("../config/watchlist.json", import.meta.url), "utf8"));
  assert.ok(config.sources.some(source => source.format === "monitoring-api" && source.rangeMonths === 2 && !source.maxAgeDays));
  assert.equal(config.maxItems, null);
});

test("all current industry rules have placement, including mixed company news", () => {
  const rules = ["softworld-fintech-services", "taiwan-payment-peer-oen", "newebpay-brand", "newebpay-market", "taiwan-payment-core", "taiwan-payment-authority", "competitor-brand", "competitor-tw-game", "competitor-global-game", "industry-game-platform", "mobile-top-grossing-games", "mobile-game-watchlist", "mobile-game-context-watchlist", "industry-game-market", "industry-platform-business", "industry-new-business", "industry-einvoice", "industry-martech", "international-fintech", "stablecoin-core", "stablecoin-settlement", "stablecoin-brand", "stablecoin-circle", "stablecoin-bitopro", "stablecoin-vasp"];
  for (const rule of rules) {
    const result = aggregatedCandidates({ articles: [{ title: rule, url: `https://example.com/${rule}`, rule_ids: rule }] }, { id: "test" });
    assert.equal(result.items.length, 1, rule);
  }
  const mixed = { title: "智冠金融服務與產業合作", url: "https://example.com/mixed", rule_ids: "softworld-brand,softworld-fintech-services", folder_ids: "folder_1,folder_2" };
  assert.equal(aggregatedCandidates({ articles: [mixed] }, { id: "test" }).items[0].reportGroup, "industry-fintech");
  assert.equal(aggregatedCandidates({ articles: [{ ...mixed, review_status: "rejected" }] }, { id: "test" }).items.length, 0);
});

test("API pagination retrieves every page and preserves source timestamps", async () => {
  const requested = [];
  const result = await fetchMonitoringApi({ url: "https://example.com/api/articles", rangeMonths: 2 }, async url => {
    const params = new URL(url).searchParams;
    requested.push(params);
    return params.get("offset") === "0"
      ? { articles: [{ id: "a", fetched_at: "2026-10-01T00:00:00Z" }], total: 2, has_more: true, next_offset: 1 }
      : { articles: [{ id: "b", fetched_at: "2026-10-02T00:00:00Z" }], total: 2, has_more: false };
  }, new Date("2026-10-01T23:00:00Z"));
  assert.equal(result.articles.length, 2);
  assert.equal(requested[0].get("from"), "2026-08-02");
  assert.equal(requested[0].get("to"), "2026-10-02");
  assert.equal(result.generated_at, "2026-10-02T00:00:00Z");
});

test("partial or stalled API pagination cannot overwrite a good snapshot", async () => {
  const source = { url: "https://example.com/api/articles" };
  await assert.rejects(fetchMonitoringApi(source, async () => ({ articles: [], partial: true })), /不完整/);
  await assert.rejects(fetchMonitoringApi(source, async () => ({ articles: [{ id: "a" }], has_more: true, next_offset: 0 })), /沒有前進/);
});

test("uncapped candidates retain older news beyond 400 and merge duplicates", () => {
  const records = Array.from({ length: 700 }, (_, index) => ({ title: `新聞 ${index}`, url: `https://example.com/${index}` }));
  records.push({ title: "Open Standard OUSD正式上線", url: "https://www.ithome.com.tw/news/179343" }, { ...records[0] });
  const items = selectCandidates(records, null);
  assert.equal(items.length, 701);
  assert.ok(items.some(item => item.title.includes("OUSD")));
});
