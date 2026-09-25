import { runCloudflareAI } from "./cloudflareAI.js";
import { logger } from "./logger.js";

const MAX_GRAPHEMES = 300;
// Leave headroom for the anchor line + link we append after generation.
const MAX_BODY_CHARS = 220;

const HASHTAG_POOL = {
  fact: ["#geckos", "#reptiles", "#herpetology"],
  morph: ["#geckos", "#morphs", "#reptilekeeper"],
  care: ["#reptilecare", "#geckos"],
  plant: ["#bioactive", "#reptiles"],
  feeder: ["#reptilecare", "#feederinsects"],
  section: ["#geckos", "#reptilecare"],
};

function styleForSpecies(species) {
  return species.isGecko
    ? `a ${species.common} (${species.sciName})`
    : `a ${species.common} (${species.sciName}) — note: this is a lizard/dragon, NOT a gecko, never call it one`;
}

function buildWriterMessages(item) {
  const subject = styleForSpecies(item.species);
  const system = `You write short social media posts for GeckoDaily, a reptile-care reference website. You write ONE Bluesky post at a time.

Hard rules:
- Base the post ONLY on the SOURCE FACT given to you. Never add numbers, species names, or claims that are not in the source.
- Do not invent statistics, dates, or studies.
- Rephrase in fresh, natural wording — do not copy the source sentence closely.
- Conversational, genuinely enthusiastic about reptiles, not salesy or clickbait-y. No "You won't believe...".
- Plain text only. No markdown, no quotation marks around the whole post, no hashtags (those are added separately), no links (a link is added separately).
- Keep it to ONE short paragraph, at most ${MAX_BODY_CHARS} characters.
- Output ONLY the post text. Nothing else — no preamble, no explanation.`;

  const user = `SPECIES: ${subject}
TOPIC: ${item.category}
SOURCE FACT: ${item.sourceText}

Write the post now.`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function buildValidatorMessages(item, draft) {
  const system = `You are a strict fact-checking editor for GeckoDaily, a reptile-care website. You will be given a SOURCE FACT and a DRAFT social media post that is supposed to be a rewritten version of it.

Check that the DRAFT:
1. Does not contradict the SOURCE FACT.
2. Does not introduce any specific claim (number, species, product, behaviour) that is not supported by the SOURCE FACT.
3. Is coherent, grammatical, plain English.
4. Is not empty, garbled, or a repeated/looping phrase.
5. Does not give unsafe or actively harmful care advice.

Respond with ONLY one word: PASS or FAIL. No explanation.`;

  const user = `SOURCE FACT: ${item.sourceText}

DRAFT POST: ${draft}`;

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

function cleanDraft(raw) {
  return raw
    .replace(/^["'“”]+|["'“”]+$/g, "")
    .replace(/^Post:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function heuristicOk(text, item) {
  if (!text || text.length < 20) return false;
  if (text.length > MAX_BODY_CHARS + 40) return false; // hard cap, some slack before truncation
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 6) return false;
  const alphaRatio = (text.match(/[a-zA-Z]/g) || []).length / text.length;
  if (alphaRatio < 0.55) return false;
  if (/undefined|null|\[object|NaN/i.test(text)) return false;
  // If it isn't a gecko, make sure the draft didn't call it one.
  if (item.species.isGecko === false && /\bgecko\b/i.test(text)) return false;
  return true;
}

/**
 * Generates + validates a post body for one content item.
 * Returns { ok: true, text } or { ok: false, reason }.
 * Never throws for content-quality reasons — only for network/API failures,
 * which callers should catch and treat as "try the next item".
 */
export async function composeBody(item, { maxAttempts = 3 } = {}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let draft;
    try {
      const raw = await runCloudflareAI(buildWriterMessages(item), { maxTokens: 160, temperature: 0.85 });
      draft = cleanDraft(raw);
    } catch (err) {
      logger.error(`AI writer call failed (attempt ${attempt}):`, err.message);
      continue;
    }

    if (!heuristicOk(draft, item)) {
      logger.debug(`Draft failed heuristics (attempt ${attempt}):`, draft);
      continue;
    }

    let verdict;
    try {
      verdict = await runCloudflareAI(buildValidatorMessages(item, draft), { maxTokens: 10, temperature: 0 });
    } catch (err) {
      logger.warn("AI validator call failed, falling back to heuristics only:", err.message);
      verdict = "PASS"; // heuristics already passed; don't block the whole post over a transient API error
    }

    if (/^\s*PASS/i.test(verdict)) {
      const trimmed = draft.length > MAX_BODY_CHARS ? draft.slice(0, MAX_BODY_CHARS - 1).trim() + "…" : draft;
      return { ok: true, text: trimmed };
    }
    logger.debug(`Draft failed AI validation (attempt ${attempt}):`, draft, "verdict:", verdict);
  }
  return { ok: false, reason: "no valid draft after max attempts" };
}

export function pickHashtags(item, count = 2) {
  const pool = HASHTAG_POOL[item.type] || ["#geckos"];
  return pool.slice(0, count);
}

export { MAX_GRAPHEMES };
