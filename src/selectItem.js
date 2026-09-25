import { SPECIES } from "./config.js";
import { logger } from "./logger.js";

const TYPE_ORDER = ["fact", "care", "morph", "feeder", "plant", "section"];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Picks the next item to post. Rotates through species round-robin
 * (state.speciesCursor) so no one table dominates the feed, and within a
 * species prefers a content type not posted in the last couple of runs, so
 * a run of five "fact" posts in a row doesn't happen by chance.
 *
 * If every item for every species has already been posted (the pool is
 * finite), the posted log is wrapped — oldest entries age out via the
 * MAX_POSTED_IDS cap in state.js anyway, but this guarantees the bot
 * never just goes silent because it "ran out" of content.
 */
export function selectItem(pools, state) {
  const order = SPECIES.map((_, i) => (state.speciesCursor + i) % SPECIES.length);
  const postedSet = new Set(state.postedIds);

  for (const idx of order) {
    const species = SPECIES[idx];
    const pool = pools[species.slug] || [];
    if (pool.length === 0) continue;

    let candidates = pool.filter((item) => !postedSet.has(item.id));
    if (candidates.length === 0) {
      logger.info(`Pool for ${species.slug} exhausted, allowing repeats for this run.`);
      candidates = pool;
    }

    // Prefer a type different from the last couple of posted types, if possible.
    const recentTypes = state.postedIds
      .slice(-4)
      .map((id) => id.split(":")[0]);
    const preferred = candidates.filter((item) => !recentTypes.includes(item.type));
    const pickFrom = preferred.length ? preferred : candidates;

    const shuffled = shuffle(pickFrom).sort(
      (a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)
    );

    state.speciesCursor = (idx + 1) % SPECIES.length;
    return shuffled[Math.floor(Math.random() * Math.min(3, shuffled.length))] || shuffled[0];
  }

  return null;
}
