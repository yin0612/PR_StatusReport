import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGoogleNewsUrl } from "../src/index.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = resolve(projectRoot, "config/watchlist.json");
const outputPath = resolve(projectRoot, "dist/data/monitoring-news.json");
const timeoutMs = 30_000;
const priorityRank = { "高": 3, "中": 2, "低": 1 };

const unique = (values) => [...new Set(values.filter(Boolean))];
const toText = (value) => String(value ?? "").normalize("NFKC").toLocaleLowerCase();
const cleanText = (value) => String(value ?? "").replace(/\s+/g, " ").trim();
const dateOnly = (value) => {
  const match = String(value ?? "").match(/^\d{4}-\d{2}-\d{2}/);
  return match ? match[0] : null;
};
const timestamp = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 0 : date.getTime();
};
const titleKey = (value) => toText(value).replace(/[^\p{L}\p{N}]+/gu, "");

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
  // 公司／IR 專用監測不列入此工作台，保留候選額度給產業新聞。
  if (/softworld-/.test(rules) || folders.includes("folder_1")) return null;
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

const aggregatedCandidates = (feed, source) => {
  const sourceItems = Array.isArray(feed?.articles) ? feed.articles : [];
  const generatedAt = feed.generated_at || null;
  const cutoff = source.maxAgeDays && timestamp(generatedAt)
    ? timestamp(generatedAt) - Number(source.maxAgeDays) * 24 * 60 * 60 * 1000
    : 0;
  const items = sourceItems.map((article) => {
    const publishedAt = article.published_at || article.fetched_at || generatedAt;
    if (!article.title || !article.url || (cutoff && timestamp(publishedAt) < cutoff)) return null;
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
      excerpt: cleanText(article.excerpt) || "由產業監測網篩選，請開啟原文後整理週報內文。",
      sourceId: article.id ? String(article.id) : null,
      matchedRule: String(article.rule_ids || "")
    };
  }).filter(Boolean);
  return { sourceItems, items, generatedAt };
};

const config = JSON.parse(await readFile(configPath, "utf8"));
const sources = Array.isArray(config.sources) ? config.sources : [];
if (!sources.length) throw new Error("watchlist.json 尚未設定監測來源。");

const results = [];
for (const source of sources) {
  const feed = await fetchJson(source.url);
  if (source.format === "recent") results.push({ source, ...recentCandidates(feed, source, config) });
  else if (source.format === "aggregated") results.push({ source, ...aggregatedCandidates(feed, source) });
  else throw new Error(`不支援的來源格式：${source.format}`);
}

const allCandidates = results.flatMap((result) => result.items)
  .sort((left, right) => timestamp(right.publishedAt) - timestamp(left.publishedAt));
const seenTitles = new Set();
const items = allCandidates.filter((item) => {
  const key = titleKey(item.title);
  if (!key || seenTitles.has(key)) return false;
  seenTitles.add(key);
  return true;
}).slice(0, Number(config.maxItems) || 120);
const latestGeneratedAt = results.map((result) => result.generatedAt).sort((left, right) => timestamp(right) - timestamp(left))[0] || null;

// Publisher URLs are public metadata, not article bodies. Preserve them across
// hourly updates so neither the build nor the Worker repeatedly asks Google.
let priorItems = [];
try { priorItems = JSON.parse(await readFile(outputPath, "utf8")).items || []; } catch { /* First sync. */ }
const priorByUrl = new Map(priorItems.filter(item => item.publisherUrl).map(item => [item.url, item.publisherUrl]));
const knownLinks = JSON.parse(await readFile(resolve(projectRoot, "config/publisher-links.json"), "utf8"));
let decodedCount = 0;
let googleLimited = false;
for (const item of items) {
  const known = priorByUrl.get(item.url) || knownLinks[item.id];
  if (known) { item.publisherUrl = known; continue; }
  if (!/^https:\/\/news\.google\.com\//i.test(item.url) || decodedCount >= 12 || googleLimited) continue;
  decodedCount += 1;
  try { item.publisherUrl = await resolveGoogleNewsUrl(item.url, { timeoutMs: 5_000 }); }
  catch (error) { if (error?.sourceStatus === 429) googleLimited = true; }
}

const snapshot = {
  schemaVersion: "1.2.0",
  generatedAt: latestGeneratedAt,
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
      generatedAt: result.generatedAt
    }))
  },
  items
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
console.log(`已同步 ${items.length} 則週報候選新聞（${results.map((result) => `${result.source.label} ${result.items.length}/${result.sourceItems.length}`).join("；")}）。`);
