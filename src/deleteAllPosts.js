import { getAgent } from "./blueskyClient.js";
import { saveState } from "./state.js";
import { logger } from "./logger.js";

const DELETE_DELAY_MS = 350; // small gap between deletes to stay well clear of rate limits

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deletes EVERY post currently in the bot's own Bluesky repo.
 * Uses com.atproto.repo.listRecords directly (not the getAuthorFeed API)
 * so it walks the account's actual post records rather than a
 * feed/algorithm view — nothing gets missed or filtered out.
 *
 * This is destructive and irreversible. Callers (index.js) are expected to
 * have already gotten explicit confirmation before calling this.
 */
export async function deleteAllPosts({ dry = false } = {}) {
  const agent = await getAgent();
  const did = agent.session.did;

  let cursor;
  let total = 0;
  let deleted = 0;
  let failed = 0;

  do {
    const res = await agent.api.com.atproto.repo.listRecords({
      repo: did,
      collection: "app.bsky.feed.post",
      limit: 100,
      cursor,
    });

    const records = res.data.records || [];
    total += records.length;

    for (const record of records) {
      if (dry) {
        logger.info(`[DRY RUN] Would delete ${record.uri}`);
        continue;
      }
      try {
        await agent.deletePost(record.uri);
        deleted++;
        if (deleted % 25 === 0) logger.info(`Deleted ${deleted} posts so far...`);
      } catch (err) {
        failed++;
        logger.warn(`Failed to delete ${record.uri}: ${err.message}`);
      }
      await sleep(DELETE_DELAY_MS);
    }

    cursor = res.data.cursor;
  } while (cursor);

  logger.info(
    dry
      ? `[DRY RUN] Found ${total} posts. Nothing deleted (dry run).`
      : `Done. Found ${total} posts, deleted ${deleted}, failed ${failed}.`
  );

  if (!dry && deleted > 0) {
    // The old posted-history log is meaningless once the posts themselves
    // are gone — start state fresh so the bot doesn't think it already
    // "recently posted" things that no longer exist.
    await saveState({
      postedIds: [],
      recentTexts: [],
      speciesCursor: 0,
      typeCursor: 0,
      likedUris: [],
      lastRunAt: new Date().toISOString(),
    });
    logger.info("Reset data/state.json since the posts it was tracking no longer exist.");
  }

  return { total, deleted, failed };
}
