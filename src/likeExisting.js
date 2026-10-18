import { getAgent, likePost } from "./blueskyClient.js";
import { logger } from "./logger.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Backfill: walks the bot account's own feed (newest -> oldest) and likes
 * every post of its own that it hasn't liked yet. Safe to re-run any time —
 * it relies on Bluesky's own `viewer.like` flag (not state.json), so it
 * never touches data/state.json and can't conflict with the posting workflow.
 *
 * Stops cleanly if Bluesky rate-limits us (HTTP 429); just run it again later
 * and it picks up where it left off, since liked posts are skipped.
 */
export async function likeExistingPosts({ dry = false, max = Infinity, delayMs = 250 } = {}) {
  const agent = await getAgent();
  const did = agent.session?.did;
  if (!did) throw new Error("Not logged in — no session DID.");

  let cursor;
  let scanned = 0;
  let liked = 0;
  let alreadyLiked = 0;
  let failed = 0;
  let rateLimited = false;

  do {
    const res = await agent.getAuthorFeed({
      actor: did,
      limit: 100,
      cursor,
      filter: "posts_no_replies",
    });

    for (const item of res.data.feed) {
      if (liked >= max) break;
      if (item.reason) continue; // a repost, not one of our own posts
      const post = item.post;
      if (post.author.did !== did) continue;

      scanned++;
      if (post.viewer?.like) {
        alreadyLiked++;
        continue;
      }

      if (dry) {
        liked++;
        logger.info(`[DRY RUN] Would like ${post.uri}: "${(post.record?.text || "").slice(0, 60)}..."`);
        continue;
      }

      try {
        await likePost({ uri: post.uri, cid: post.cid });
        liked++;
        if (liked % 50 === 0) logger.info(`Liked ${liked} so far...`);
      } catch (err) {
        if (err.status === 429) {
          logger.warn("Hit Bluesky's rate limit — stopping. Run again later to continue.");
          rateLimited = true;
          break;
        }
        failed++;
        logger.warn(`Failed to like ${post.uri}:`, err.message);
      }
      await sleep(delayMs);
    }

    cursor = res.data.cursor;
  } while (cursor && liked < max && !rateLimited);

  return { scanned, liked, alreadyLiked, failed };
}
