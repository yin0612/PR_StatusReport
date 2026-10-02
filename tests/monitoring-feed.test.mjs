import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { aggregatedCandidates } from "../scripts/sync-media-feed.mjs";

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

test("scheduled sync includes both Google aggregation and official RSS", async () => {
  const config = JSON.parse(await readFile(new URL("../config/watchlist.json", import.meta.url), "utf8"));
  assert.ok(config.sources.some(source => source.url.endsWith("/fintech-aggregated.json")));
  assert.ok(config.sources.some(source => source.url.endsWith("/rss-snapshot.json") && source.format === "aggregated"));
});
