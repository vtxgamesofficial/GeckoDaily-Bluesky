import { config, assertCloudflareCreds } from "./config.js";
import { logger } from "./logger.js";

/**
 * Calls Cloudflare Workers AI, the same way GeckoDaily's own site search
 * route does (each site's api/search route) — same account, same model
 * by default, so the bot's "voice" comes from the same AI the site
 * already trusts to write/verify its facts.
 */
export async function runCloudflareAI(messages, { maxTokens = 300, temperature = 0.8 } = {}) {
  assertCloudflareCreds();
  const { accountId, apiToken, model } = config.cloudflare;

  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messages, max_tokens: maxTokens, temperature }),
    }
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Cloudflare AI error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const text = (data?.result?.response ?? data?.response ?? "").toString().trim();
  if (!text) {
    logger.warn("Cloudflare AI returned empty response", JSON.stringify(data).slice(0, 300));
  }
  return text;
}
