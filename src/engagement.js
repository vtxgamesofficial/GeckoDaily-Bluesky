import { config, SPECIES } from "./config.js";
import { loadState, saveState, markLiked } from "./state.js";
import { getAgent, likeOnTopicPosts } from "./blueskyClient.js";
import { logger } from "./logger.js";

function buildQueries() {
  // Keep queries specific to the species GeckoDaily actually covers, so
  // likes land on people genuinely talking about these animals rather than
  // reptiles in general.
  const perSpecies = SPECIES.map((s) => s.common.toLowerCase());
  return [...new Set(perSpecies)];
}

export async function engageOnce({ dry = false } = {}) {
  if (!config.engagement.enabled && !dry) {
    logger.info("ENGAGE_ENABLED is false — skipping engagement run. Set ENGAGE_ENABLED=true in .env to turn it on.");
    return { liked: [] };
  }

  const state = await loadState();
  const agent = await getAgent();
  const queries = buildQueries();

  if (dry) {
    logger.info(`[DRY RUN] Would search for on-topic posts using queries: ${queries.join(", ")} and like up to ${config.engagement.maxLikes}.`);
    return { liked: [] };
  }

  const liked = await likeOnTopicPosts({
    queries,
    maxLikes: config.engagement.maxLikes,
    alreadyLiked: state.likedUris,
    ownDid: agent.session?.did,
  });

  for (const uri of liked) markLiked(state, uri);
  await saveState(state);

  logger.info(`Engagement run complete. Liked ${liked.length} post(s).`);
  return { liked };
}
