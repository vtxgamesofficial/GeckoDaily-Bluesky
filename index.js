import { postOnce } from "./src/postOnce.js";
import { engageOnce } from "./src/engagement.js";
import { startScheduler } from "./src/scheduler.js";
import { logger } from "./src/logger.js";

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
  console.log(`
GeckoDaily Bluesky bot

Usage:
  node index.js --once                        Post one item now
  node index.js --once --dry                  Compose + validate a post but don't publish it
  node index.js --once --dry --loop=10        Preview 10 posts back-to-back, no Bluesky needed
  node index.js --once --dry --loop=forever   Keep previewing posts until you Ctrl+C
  node index.js --once --loop=forever         Actually post over and over, forever (needs Bluesky creds)
  node index.js --loop=5 --interval=30 --once Repeat 5 times, 30s apart (default interval: 5s)
  node index.js --engage                      Run one engagement (safe-liking) pass
  node index.js --engage --dry                Show what the engagement pass would search for
  node index.js --schedule                    Run forever, posting/engaging on a fixed cron schedule instead of a loop

Note: --dry mode never contacts Bluesky at all — it only needs
CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN in .env, so you can preview
posts on a loop before you've even set up a Bluesky app password.

Config lives in .env — see .env.example.
`);
}

async function main() {
  if (args.includes("--once")) {
    for (let i = 0; loopCount === Infinity || i < loopCount; i++) {
      if (loopCount !== 1) logger.info(`--- run ${i + 1}${loopCount === Infinity ? "" : `/${loopCount}`} ---`);
      const result = await postOnce({ dry });
      if (!result.posted) {
        logger.error("Run finished without posting:", result.reason);
        if (loopCount === 1) process.exitCode = 1;
      }
      const isLast = loopCount !== Infinity && i === loopCount - 1;
      if (!isLast) await sleep(intervalSec * 1000);
    }
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

