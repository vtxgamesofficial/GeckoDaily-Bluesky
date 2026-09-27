import { BskyAgent } from "@atproto/api";
import { config, assertBlueskyCreds } from "./config.js";
import { logger } from "./logger.js";
import { graphemeLength, truncateToGraphemes } from "./composer.js";

const BSKY_MAX_GRAPHEMES = 300;

const encoder = new TextEncoder();
function byteLen(str) {
  return encoder.encode(str).length;
}

/**
 * Builds AT Protocol facets by hand rather than relying on RichText's
 * auto-detection. Auto-detection would turn our short display anchor
 * (e.g. "geckodaily.vercel.app/leotable") into a link pointing at that
 * literal text — which would strip the UTM parameters we need for
 * traffic attribution. Building the facet manually lets the *displayed*
 * text stay short while the *underlying* link keeps the full tracking URL.
 */
export function buildFacets(fullText, { linkText, linkUrl, hashtags = [] }) {
  const facets = [];

  if (linkText) {
    const idx = fullText.indexOf(linkText);
    if (idx !== -1) {
      const byteStart = byteLen(fullText.slice(0, idx));
      const byteEnd = byteStart + byteLen(linkText);
      facets.push({
        index: { byteStart, byteEnd },
        features: [{ $type: "app.bsky.richtext.facet#link", uri: linkUrl }],
      });
    } else {
      logger.warn("Link anchor text not found in post body, link will not be clickable:", linkText);
    }
  }

  for (const tag of hashtags) {
    const idx = fullText.indexOf(tag);
    if (idx === -1) continue;
    const byteStart = byteLen(fullText.slice(0, idx));
    const byteEnd = byteStart + byteLen(tag);
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: "app.bsky.richtext.facet#tag", tag: tag.replace(/^#/, "") }],
    });
  }

  // Facets must be sorted by byteStart for some clients to render correctly.
  facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
  return facets;
}

/**
 * Assembles the final post text + facets from a composed body and item
 * metadata. Enforces Bluesky's real 300-*grapheme* hard limit here (not
 * in composer.js), because only here do we know the full text — the
 * anchor line's length varies a lot depending on the page's URL path
 * (short vs. deeply-nested pages), and hashtags add more on top. If body
 * + anchor + hashtags would exceed 300 graphemes, the body gets trimmed
 * to fit — never the anchor/link or hashtags, since those are short and
 * fixed-purpose (attribution + discoverability).
 */
export function assemblePost({ body, pageUrl, pageLabel, hashtags }) {
  const anchor = `🦎 ${pageLabel}`;
  const tagLine = hashtags.length ? ` ${hashtags.join(" ")}` : "";
  const fixedTail = `\n\n${anchor}${tagLine}`;
  const fixedLen = graphemeLength(fixedTail);

  const budget = BSKY_MAX_GRAPHEMES - fixedLen;
  let finalBody = body;
  if (budget < 1) {
    // Anchor + hashtags alone (rare: an extremely long page path) already
    // eat the whole budget. Drop hashtags first before giving up on body.
    logger.warn(`Anchor+hashtags alone are ${fixedLen} graphemes — dropping hashtags to make room.`);
    return assemblePost({ body, pageUrl, pageLabel, hashtags: [] });
  }
  if (graphemeLength(body) > budget) {
    finalBody = truncateToGraphemes(body, budget);
  }

  const text = `${finalBody}${fixedTail}`;
  const facets = buildFacets(text, { linkText: anchor, linkUrl: pageUrl, hashtags });
  return { text, facets };
}

let agentPromise = null;
export async function getAgent() {
  if (!agentPromise) {
    agentPromise = (async () => {
      assertBlueskyCreds();
      const agent = new BskyAgent({ service: config.bluesky.service });
      await agent.login({
        identifier: config.bluesky.identifier,
        password: config.bluesky.appPassword,
      });
      return agent;
    })();
  }
  return agentPromise;
}

export async function publishPost({ text, facets }) {
  const agent = await getAgent();
  const record = {
    text,
    facets,
    createdAt: new Date().toISOString(),
  };
  return agent.post(record);
}

/**
 * Safe, low-volume engagement: searches Bluesky for recent posts matching
 * on-topic keywords and likes a small, capped number of them. Deliberately
 * does NOT auto-follow or auto-reply — unsolicited replies/follows from a
 * bot are exactly what gets accounts reported as spam, and read as noise to
 * the person on the other end. A like is a low-friction, low-risk way to
 * put GeckoDaily's handle in front of people already talking about geckos.
 */
export async function likeOnTopicPosts({ queries, maxLikes, alreadyLiked, ownDid }) {
  const agent = await getAgent();
  const liked = [];

  for (const q of queries) {
    if (liked.length >= maxLikes) break;
    let res;
    try {
      res = await agent.app.bsky.feed.searchPosts({ q, limit: 10 });
    } catch (err) {
      logger.warn(`Bluesky search failed for query "${q}":`, err.message);
      continue;
    }

    for (const post of res.data.posts) {
      if (liked.length >= maxLikes) break;
      if (post.author.did === ownDid) continue;
      if (alreadyLiked.includes(post.uri)) continue;
      if (post.viewer?.like) continue; // already liked, e.g. from a previous bot run not yet flushed
      // Skip replies/threads that look off-topic (e.g. contain sale/scam markers).
      if (/\b(nsfw|onlyfans|crypto|nft|for\s*sale)\b/i.test(post.record?.text || "")) continue;

      try {
        await agent.like(post.uri, post.cid);
        liked.push(post.uri);
        logger.info(`Liked post from @${post.author.handle}: "${(post.record?.text || "").slice(0, 60)}..."`);
      } catch (err) {
        logger.warn(`Failed to like ${post.uri}:`, err.message);
      }
    }
  }

  return liked;
}
