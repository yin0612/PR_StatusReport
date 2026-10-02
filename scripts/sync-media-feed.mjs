import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGoogleNewsUrl } from "../src/index.js";
import { taipeiDate, isStockOnly, isPaymentMetaphor, deduplicateSyndication, syndicationKey } from "../src/monitoring-rules.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = resolve(projectRoot, "config/watchlist.json");
const outputPath = resolve(projectRoot, "dist/data/monitoring-news.json");
const timeoutMs = 30_000;
const priorityRank = { "高": 3, "中": 2, "低": 1 };

const unique = (values) => [...new Set(values.filter(Boolean))];
const toText = (value) => String(value ?? "").normalize("NFKC").toLocaleLowerCase();
const cleanText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const dateOnly = (value) => {
  return taipeiDate(value);
};
const timestamp = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
};

const matchedTerms = (text, terms = []) => terms.filter((term) => text.includes(toText(term)));
const ruleMatch = (text, rule) => {
  const groups = Array.isArray(rule.requiredGroups) ? rule.requiredGroups : [];
  if (!groups.length) return null;
  const matches = groups.map((terms) => matchedTerms(text, terms));
  return matches.every((terms) => terms.length) ? matches.flat() : null;
};

const makeId = (item, prefix) => {
  if (item.id) return `${prefix}-${String(item.id)}`;
  return `${prefix}-${createHash("sha256").update(`${item.url ?? ""}|${item.title ?? ""}`).digest("hex").slice(0, 20)}`;
};

const fetchJson = async (url) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { "accept": "application/json", "user-agent": "pr-statusreport-sync/1.0" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`來源回應 ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
};

const reportPlacementForAggregated = (article) => {
  const rules = String(article.rule_ids ?? "").toLocaleLowerCase();
  const folders = String(article.folder_ids ?? "").toLocaleLowerCase();
  const terms = Array.isArray(article.matched_terms) ? article.matched_terms.map(toText) : [];
  // Only company/IR-only articles are excluded. Mixed industry matches remain.
  const folderIds = folders.split(",").filter(Boolean);
  const ruleIds = rules.split(",").filter(Boolean);
  if (folderIds.includes("folder_1") && !folderIds.some(id => id !== "folder_1") &&
      !ruleIds.some(id => !["softworld-brand", "softworld-games", "softworld-ip"].includes(id))) return null;
  if (isStockOnly(String(article.title || ""))) return null;
  if (isPaymentMetaphor(String(article.title || ""))) {
    return { topic: "競品與產業", reportGroup: "industry-games", priority: "中", tags: ["遊戲產業", "周邊設備"] };
  }
  if (/stablecoin|vasp|chain/.test(rules) || folders.includes("folder_6")) {
    return { topic: "金融支付", reportGroup: "industry-stablecoin", priority: "高", tags: ["穩定幣", "鏈上結算"] };
  }
  if (/mobile-|top-grossing|game-watchlist/.test(rules)) {
    return { topic: "遊戲產業", reportGroup: "industry-new-games", priority: "中", tags: ["市場新遊", "重點遊戲"] };
  }
  if (/payment|fintech|newebpay|einvoice/.test(rules) || folders.includes("folder_2") || folders.includes("folder_5")) {
    const directBrand = /newebpay|taiwan-payment-core/.test(rules) || terms.some((term) => ["藍新科技", "藍新金流", "newebpay", "ezpay", "歐付寶", "街口支付", "綠界科技", "ecpay", "全支付", "line pay", "line pay money", "line bank", "悠遊付", "ipass money", "台灣pay", "twqr"].includes(term));
    return { topic: "金融支付", reportGroup: "industry-fintech", priority: directBrand ? "高" : "中", tags: ["金融支付", "產業監測"] };
  }
  if (/competitor|industry-game/.test(rules) || folders.includes("folder_3")) {
    return { topic: "競品與產業", reportGroup: "industry-games", priority: "中", tags: ["遊戲產業", "競品觀測"] };
  }
  if (/industry-platform-business|industry-new-business|industry-martech/.test(rules) || folders.includes("folder_4")) {
    return { topic: "競品與產業", reportGroup: "industry-other", priority: "中", tags: ["平台商業", "新商機", "行銷科技"] };
  }
  return null;
};

const recentCandidates = (feed, source, config) => {
  const sourceItems = Array.isArray(feed?.data?.items) ? feed.data.items : [];
  const excludes = (config.globalExcludeAny || []).map(toText);
  const items = sourceItems.map((item) => {
    const title = cleanText(item.title);
    const excerpt = cleanText(item.excerpt);
    const text = toText(`${title}\n${excerpt}`);
    if (!title || !item.url || excludes.some((term) => text.includes(term))) return null;
    const candidates = config.rules
      .map((rule, index) => ({ rule, index, terms: ruleMatch(text, rule) }))
      .filter((candidate) => candidate.terms);
    if (!candidates.length) return null;
    candidates.sort((left, right) => {
      const priorityDifference = (priorityRank[right.rule.priority] || 0) - (priorityRank[left.rule.priority] || 0);
      return priorityDifference || left.index - right.index;
    });
    const { rule, terms } = candidates[0];
    return {
      id: makeId(item, source.id),
      origin: "monitoring",
      sourceOrigin: source.id,
      title,
      source: cleanText(item.source) || source.label,
      date: dateOnly(item.publishedAt) || dateOnly(feed.generatedAt),
      publishedAt: item.publishedAt || feed.generatedAt || null,
      url: String(item.url),
      topic: rule.topic,
      reportGroup: rule.reportGroup,
      priority: rule.priority,
      tags: unique([...(rule.tags || []), ...terms]).slice(0, 5),
      excerpt,
      sourceId: item.id ? String(item.id) : null,
      matchedRule: rule.id
    };
  }).filter(Boolean);
  return { sourceItems, items, generatedAt: feed.generatedAt || null };
};

export const aggregatedCandidates = (feed, source) => {
  const sourceItems = Array.isArray(feed?.articles) ? feed.articles : [];
  const generatedAt = feed.generated_at || null;
  const cutoff = source.maxAgeDays
    ? Date.now() - Number(source.maxAgeDays) * 24 * 60 * 60 * 1000
    : 0;
  const items = sourceItems.map((article) => {
    const publishedAt = article.published_at || article.fetched_at || generatedAt;
    if (!article.title || !article.url || (article.review_status && article.review_status !== "approved") || (cutoff && timestamp(publishedAt) < cutoff)) return null;
    const placement = reportPlacementForAggregated(article);
    if (!placement) return null;
    return {
      id: makeId(article, source.id),
      origin: "monitoring",
      sourceOrigin: source.id,
      title: cleanText(article.title),
      source: cleanText(article.source) || source.label,
      date: dateOnly(publishedAt) || dateOnly(generatedAt),
      publishedAt,
      url: String(article.url),
      topic: placement.topic,
      reportGroup: placement.reportGroup,
      priority: placement.priority,
      tags: unique([...placement.tags, ...(Array.isArray(article.matched_terms) ? article.matched_terms.map(cleanText) : [])]).slice(0, 5),
      excerpt: cleanText(article.excerpt).slice(0, source.excerptMaxLength || Infinity) || "由產業監測網篩選，請開啟原文後整理週報內文。",
      sourceId: article.id ? String(article.id) : null,
      matchedRule: String(article.rule_ids || "")
    };
  }).filter(Boolean);
  return { sourceItems, items, generatedAt };
};

export const fetchMonitoringApi = async (source, fetchPage = fetchJson, now = new Date()) => {
  const to = taipeiDate(now);
  const fromDate = new Date(`${to}T00:00:00Z`);
  const originalDay = fromDate.getUTCDate();
  fromDate.setUTCDate(1);
  fromDate.setUTCMonth(fromDate.getUTCMonth() - (source.rangeMonths || 2));
  const lastDay = new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth() + 1, 0)).getUTCDate();
  fromDate.setUTCDate(Math.min(originalDay, lastDay));
  const from = fromDate.toISOString().slice(0, 10);
  const articles = [];
  let offset = 0;
  let generatedAt = null;
  for (let page = 0; page < 1000; page++) {
    const url = new URL(source.url);
    url.search = new URLSearchParams({ from, to, limit: "2000", offset: String(offset) }).toString();
    const payload = await fetchPage(url.toString());
    if (!Array.isArray(payload.articles) || payload.partial === true) throw new Error("監測 API 資料不完整，保留上一版。");
    articles.push(...payload.articles);
    // API response time is not an RSS update time. Prefer underlying collection time.
    generatedAt = [generatedAt, ...payload.articles.map(item => item.fetched_at)].filter(Boolean)
      .sort((a, b) => timestamp(b) - timestamp(a))[0] || null;
    const hasMore = payload.has_more === true || (Number.isFinite(payload.total) && offset + payload.articles.length < payload.total);
    if (!hasMore) return { articles, generated_at: generatedAt, range: { from, to }, degraded: payload.degraded === true };
    const next = Number(payload.next_offset ?? offset + payload.articles.length);
    if (!payload.articles.length || !Number.isInteger(next) || next <= offset) throw new Error("監測 API 分頁沒有前進，保留上一版。");
    offset = next;
  }
  throw new Error("監測 API 分頁未完成，保留上一版。");
};

export const selectCandidates = (records, maxItems) => {
  const items = deduplicateSyndication(records);
  return Number(maxItems) > 0 ? items.slice(0, Number(maxItems)) : items;
};

const syncMonitoring = async () => {
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const sources = Array.isArray(config.sources) ? config.sources : [];
  if (!sources.length) throw new Error("watchlist.json 尚未設定監測來源。");

  const results = [];
  for (const source of sources) {
    const feed = source.format === "monitoring-api" ? await fetchMonitoringApi(source) : await fetchJson(source.url);
    if (source.format === "recent") results.push({ source, ...recentCandidates(feed, source, config) });
    else if (["aggregated", "monitoring-api"].includes(source.format)) results.push({ source, ...aggregatedCandidates(feed, source), range: feed.range });
    else throw new Error(`不支援的來源格式：${source.format}`);
  }

  const allCandidates = results.flatMap((result) => result.items)
    .sort((left, right) => timestamp(right.publishedAt) - timestamp(left.publishedAt));
  const items = selectCandidates(allCandidates, config.maxItems);
  if (!items.length) throw new Error("來源未提供有效候選新聞，保留上一版資料；請檢查來源更新與格式。");
  const latestGeneratedAt = results.map((result) => result.generatedAt).sort((left, right) => timestamp(right) - timestamp(left))[0] || null;

  // Publisher URLs are public metadata, not article bodies. Preserve them across
  // hourly updates so neither the build nor the Worker repeatedly asks Google.
  let priorItems = [];
  try { priorItems = JSON.parse(await readFile(outputPath, "utf8")).items || []; } catch { /* First sync. */ }
  const priorByIdentity = new Map(priorItems.flatMap(item => [[item.url, item], [syndicationKey(item.title), item]]));
  const priorByUrl = new Map(priorItems.filter(item => item.publisherUrl).map(item => [item.url, item.publisherUrl]));
  const knownLinks = JSON.parse(await readFile(resolve(projectRoot, "config/publisher-links.json"), "utf8"));
  let decodedCount = 0;
  let googleLimited = false;
  for (const item of items) {
    const prior = priorByIdentity.get(item.url) || priorByIdentity.get(syndicationKey(item.title));
    if (prior) item.id = prior.id;
    const known = priorByUrl.get(item.url) || knownLinks[item.id];
    if (known) { item.publisherUrl = known; continue; }
    if (!/^https:\/\/news\.google\.com\//i.test(item.url) || decodedCount >= 12 || googleLimited) continue;
    decodedCount += 1;
    try { item.publisherUrl = await resolveGoogleNewsUrl(item.url, { timeoutMs: 5_000 }); }
    catch (error) { if (error?.sourceStatus === 429) googleLimited = true; }
  }

  const snapshot = {
    schemaVersion: "1.3.0",
    generatedAt: latestGeneratedAt,
    syncedAt: new Date().toISOString(),
    freshness: { expectedSyncHours: 1, syncWarningHours: 3, sourceWarningHours: 8 },
    watchlistVersion: config.version,
    source: {
      label: results.map((result) => result.source.label).join("＋"),
      totalItems: results.reduce((total, result) => total + result.sourceItems.length, 0),
      matchedItems: items.length,
      sources: results.map((result) => ({
        id: result.source.id,
        label: result.source.label,
        url: result.source.url,
        totalItems: result.sourceItems.length,
        matchedItems: result.items.length,
        generatedAt: result.generatedAt,
        range: result.range
      }))
    },
    items
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  console.log(`已同步 ${items.length} 則週報候選新聞（${results.map((result) => `${result.source.label} ${result.items.length}/${result.sourceItems.length}`).join("；")}）。`);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await syncMonitoring();
}
