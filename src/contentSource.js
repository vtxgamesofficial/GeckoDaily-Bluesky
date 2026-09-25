import { config, SPECIES } from "./config.js";
import { logger } from "./logger.js";

const BASE = config.site.baseUrl.replace(/\/$/, "");

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

function withUtm(url, { campaign, contentId }) {
  const u = new URL(url);
  u.searchParams.set("utm_source", "bluesky");
  u.searchParams.set("utm_medium", "social");
  u.searchParams.set("utm_campaign", campaign);
  if (contentId) u.searchParams.set("utm_content", contentId);
  return u.toString();
}

/**
 * Builds a normalized pool of postable "items" for one species by hitting
 * every plugin endpoint that species exposes. Each item carries enough
 * source material for the AI to rewrite, a stable id (for the
 * never-repeat-too-soon log), and a UTM-tagged deep link back to the
 * exact page that content lives on (not just the homepage — this spreads
 * inbound clicks across the whole site instead of dumping them all on `/`,
 * which is both better for visitors and better for internal-page SEO signal).
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
      items.push({
        type: "fact",
        species,
        id: `fact:${slug}:${f.id}`,
        category: f.category,
        sourceText: [f.claim, f.detail].filter(Boolean).join(" "),
        pageUrl: withUtm(`${BASE}/${slug}/knowyou`, { campaign: "fact", contentId: f.id }),
        pageLabel: `geckodaily.vercel.app/${slug}/knowyou`,
      });
    }
    for (const m of morphs) {
      // Morph objects vary slightly by species; be defensive about field names.
      const label = m.name || m.morph || "morph";
      const desc = m.description || m.detail || m.notes || "";
      if (!desc) continue;
      items.push({
        type: "morph",
        species,
        id: `morph:${slug}:${label}`,
        category: "morphs",
        sourceText: `${label}: ${desc}`,
        pageUrl: withUtm(`${BASE}/${slug}/knowyou`, { campaign: "morph", contentId: label }),
        pageLabel: `geckodaily.vercel.app/${slug}/knowyou`,
      });
    }
  } else {
    logger.warn(`facts fetch failed for ${slug}:`, factsR.reason?.message);
  }

  if (careR.status === "fulfilled") {
    const guides = careR.value.guides || [];
    for (const g of guides) {
      const points = (g.keyPoints || []).slice(0, 3).join(" | ");
      items.push({
        type: "care",
        species,
        id: `care:${slug}:${g.topic}`,
        category: g.topic,
        sourceText: `${g.summary} Key points: ${points}`,
        pageUrl: withUtm(g.pageLink || `${BASE}/${slug}/${g.topic}`, {
          campaign: "care",
          contentId: g.topic,
        }),
        pageLabel: `geckodaily.vercel.app/${slug}/${g.topic}`,
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
      const note = p.notes || p.note || p.description || "";
      items.push({
        type: "plant",
        species,
        id: `plant:${slug}:${name}`,
        category: `plant-${p.safety}`,
        sourceText: `${name} is rated "${p.safety}" for a ${species.common} enclosure. ${note}`,
        pageUrl: withUtm(plantsR.value.pageLink || `${BASE}/${slug}/plants`, {
          campaign: "plant",
          contentId: name,
        }),
        pageLabel: `geckodaily.vercel.app/${slug}/plants`,
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
      const note = f.notes || f.note || "";
      items.push({
        type: "feeder",
        species,
        id: `feeder:${slug}:${name}`,
        category: `feeder-${f.tier}`,
        sourceText: `${name} (${f.tier} tier feeder for ${species.common}). ${note}`,
        pageUrl: withUtm(feedersR.value.pageLink || `${BASE}/${slug}/food`, {
          campaign: "feeder",
          contentId: name,
        }),
        pageLabel: `geckodaily.vercel.app/${slug}/food`,
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
        items.push({
          type: "section",
          species,
          id: `section:${slug}:${item.label}`,
          category: group.group,
          sourceText: `${item.label}: ${item.description}`,
          pageUrl: withUtm(item.href, { campaign: "section", contentId: item.label }),
          pageLabel: item.href.replace(/^https?:\/\//, "").split("?")[0],
        });
      }
    }
  } else {
    logger.warn(`site index fetch failed for ${slug}:`, siteR.reason?.message);
  }

  return items;
}

export async function buildAllPools() {
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
