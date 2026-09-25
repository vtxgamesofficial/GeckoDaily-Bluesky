import { buildAllPools } from "./contentSource.js";
import { loadState, saveState, markPosted, isNearDuplicate } from "./state.js";
import { selectItem } from "./selectItem.js";
import { composeBody, pickHashtags } from "./composer.js";
import { assemblePost, publishPost } from "./blueskyClient.js";
import { logger } from "./logger.js";

/**
 * Runs one full posting cycle:
 *  1. pull fresh content from every species' live plugin API
 *  2. pick an item that hasn't been posted recently, rotating species/type
 *  3. have Cloudflare AI rewrite it, then validate the rewrite
 *  4. assemble the final post (body + shortened tracking link + hashtags)
 *  5. post to Bluesky (unless --dry), and record it so it isn't repeated
 *
 * If a chosen item fails to produce a valid post after retries, it tries
 * the next-best item rather than giving up the whole run — the bot should
 * basically never post nothing just because one fact didn't rewrite well.
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

  const MAX_ITEM_ATTEMPTS = 4;
  for (let i = 0; i < MAX_ITEM_ATTEMPTS; i++) {
    const item = selectItem(pools, state);
    if (!item) {
      logger.error("Could not select any item to post.");
      break;
    }

    logger.info(`Attempting item ${item.id} (${item.type}/${item.category}) for ${item.species.slug}`);
    const result = await composeBody(item);
    if (!result.ok) {
      logger.warn(`Composer rejected item ${item.id}: ${result.reason}. Trying another item.`);
      // Mark as posted anyway so we don't immediately retry the same bad item next run.
      markPosted(state, item.id, "");
      continue;
    }

    if (isNearDuplicate(state, result.text)) {
      logger.warn(`Composed text for ${item.id} is a near-duplicate of a recent post. Trying another item.`);
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
      await publishPost({ text, facets });
      logger.info("Posted to Bluesky:\n" + text);
    }

    markPosted(state, item.id, text);
    await saveState(state);
    return { posted: true, text, item: item.id };
  }

  await saveState(state);
  return { posted: false, reason: "no valid item after retries" };
}
