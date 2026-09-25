import "dotenv/config";

function required(name, fallback) {
  const v = process.env[name] ?? fallback;
  return v;
}

export const config = {
  bluesky: {
    identifier: required("BLUESKY_IDENTIFIER"),
    appPassword: required("BLUESKY_APP_PASSWORD"),
    service: required("BLUESKY_SERVICE", "https://bsky.social"),
  },
  cloudflare: {
    accountId: required("CLOUDFLARE_ACCOUNT_ID"),
    apiToken: required("CLOUDFLARE_API_TOKEN"),
    model: required("CLOUDFLARE_AI_MODEL", "@cf/meta/llama-3.1-8b-instruct"),
  },
  site: {
    baseUrl: required("SITE_BASE_URL", "https://geckodaily.vercel.app"),
  },
  schedule: {
    postCron: required("POST_CRON", "0 9,14,19 * * *"),
    engageCron: required("ENGAGE_CRON", "0 */3 * * *"),
    tz: required("TZ", "Etc/UTC"),
  },
  engagement: {
    enabled: /^true$/i.test(required("ENGAGE_ENABLED", "false")),
    maxLikes: parseInt(required("ENGAGE_MAX_LIKES", "5"), 10),
  },
  logLevel: required("LOG_LEVEL", "info"),
};

// Mirrors lib/sites.ts in the GeckoDaily-Website repo.
// If you add a new table to the site, add it here too — everything
// downstream (content pool, rotation, posting) picks it up automatically.
export const SPECIES = [
  {
    slug: "leotable",
    name: "The Leo Table",
    common: "Leopard Gecko",
    sciName: "Eublepharis macularius",
  },
  {
    slug: "crestytable",
    name: "The Cresty Table",
    common: "Crested Gecko",
    sciName: "Correlophus ciliatus",
  },
  {
    slug: "mourningtable",
    name: "The Mourning Table",
    common: "Mourning Gecko",
    sciName: "Lepidodactylus lugubris",
  },
  {
    slug: "fattailtable",
    name: "The Fat Tail Table",
    common: "African Fat-Tailed Gecko",
    sciName: "Hemitheconyx caudicinctus",
  },
  {
    slug: "gargoyletable",
    name: "The Gargoyle Table",
    common: "Gargoyle Gecko",
    sciName: "Rhacodactylus auriculatus",
  },
  {
    slug: "beardietable",
    name: "The Beardie Table",
    common: "Bearded Dragon",
    sciName: "Pogona vitticeps",
    // Not technically a gecko — flagged so post copy can avoid calling it one.
    isGecko: false,
  },
].map((s) => ({ isGecko: true, ...s }));

export function assertBlueskyCreds() {
  if (!config.bluesky.identifier || !config.bluesky.appPassword) {
    throw new Error(
      "Missing BLUESKY_IDENTIFIER / BLUESKY_APP_PASSWORD. Copy .env.example to .env and fill them in."
    );
  }
}

export function assertCloudflareCreds() {
  if (!config.cloudflare.accountId || !config.cloudflare.apiToken) {
    throw new Error(
      "Missing CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN. Copy .env.example to .env and fill them in."
    );
  }
}
