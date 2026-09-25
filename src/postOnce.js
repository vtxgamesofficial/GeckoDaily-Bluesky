import { buildAllPools, verifyLinkLive } from "./contentSource.js";
import { loadState, saveState, markPosted, isNearDuplicate } from "./state.js";
import { selectItem } from "./selectItem.js";
import { composeBody, pickHashtags } from "./composer.js";
import { assemblePost, publishPost } from "./blueskyClient.js";
import { logger } from "./logger.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Composes + (optionally) publishes ONE post, given already-loaded pools
 * and state. Does NOT build pools, load state, or save state itself —
 * callers own that, so a batch run can reuse the same pools/state across
 * many posts instead of rebuilding everything from scratch every time.
 *
 * Mutates `state` in place (markPosted) so the caller just needs to persist
 * it whenever it wants (every post, every N posts, or once at the end).
 */
async function postOneFromPools(pools, state, { dry = false } = {}) {
  const MAX_ITEM_ATTEMPTS = 6;
  for (let i = 0; i < MAX_ITEM_ATTEMPTS; i++) {
    const item = selectItem(pools, state);
    if (!item) return { posted: false, reason: "no item selectable" };

    // Confirm the page this item links to actually resolves BEFORE we
    // spend anything else on it. Catches stale/garbage links that made it
    // past the domain/path sanity check in contentSource.js (e.g. a path
    // that matches /{slug}/... shape but the specific page was removed).
    const linkLive = await verifyLinkLive(item.pageUrl);
    if (!linkLive) {
      logger.warn(`Skipping item ${item.id} — link did not resolve: ${item.pageUrl}`);
      markPosted(state, item.id, ""); // don't keep retrying the same dead link
      continue;
    }

    logger.info(`Attempting item ${item.id} (${item.type}/${item.category}) for ${item.species.slug}`);
    const result = composeBody(item);
    if (!result.ok) {
      logger.warn(`Rejected item ${item.id}: ${result.reason}. Trying another item.`);
      markPosted(state, item.id, "");
      continue;
    }

    if (isNearDuplicate(state, result.text)) {
      logger.warn(`Text for ${item.id} is a near-duplicate of a recent post. Trying another item.`);
      continue;
    }

    const hashtags = pickHashtags(item);
    const { text, facets } = assemblePost({
      body: result.text,
      pageUrl: item.pageUrl,
      pageLabel: item.pageLabel,
      hashtags,
    });

    if (dry) {
      logger.info("[DRY RUN] Would post:\n" + text);
    } else {
      await publishWithRetry({ text, facets });
      logger.info("Posted to Bluesky:\n" + text);
    }

    markPosted(state, item.id, text);
    return { posted: true, text, item: item.id };
  }
  return { posted: false, reason: "no valid item after retries" };
}

/** publishPost wrapped with a small retry/backoff so one flaky network
 * call (rate limit, blip, etc.) doesn't take down an entire multi-hundred-
 * post batch run. */
async function publishWithRetry({ text, facets }, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await publishPost({ text, facets });
    } catch (err) {
      if (i === attempts) throw err;
      const backoffMs = 2000 * i;
      logger.warn(`Publish failed (attempt ${i}/${attempts}): ${err.message}. Retrying in ${backoffMs}ms.`);
      await sleep(backoffMs);
    }
  }
}

/**
 * Runs one full posting cycle, building pools + loading/saving state
 * itself. This is the single-post entry point used by `npm run post` /
 * `--once` / `--dry`. For posting many times in one process (e.g. the
 * daily 450-post batch), use `postBatch` instead — it builds the content
 * pool ONCE and reuses it, rather than re-fetching all 6 species' APIs
 * (30 HTTP calls) before every single post.
 */
export async function postOnce({ dry = false } = {}) {
  const state = await loadState();
  const pools = await buildAllPools();

  const totalItems = Object.values(pools).reduce((n, p) => n + p.length, 0);
  logger.info(`Loaded ${totalItems} candidate items across ${Object.keys(pools).length} species.`);
  if (totalItems === 0) {
    logger.error("No content available from any species API — aborting run.");
    return { posted: false, reason: "empty content pool" };
  }

  const result = await postOneFromPools(pools, state, { dry });
  await saveState(state);
  return result;
}

/**
 * Posts `count` times in a single process run, fetching the live content
 * pool only ONCE up front and reusing it for every post — this is the
 * efficient path for a big daily batch (e.g. 450/day) instead of calling
 * postOnce() in a loop, which would rebuild the entire pool every time.
 *
 * State is saved every `saveEvery` posts (not just at the end) so a crash
 * or rate-limit abort partway through a long batch doesn't lose progress
 * on what's already been posted — the next run picks up cleanly.
 */
export async function postBatch({ count, intervalSec = 5, dry = false, saveEvery = 20 } = {}) {
  if (!Number.isFinite(count) || count <= 0) {
    throw new Error("postBatch requires a positive finite count");
  }

  const state = await loadState();
  const pools = await buildAllPools();

  const totalItems = Object.values(pools).reduce((n, p) => n + p.length, 0);
  logger.info(
    `Batch run: posting up to ${count} items (interval ${intervalSec}s) from a pool of ${totalItems} candidates.`
  );
  if (totalItems === 0) {
    logger.error("No content available from any species API — aborting batch run.");
    return { postedCount: 0, failedCount: 0 };
  }

  let postedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < count; i++) {
    logger.info(`--- batch post ${i + 1}/${count} ---`);
    try {
      const result = await postOneFromPools(pools, state, { dry });
      if (result.posted) postedCount++;
      else {
        failedCount++;
        logger.warn(`Batch item ${i + 1} did not post: ${result.reason}`);
      }
    } catch (err) {
      failedCount++;
      logger.error(`Batch item ${i + 1} threw an error, continuing batch:`, err.message);
    }

    if ((i + 1) % saveEvery === 0) await saveState(state);
    if (i < count - 1) await sleep(intervalSec * 1000);
  }

  await saveState(state);
  logger.info(`Batch run complete: ${postedCount} posted, ${failedCount} failed/skipped out of ${count}.`);
  return { postedCount, failedCount };
}
