export const SUMMARY_VERSION = "cloudflare-free-v2-body-r1";

export const summaryInputKey = async (item) => {
  const text = JSON.stringify([SUMMARY_VERSION, String(item.title || ""), String(item.source || ""),
    String(item.date || ""), String(item.url || ""), String(item.publisherUrl || ""), String(item.excerpt || ""), String(item.aiSourceText || "")]);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
};

export const canReuseSummaryDraft = (draft, inputKey) => Boolean(draft?.summary
  && draft.provider === "cloudflare" && draft.sourceMode !== "headline"
  && draft.version === SUMMARY_VERSION && draft.inputKey === inputKey);
