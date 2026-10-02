import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractArticle } from "../src/index.js";

// No AI, credentials, proxies, login or paywall bypass in this build step.
// Bodies are bundled privately in the Worker, never in dist/ or Git history.
export const buildArticleCache = async (records, extract = extractArticle, budgetMs = 90_000, knownLinks = {}) => {
  const startedAt = Date.now();
  const items = Object.create(null);
  const failures = Object.create(null);
  const validRecords = records.filter((item) => item.title && item.url);
  // Keep verified links usable even when their articles are outside the latest 80.
  const publisherUrls = Object.fromEntries(validRecords.filter(item => item.publisherUrl || knownLinks[item.id])
    .map(item => [item.url, { title: item.title, url: item.publisherUrl || knownLinks[item.id] }]));
  const candidates = [...validRecords.filter(item => knownLinks[item.id]),
    ...validRecords.filter(item => !knownLinks[item.id])].slice(0, 80);
  let index = 0;
  let googleAttempts = 0;
  let googleLimited = false;
  const collect = async () => {
    while (index < candidates.length && Date.now() - startedAt < budgetMs) {
      const item = candidates[index++];
      const sourceUrl = item.publisherUrl || knownLinks[item.id] || item.url;
      const googleLink = /^https:\/\/news\.google\.com\//i.test(sourceUrl);
      if (googleLink && (googleLimited || googleAttempts++ >= 8)) {
        failures[item.url] = { status: 429, reason: "publisher_url_pending" };
        continue;
      }
      try {
        const article = await extract(sourceUrl, { timeoutMs: 5_000 });
        items[item.url] = { ...article, title: item.title, fetchedAt: new Date().toISOString() };
      } catch (error) {
        // Safe diagnostics only: do not log article bodies or request secrets.
        failures[item.url] = { status: Number(error?.sourceStatus || error?.status) || 502 };
        if (googleLink && error?.sourceStatus === 429) googleLimited = true;
      }
    }
  };
  await Promise.all([collect(), collect()]);
  return { generatedAt: new Date().toISOString(), total: candidates.length, items, failures, publisherUrls };
};

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const snapshot = JSON.parse(await readFile(resolve(projectRoot, "dist/data/monitoring-news.json"), "utf8"));
  const knownLinks = JSON.parse(await readFile(resolve(projectRoot, "config/publisher-links.json"), "utf8"));
  const cache = await buildArticleCache(snapshot.items || [], extractArticle, 90_000, knownLinks);
  const outputDir = resolve(projectRoot, ".generated");
  await mkdir(outputDir, { recursive: true });
  await writeFile(resolve(outputDir, "article-cache.json"), JSON.stringify(cache), "utf8");
  // Public build metadata only, never article bodies or secrets.
  await writeFile(resolve(projectRoot, "dist/data/deployment-status.json"), JSON.stringify({ builtAt: new Date().toISOString() }), "utf8");
  console.log(`Private article cache: ${Object.keys(cache.items).length}/${cache.total} readable; ${Object.keys(cache.failures).length} restricted. No AI calls.`);
}
