import { config, SPECIES } from "./config.js";
import { logger } from "./logger.js";

const BASE = config.site.baseUrl.replace(/\/$/, "");
const BASE_ORIGIN = new URL(BASE).origin; // e.g. https://geckodaily.vercel.app

async function getJSON(url) {
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

// ── Raw fetchers, one per plugin endpoint every GeckoDaily table exposes ──
export async function getFacts(slug) {
  return getJSON(`${BASE}/${slug}/api/plugin/facts`);
}
export async function getCare(slug) {
  return getJSON(`${BASE}/${slug}/api/plugin/care`);
}
export async function getPlants(slug) {
  return getJSON(`${BASE}/${slug}/api/plugin/plants`);
}
export async function getFeeders(slug) {
  return getJSON(`${BASE}/${slug}/api/plugin/feeders`);
}
export async function getSiteIndex(slug) {
  return getJSON(`${BASE}/${slug}/api/plugin/site`);
}

/**
 * Builds a link that is ALWAYS on the one real site (config.site.baseUrl /
 * BASE_ORIGIN), no matter what domain the API's own pageLink/href field
 * says. This is the fix for the bot posting dead/retired per-table
 * subdomains (crestytable.vercel.app etc.) — those fields are only ever
 * used for their PATH, never their host.
 *
 * Returns null (meaning "drop this item, don't post it") if:
 *  - there's no usable candidate URL/path at all, or
 *  - the resulting path doesn't live under /{slug}/..., which is the
 *    shape every real GeckoDaily page has. A path that doesn't match that
 *    shape is far more likely to be stale/garbage data from the API than
 *    a real page, so we skip it rather than gamble on posting it.
 */
function canonicalPageUrl(candidate, { slug, fallbackPath }) {
  let target;
  try {
    // Resolves both absolute URLs (any domain) and relative paths against
    // BASE_ORIGIN — either way we only keep pathname + search below.
    target = new URL(candidate || fallbackPath, BASE_ORIGIN);
  } catch {
    try {
      target = new URL(fallbackPath, BASE_ORIGIN);
    } catch {
      return null;
    }
  }

  const path = `${target.pathname}${target.search}`;
  if (!new RegExp(`^/${slug}(/|$)`, "i").test(target.pathname)) {
    logger.warn(`Dropping item for ${slug}: link path "${target.pathname}" isn't under /${slug}/ — likely stale API data.`);
    return null;
  }

  return { url: `${BASE_ORIGIN}${path}`, label: `${BASE_ORIGIN.replace(/^https?:\/\//, "")}${target.pathname}` };
}

function withUtm(url, { campaign, contentId }) {
  const u = new URL(url);
  u.searchParams.set("utm_source", "bluesky");
  u.searchParams.set("utm_medium", "social");
  u.searchParams.set("utm_campaign", campaign);
  if (contentId) u.searchParams.set("utm_content", contentId);
  return u.toString();
}

// In-run cache: HEAD-check a given URL at most once per batch run, and
// reuse the result for every item that happens to share that page link.
const linkCheckCache = new Map();
const LINK_CHECK_TIMEOUT_MS = 6000;

/**
 * Confirms a page actually resolves (2xx/3xx) before we let the bot post
 * it. Falls back to GET if the host rejects HEAD (some hosts do). Treats
 * network errors/timeouts as "unreachable" — safer to skip a post than to
 * publish a dead link.
 */
export async function verifyLinkLive(url) {
  if (linkCheckCache.has(url)) return linkCheckCache.get(url);

  const check = async (method) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LINK_CHECK_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method, redirect: "follow", signal: controller.signal });
      return res.ok || (res.status >= 300 && res.status < 400);
    } finally {
      clearTimeout(timer);
    }
  };

  let ok;
  try {
    ok = await check("HEAD");
  } catch {
    try {
      ok = await check("GET");
    } catch (err) {
      logger.warn(`Link check failed for ${url}: ${err.message}`);
      ok = false;
    }
  }

  linkCheckCache.set(url, ok);
  return ok;
}

/**
 * Builds a normalized pool of postable "items" for one species by hitting
 * every plugin endpoint that species exposes. Each item carries the short
 * "quick answer" text that's already on the site (no AI rewriting — we
 * post the source claim/summary as-is), a stable id (for the
 * never-repeat-too-soon log), and a UTM-tagged deep link back to the
 * exact page that content lives on, always on the real domain.
 */
export async function buildItemPool(species) {
  const { slug } = species;
  const items = [];

  const results = await Promise.allSettled([
    getFacts(slug),
    getCare(slug),
    getPlants(slug),
    getFeeders(slug),
    getSiteIndex(slug),
  ]);
  const [factsR, careR, plantsR, feedersR, siteR] = results;

  if (factsR.status === "fulfilled") {
    const { facts = [], morphs = [] } = factsR.value;
    for (const f of facts) {
      if (!f.claim) continue; // the "quick answer" — skip anything that doesn't have one
      const link = canonicalPageUrl(f.pageLink, { slug, fallbackPath: `/${slug}/knowyou` });
      if (!link) continue;
      items.push({
        type: "fact",
        species,
        id: `fact:${slug}:${f.id}`,
        category: f.category,
        quickAnswer: f.claim,
        pageUrl: withUtm(link.url, { campaign: "fact", contentId: f.id }),
        pageLabel: link.label,
      });
    }
    for (const m of morphs) {
      const label = m.name || m.morph || "morph";
      const desc = m.description || m.detail || m.notes || "";
      if (!desc) continue;
      const link = canonicalPageUrl(m.pageLink, { slug, fallbackPath: `/${slug}/knowyou` });
      if (!link) continue;
      items.push({
        type: "morph",
        species,
        id: `morph:${slug}:${label}`,
        category: "morphs",
        quickAnswer: `${label}: ${desc}`,
        pageUrl: withUtm(link.url, { campaign: "morph", contentId: label }),
        pageLabel: link.label,
      });
    }
  } else {
    logger.warn(`facts fetch failed for ${slug}:`, factsR.reason?.message);
  }

  if (careR.status === "fulfilled") {
    const guides = careR.value.guides || [];
    for (const g of guides) {
      if (!g.summary) continue; // the quick answer for a care topic
      const link = canonicalPageUrl(g.pageLink, { slug, fallbackPath: `/${slug}/${g.topic}` });
      if (!link) continue;
      items.push({
        type: "care",
        species,
        id: `care:${slug}:${g.topic}`,
        category: g.topic,
        quickAnswer: g.summary,
        pageUrl: withUtm(link.url, { campaign: "care", contentId: g.topic }),
        pageLabel: link.label,
      });
    }
  } else {
    logger.warn(`care fetch failed for ${slug}:`, careR.reason?.message);
  }

  if (plantsR.status === "fulfilled") {
    const plants = (plantsR.value.plants || []).filter((p) => p.safety);
    for (const p of plants) {
      const name = p.name || p.commonName;
      if (!name) continue;
      const link = canonicalPageUrl(plantsR.value.pageLink, { slug, fallbackPath: `/${slug}/plants` });
      if (!link) continue;
      items.push({
        type: "plant",
        species,
        id: `plant:${slug}:${name}`,
        category: `plant-${p.safety}`,
        quickAnswer: `${name} is rated "${p.safety}" for a ${species.common} enclosure.`,
        pageUrl: withUtm(link.url, { campaign: "plant", contentId: name }),
        pageLabel: link.label,
      });
    }
  } else {
    logger.warn(`plants fetch failed for ${slug}:`, plantsR.reason?.message);
  }

  if (feedersR.status === "fulfilled") {
    const feeders = (feedersR.value.feeders || []).filter((f) => f.tier && f.tier !== "avoid");
    for (const f of feeders) {
      const name = f.name || f.insect;
      if (!name) continue;
      const link = canonicalPageUrl(feedersR.value.pageLink, { slug, fallbackPath: `/${slug}/food` });
      if (!link) continue;
      items.push({
        type: "feeder",
        species,
        id: `feeder:${slug}:${name}`,
        category: `feeder-${f.tier}`,
        quickAnswer: `${name} — ${f.tier} tier feeder for ${species.common}.`,
        pageUrl: withUtm(link.url, { campaign: "feeder", contentId: name }),
        pageLabel: link.label,
      });
    }
  } else {
    logger.warn(`feeders fetch failed for ${slug}:`, feedersR.reason?.message);
  }

  if (siteR.status === "fulfilled") {
    const sections = siteR.value.sections || [];
    for (const group of sections) {
      if (group.group === "Plugin API") continue; // not interesting to a human reader
      for (const item of group.items || []) {
        if (!item.description) continue;
        const link = canonicalPageUrl(item.href, { slug, fallbackPath: `/${slug}` });
        if (!link) continue;
        items.push({
          type: "section",
          species,
          id: `section:${slug}:${item.label}`,
          category: group.group,
          quickAnswer: item.description,
          pageUrl: withUtm(link.url, { campaign: "section", contentId: item.label }),
          pageLabel: link.label,
        });
      }
    }
  } else {
    logger.warn(`site index fetch failed for ${slug}:`, siteR.reason?.message);
  }

  return items;
}

/**
 * Old per-endpoint pool builder — 30 HTTP calls (5 endpoints × 6 species).
 * Kept for reference / fallback but no longer used by default; see
 * buildAllPoolsFromFeed() below, which gets everything in ONE call.
 */
export async function buildAllPoolsFromPluginEndpoints() {
  const pools = {};
  for (const species of SPECIES) {
    try {
      pools[species.slug] = await buildItemPool(species);
    } catch (err) {
      logger.error(`Failed to build item pool for ${species.slug}:`, err.message);
      pools[species.slug] = [];
    }
  }
  return pools;
}

// ── Combined /api/feed endpoint (one call for every species) ──────────

/**
 * Fetches the site's single combined feed. Requires config.site.feedKey
 * (SITE_FEED_KEY env var) — the endpoint is gated behind ?key=.
 */
export async function getFullFeed() {
  const url = `${BASE}${config.site.feedPath}?key=${encodeURIComponent(config.site.feedKey)}`;
  return getJSON(url);
}

/** Pulls the first truthy string field out of an object, trying each key in order. */
function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== "") return obj[k];
  }
  return undefined;
}

/**
 * The feed's exact shape isn't pinned down here, so this normalizer is
 * deliberately permissive: it accepts a raw feed payload in any of the
 * shapes below and flattens it into one array of raw item-ish objects.
 *   - a bare array of items
 *   - { items: [...] } / { data: [...] } / { feed: [...] } / { results: [...] }
 *   - { posts: [...] }
 *   - an object keyed by species slug -> array of items, e.g. { leotable: [...], ... }
 *   - a grouped shape like the old per-endpoint responses, merged:
 *     { facts: [...], care: [...], plants: [...], feeders: [...], sections: [...] }
 */
function flattenFeedPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];

  for (const key of ["items", "data", "feed", "results", "posts"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }

  const slugSet = new Set(SPECIES.map((s) => s.slug));
  const keys = Object.keys(payload);
  if (keys.length && keys.every((k) => slugSet.has(k) || Array.isArray(payload[k]))) {
    return keys.flatMap((k) => (Array.isArray(payload[k]) ? payload[k].map((it) => ({ slug: it.slug || k, ...it })) : []));
  }

  const grouped = ["facts", "morphs", "care", "guides", "plants", "feeders", "sections"];
  if (grouped.some((k) => Array.isArray(payload[k]))) {
    return grouped.flatMap((k) => (Array.isArray(payload[k]) ? payload[k] : []));
  }

  return [];
}

/**
 * Normalizes one raw feed entry (whatever field names it happens to use)
 * into the same item shape buildItemPool() produces, so selectItem.js /
 * composer.js / postOnce.js don't need to know or care which source built
 * the pool.
 *
 * Returns null for anything that can't be matched to a known species or
 * doesn't carry any postable text — same "skip, don't guess" policy as
 * the plugin-endpoint path.
 */
function normalizeFeedItem(raw, index) {
  const slugField = pick(raw, ["slug", "speciesSlug", "table"]) || raw.species?.slug;
  const species =
    SPECIES.find((s) => s.slug === slugField) ||
    SPECIES.find((s) => s.common === raw.species?.common || s.name === raw.species?.name);
  if (!species) {
    logger.warn(`Dropping feed item #${index}: couldn't match it to a known species (slug="${slugField}").`);
    return null;
  }
  const { slug } = species;

  const type = pick(raw, ["type", "kind", "category"]) || "fact";
  const quickAnswer = pick(raw, ["quickAnswer", "claim", "summary", "description", "text", "body"]);
  if (!quickAnswer) return null;

  const rawLink = pick(raw, ["pageLink", "href", "url", "pageUrl", "link"]);
  const link = canonicalPageUrl(rawLink, { slug, fallbackPath: `/${slug}` });
  if (!link) return null;

  const category = pick(raw, ["category", "topic", "group"]) || type;
  const contentId = pick(raw, ["id", "slug", "name", "label"]) || `${type}-${index}`;

  return {
    type,
    species,
    id: `${type}:${slug}:${contentId}`,
    category,
    quickAnswer,
    pageUrl: withUtm(link.url, { campaign: type, contentId: String(contentId) }),
    pageLabel: link.label,
  };
}

/**
 * Builds pools for every species from the single combined /api/feed
 * endpoint (one HTTP call total) instead of 30 separate plugin-API calls.
 * This is now the default content source — see postOnce.js / index.js.
 */
export async function buildAllPoolsFromFeed() {
  const pools = {};
  for (const species of SPECIES) pools[species.slug] = [];

  let payload;
  try {
    payload = await getFullFeed();
  } catch (err) {
    logger.error(`Failed to fetch combined feed: ${err.message}`);
    return pools;
  }

  const rawItems = flattenFeedPayload(payload);
  if (rawItems.length === 0) {
    logger.warn("Combined feed returned no recognizable items — check SITE_FEED_KEY / feed shape.");
    logger.warn(`Raw feed payload sample: ${JSON.stringify(payload).slice(0, 500)}`);
    return pools;
  }

  let dropped = 0;
  rawItems.forEach((raw, i) => {
    const item = normalizeFeedItem(raw, i);
    if (!item) {
      dropped++;
      return;
    }
    pools[item.species.slug].push(item);
  });

  const kept = rawItems.length - dropped;
  logger.info(`Combined feed: kept ${kept}/${rawItems.length} items across ${SPECIES.length} species.`);
  return pools;
}

export async function buildAllPools() {
  return buildAllPoolsFromFeed();
}
