// Deterministic checks only; no AI or external requests.
export const taipeiDate = (value) => {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(value));
  const part = (type) => parts.find(item => item.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
};

export const isStockOnly = (title) => /^(?:《外資》|盤中速報|權證市場焦點)|(?:股價|目標價).*(?:跌停|漲停|看千元)|\(經濟日報，無內文\)/.test(title);
export const isPaymentMetaphor = (title) => /信用卡大小|信用卡尺寸/.test(title) && !/支付|金流|刷卡|付款|回饋/.test(title);
export const syndicationKey = (title) => String(title).normalize("NFKC").toLowerCase()
  .replace(/^討論牆\s*[|｜]\s*/, "")
  .replace(/\s*[|｜]\s*(?:商傳媒|moneydj理財網|卡優新聞網|newtalk).*$/i, "")
  .replace(/\s*[-－]\s*(?:科技新聞|新聞|產業|股市爆料同學會)\s*$/, "")
  // Keep decimal points, percentage and signs: 1.5% is not 15%.
  .replace(/[^\p{L}\p{N}.%+−-]+/gu, "");

export const deduplicateSyndication = (records) => {
  const byTitle = new Map();
  for (const item of records) {
    const key = syndicationKey(item.title);
    if (!key) continue;
    const primary = byTitle.get(key);
    if (!primary) { byTitle.set(key, { ...item }); continue; }
    primary.relatedSources = [...(primary.relatedSources || []), { title: item.title, source: item.source, url: item.url }];
  }
  return [...byTitle.values()];
};
