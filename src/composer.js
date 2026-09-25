// No AI rewriting anymore — this takes the "quick answer" text that's
// already on the GeckoDaily site (item.quickAnswer, from the plugin API's
// own claim/summary fields) and posts it close to verbatim. This module
// just keeps the same safety checks the old AI pipeline had (so obviously
// broken data still gets rejected) and formats hashtags/length.

const MAX_BODY_CHARS = 220; // leave headroom for the anchor line + link appended after this

const HASHTAG_POOL = {
  fact: ["#geckos", "#reptiles", "#herpetology"],
  morph: ["#geckos", "#morphs", "#reptilekeeper"],
  care: ["#reptilecare", "#geckos"],
  plant: ["#bioactive", "#reptiles"],
  feeder: ["#reptilecare", "#feederinsects"],
  section: ["#geckos", "#reptilecare"],
};

function cleanText(raw) {
  return String(raw || "")
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function heuristicOk(text, item) {
  if (!text || text.length < 10) return false;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 3) return false;
  const alphaRatio = (text.match(/[a-zA-Z]/g) || []).length / text.length;
  if (alphaRatio < 0.4) return false;
  if (/undefined|null|\[object|NaN/i.test(text)) return false;
  // If it isn't a gecko, make sure the source text didn't call it one.
  if (item.species.isGecko === false && /\bgecko\b/i.test(text)) return false;
  return true;
}

/**
 * Takes item.quickAnswer straight from the site's own data. Returns
 * { ok: true, text } or { ok: false, reason }. No network call, no AI —
 * purely local validation + formatting, so this is essentially free.
 */
export function composeBody(item) {
  const cleaned = cleanText(item.quickAnswer);
  if (!heuristicOk(cleaned, item)) {
    return { ok: false, reason: "quick-answer text failed basic sanity checks" };
  }
  const trimmed =
    cleaned.length > MAX_BODY_CHARS ? cleaned.slice(0, MAX_BODY_CHARS - 1).trim() + "…" : cleaned;
  return { ok: true, text: trimmed };
}

export function pickHashtags(item, count = 2) {
  const pool = HASHTAG_POOL[item.type] || ["#geckos"];
  return pool.slice(0, count);
}

export { MAX_BODY_CHARS };
