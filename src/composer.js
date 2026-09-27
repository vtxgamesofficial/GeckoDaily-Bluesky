// No AI rewriting anymore — this takes the "quick answer" text that's
// already on the GeckoDaily site (item.quickAnswer, from the plugin API's
// own claim/summary fields) and posts it close to verbatim. This module
// just keeps the same safety checks the old AI pipeline had (so obviously
// broken data still gets rejected) and formats hashtags/length.

// Bluesky's hard limit is 300 *graphemes* (Unicode user-perceived
// characters), not JS string length/UTF-16 code units — an emoji like 🦎
// is 2 UTF-16 units but 1 grapheme. graphemeLength() below is the one
// source of truth for that count; MAX_BODY_CHARS here is just an early,
// generous soft cap so obviously-oversized text gets shortened before it
// even reaches assemblePost() — the actual 300-limit enforcement (which
// has to account for the anchor link + hashtags too) lives in
// blueskyClient.js's assemblePost(), since only it knows the full text.
const MAX_BODY_CHARS = 260;

const HASHTAG_POOL = {
  fact: ["#geckos", "#reptiles", "#herpetology"],
  morph: ["#geckos", "#morphs", "#reptilekeeper"],
  care: ["#reptilecare", "#geckos"],
  plant: ["#bioactive", "#reptiles"],
  feeder: ["#reptilecare", "#feederinsects"],
  section: ["#geckos", "#reptilecare"],
};

const segmenter =
  typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter("en", { granularity: "grapheme" }) : null;

/** Counts Unicode graphemes the way Bluesky's 300-grapheme post limit does — NOT str.length. */
export function graphemeLength(str) {
  const s = String(str || "");
  if (segmenter) return [...segmenter.segment(s)].length;
  return [...s].length; // fallback: per-codepoint count, still better than UTF-16 .length
}

/** Truncates to at most `maxGraphemes`, appending "…" (itself 1 grapheme) if cut. */
export function truncateToGraphemes(str, maxGraphemes) {
  const s = String(str || "");
  if (graphemeLength(s) <= maxGraphemes) return s;
  const graphemes = segmenter ? [...segmenter.segment(s)].map((g) => g.segment) : [...s];
  return graphemes.slice(0, Math.max(0, maxGraphemes - 1)).join("").trim() + "…";
}

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
  const trimmed = graphemeLength(cleaned) > MAX_BODY_CHARS ? truncateToGraphemes(cleaned, MAX_BODY_CHARS) : cleaned;
  return { ok: true, text: trimmed };
}

export function pickHashtags(item, count = 2) {
  const pool = HASHTAG_POOL[item.type] || ["#geckos"];
  return pool.slice(0, count);
}

export { MAX_BODY_CHARS };
