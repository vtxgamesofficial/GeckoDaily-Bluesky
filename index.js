import { postOnce, postBatch } from "./src/postOnce.js";
import { engageOnce } from "./src/engagement.js";
import { startScheduler } from "./src/scheduler.js";
import { deleteAllPosts } from "./src/deleteAllPosts.js";
import { logger } from "./src/logger.js";

// Hardcoded here on purpose (per request) instead of an env var/secret —
// this is the ONE place that controls the daily volume for `--daily`.
// Change these two numbers directly if you ever want a different pace;
// no GitHub secret needed.
const DAILY_POST_COUNT = 450;
const DAILY_INTERVAL_SEC = 7; // gap between posts within the batch

const args = process.argv.slice(2);
const dry = args.includes("--dry");

function getFlagValue(name, fallback) {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  if (!arg) return fallback;
  const val = arg.split("=")[1];
  return val === "forever" ? Infinity : Number(val);
}

// --loop=N repeats the run N times (use "forever" for an unbounded loop).
// --interval=S waits S seconds between repeats (default 5s — Cloudflare AI
// rate limits are generous, but there's no reason to hammer them back-to-back).
const loopCount = getFlagValue("loop", 1);
const intervalSec = getFlagValue("interval", 5);

function printHelp() {
  console.log(`
GeckoDaily Bluesky bot

Usage:
  node index.js --once                        Post one item now
  node index.js --once --dry                  Compose + validate a post but don't publish it
  node index.js --once --dry --loop=10        Preview 10 posts back-to-back, no Bluesky needed
  node index.js --once --loop=50               Post 50 items, fetching the content pool ONCE (efficient batch mode)
  node index.js --daily                        Post ${DAILY_POST_COUNT} items today (hardcoded count/interval, see top of index.js)
  node index.js --daily --dry                   Preview what a full daily batch would post, no Bluesky needed
  node index.js --purge-all-posts --dry         Preview EVERY post currently on the account (no deletes)
  node index.js --purge-all-posts --yes-delete-everything
                                                 Actually delete every post on the account. Irreversible.
  node index.js --engage                      Run one engagement (safe-liking) pass
  node index.js --engage --dry                Show what the engagement pass would search for
  node index.js --schedule                    Run forever, posting/engaging on a fixed cron schedule instead of a loop

Note: --dry mode never contacts Bluesky at all, so you can preview posts
on a loop before you've even set up a Bluesky app password. It still
fetches live content + checks links, so it needs network access.

Config lives in .env — see .env.example.
`);
}

async function main() {
  if (args.includes("--purge-all-posts")) {
    // Deliberately requires a separate explicit flag, not just --purge-all-posts
    // alone, so this can never fire by accident from a mistyped/copy-pasted
    // command. Irreversible — deletes every post on the account.
    if (!args.includes("--yes-delete-everything")) {
      logger.error(
        "Refusing to run: pass BOTH --purge-all-posts --yes-delete-everything to actually delete every post on this account (or add --dry to preview first)."
      );
      process.exitCode = 1;
      return;
    }
    const { total, deleted, failed } = await deleteAllPosts({ dry });
    logger.info(`Purge finished. total=${total} deleted=${deleted} failed=${failed}`);
    return;
  }

  if (args.includes("--daily")) {
    const { postedCount, failedCount } = await postBatch({
      count: DAILY_POST_COUNT,
      intervalSec: DAILY_INTERVAL_SEC,
      dry,
    });
    if (postedCount === 0 && !dry) {
      logger.error("Daily batch posted nothing.");
      process.exitCode = 1;
    }
    logger.info(`Daily batch done: ${postedCount} posted, ${failedCount} failed/skipped.`);
    return;
  }

  if (args.includes("--once")) {
    if (loopCount === 1) {
      const result = await postOnce({ dry });
      if (!result.posted) {
        logger.error("Run finished without posting:", result.reason);
        process.exitCode = 1;
      }
      return;
    }
    // loopCount > 1 (or "forever"): use the batch path so the content pool
    // is fetched once and reused, instead of re-fetching it before every post.
    await postBatch({
      count: loopCount === Infinity ? Number.MAX_SAFE_INTEGER : loopCount,
      intervalSec,
      dry,
    });
    return;
  }

  if (args.includes("--engage")) {
    await engageOnce({ dry });
    return;
  }

  if (args.includes("--schedule")) {
    startScheduler();
    return; // keep process alive via cron
  }

  printHelp();
}

main().catch((err) => {
  logger.error("Fatal error:", err);
  process.exitCode = 1;
});

