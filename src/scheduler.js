import cron from "node-cron";
import { config } from "./config.js";
import { postOnce } from "./postOnce.js";
import { engageOnce } from "./engagement.js";
import { logger } from "./logger.js";

export function startScheduler() {
  logger.info(`Scheduling posts: "${config.schedule.postCron}" (${config.schedule.tz})`);
  cron.schedule(
    config.schedule.postCron,
    () => {
      postOnce().catch((err) => logger.error("Scheduled post run failed:", err));
    },
    { timezone: config.schedule.tz }
  );

  if (config.engagement.enabled) {
    logger.info(`Scheduling engagement: "${config.schedule.engageCron}" (${config.schedule.tz})`);
    cron.schedule(
      config.schedule.engageCron,
      () => {
        engageOnce().catch((err) => logger.error("Scheduled engagement run failed:", err));
      },
      { timezone: config.schedule.tz }
    );
  } else {
    logger.info("Engagement disabled (ENGAGE_ENABLED=false) — not scheduling likes.");
  }

  logger.info("Scheduler running. Press Ctrl+C to stop.");
}
