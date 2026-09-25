# GeckoDaily Bluesky Bot

A Bluesky bot for **GeckoDaily** (geckodaily.vercel.app) that posts AI-rewritten
gecko/reptile facts, care tips, feeder and plant call-outs, all pulled **live**
from GeckoDaily's own public plugin API — the same JSON endpoints
(`/api/plugin/facts`, `/care`, `/plants`, `/feeders`, `/site`) that already
exist on all six tables (leo, cresty, mourning, fat-tail, gargoyle, beardie)
for AI-plugin/MCP consumption. The bot never has stale, hardcoded content —
if you update a fact on the site, the bot picks up the new version automatically.

Every post is written by **Cloudflare Workers AI** (same account/model your
site's own search bar already uses), rewritten in fresh wording rather than
copy-pasted, and passes through a second AI validation pass plus plain
heuristic checks before anything gets published — see [How posts are
generated & checked](#how-posts-are-generated--checked).

Pure Node.js, no other language/runtime involved.

## What it does

- **Posts gecko facts/care tips/morphs/feeders/plants**, rotating round-robin
  across all 6 GeckoDaily tables so no one species dominates the feed.
- **Rewrites each fact** via Cloudflare AI instead of posting the raw sentence
  verbatim (better for readers, avoids duplicate-content-style repetition).
- **Validates every draft** with a second AI pass + heuristics before posting
  — rejects anything that contradicts the source, invents facts, is
  incoherent, or (for Beardie Table content) mistakenly calls a bearded
  dragon a gecko.
- **Links back to the exact page** the fact came from (not just the
  homepage), tagged with `utm_source=bluesky` — which your site's
  `middleware.ts` already redirects to that table's `/welcome` page, so
  clicks land somewhere built for new visitors, and you can see bot-driven
  traffic clearly in analytics.
- **Never repeats itself** — keeps a log of posted item IDs and recent post
  text, and skips near-duplicates.
- Optional **safe engagement pass**: likes (never auto-replies or
  auto-follows — see [why](#why-no-auto-reply--auto-follow)) a small, capped
  number of on-topic posts from other people already talking about these
  species, off by default.

## Setup

### 1. Create the Bluesky account + app password

1. Make (or log into) the Bluesky account you want the bot to post as.
2. Go to **Settings → App Passwords** → create one. Use that, never your
   real account password.

### 2. Get your Cloudflare Workers AI credentials

You already have these if GeckoDaily's site search works — they're the same
`CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` from the site's
`.env.local`. The token needs the **Workers AI** permission.

### 3. Configure

```bash
npm install
cp .env.example .env
# fill in BLUESKY_IDENTIFIER, BLUESKY_APP_PASSWORD,
# CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN
```

### 4. Try it (dry run — composes and validates a post but does NOT publish it)

```bash
npm run post:dry
```

You should see a fully composed post printed to the console. Once that looks
right:

```bash
npm run post
```

## Deploying so it posts on a schedule

Two options — pick one:

### Option A: GitHub Actions (recommended — free, no server to manage)

A workflow is already included at `.github/workflows/post.yml`. It runs
**once a day** (09:00 UTC by default) and posts a whole day's batch of
**450 posts back-to-back**, ~5 seconds apart, reusing one fetch of the
content pool for the whole batch (instead of re-fetching it 450 times).
The count (`450`) and the gap between posts (`5` seconds) are hardcoded as
`DAILY_POST_COUNT` / `DAILY_INTERVAL_SEC` at the top of `index.js` — edit
those two numbers directly if you want a different pace; no extra GitHub
secret is needed for them.

⚠️ **450 posts/day is extremely high volume** (about one every 3 minutes,
24/7) and is well outside what this bot was originally designed for — see
[Why no auto-reply / auto-follow](#why-no-auto-reply--auto-follow) above
for the spam-pattern reasoning that originally kept volume low. At this
pace, expect: Bluesky's spam/abuse detection may rate-limit, label, or
suspend the account regardless of content quality; your Cloudflare
Workers AI usage will be ~900 calls/day (2 per post) which may exceed a
free-tier daily quota; and the live content pool per species is finite,
so many posts each day will necessarily repeat facts already used earlier
that day.

1. Push this folder to its own GitHub repo.
2. Repo **Settings → Secrets and variables → Actions**, add:
   `BLUESKY_IDENTIFIER`, `BLUESKY_APP_PASSWORD`, `CLOUDFLARE_ACCOUNT_ID`,
   `CLOUDFLARE_API_TOKEN`.
3. Repo **Settings → Actions → General → Workflow permissions** → set to
   "Read and write permissions" (the workflow commits `data/state.json`
   back to the repo after each run so the bot remembers what it already
   posted — Actions runners are wiped between runs otherwise).
4. That's it. Trigger it once manually from the **Actions** tab
   ("Run workflow") to confirm it works — this will post the full 450-item
   batch, so make sure that's what you want before clicking it — or just
   wait for the schedule.
5. Edit the `cron:` line in the workflow file to change what time the
   daily batch starts, and `DAILY_POST_COUNT` / `DAILY_INTERVAL_SEC` at
   the top of `index.js` to change how many posts and how fast.

### Option B: A long-running Node process (VPS, Railway, Render, etc.)

```bash
npm run schedule
```

Runs forever, posting on `POST_CRON` (from `.env`) and, if
`ENGAGE_ENABLED=true`, liking on-topic posts on `ENGAGE_CRON`. Use `pm2`,
`systemd`, or your host's process manager to keep it alive and restart it
on crash/reboot. In this mode `data/state.json` just lives on disk — no
git commits needed.

## How posts are generated & checked

For each run:

1. **Pick an item.** Content is pulled fresh from all 6 species' plugin
   APIs (facts, morphs, care guides, safe/unsafe plants, feeder tiers, and
   site sections). An item not posted recently is chosen, rotating species
   and content type.
2. **Write.** Cloudflare Workers AI rewrites the source fact into a short,
   conversational post — instructed to use *only* the given fact, invent
   nothing, and stay under ~220 characters.
3. **Check with heuristics.** Length, word count, alphabetic-character
   ratio, no `undefined`/`null` leakage, and (for the Beardie Table) no
   calling a dragon a gecko.
4. **Check with a second AI pass.** A separate prompt asks the model to
   compare the draft against the original source fact and answer strictly
   `PASS` or `FAIL` — catching contradictions, invented specifics, or
   incoherent output the first pass might have produced.
5. **Only if both checks pass** does the post get assembled (short link
   anchor + full tracking URL as a proper AT Protocol link facet, plus 1–2
   relevant hashtags) and published. If a draft fails, the bot retries up
   to a few times, then moves on to a different content item rather than
   posting something bad — the run only comes up empty if nothing at all
   validates, which should be rare.

## One thing worth doing yourself: add the bot to `lib/social.ts`

Once the bot's Bluesky profile exists, add its URL to the `socialLinks`
array in the main GeckoDaily repo (`lib/social.ts`):

```ts
export const socialLinks: string[] = [
  "https://bsky.app/profile/geckodaily.bsky.social",
];
```

That file already feeds the `sameAs` field on your site's Organization
JSON-LD — this is a direct, low-effort signal to Google that the Bluesky
account and geckodaily.vercel.app are the same entity, which is exactly
what that field exists for.

## Configuration reference (`.env`)

| Variable | Default | Notes |
|---|---|---|
| `BLUESKY_IDENTIFIER` | — | handle or DID |
| `BLUESKY_APP_PASSWORD` | — | app password, not your real password |
| `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` | — | Workers AI creds |
| `CLOUDFLARE_AI_MODEL` | `@cf/meta/llama-3.1-8b-instruct` | same model the site uses |
| `SITE_BASE_URL` | `https://geckodaily.vercel.app` | change if you move domains |
| `POST_CRON` | `0 9,14,19 * * *` | only used by `npm run schedule` |
| `ENGAGE_ENABLED` | `false` | turn on the safe-liking pass |
| `ENGAGE_MAX_LIKES` | `5` | hard cap per engagement run |

## Why no auto-reply / auto-follow?

Deliberately left out. Unsolicited replies with a link, or mass-following
strangers, is exactly the pattern that gets bot accounts reported/muted as
spam — it would actively work against gaining GeckoDaily genuine users, not
help. Liking a post someone already wrote about their gecko is low-friction
and puts your handle in front of an interested person without inserting
yourself into their conversation. If you want more outreach later, the
better lever is genuinely useful reply content from *you*, posted manually,
not automated replies at scale.

## Extending it

- Add a new table to the site → add one entry to `SPECIES` in `src/config.js`
  → the bot picks it up everywhere (content pool, rotation, hashtags)
  automatically, same as `lib/sites.ts` does on the website itself.
- Want different post styles? Edit the system prompt in
  `src/composer.js` (`buildWriterMessages`).
- Want to post images? GeckoDaily's data doesn't currently expose image
  URLs through the plugin API, so this bot is text-only. If you add image
  URLs to the API responses later, `@atproto/api`'s `agent.uploadBlob` +
  an `embed` on the post record is the way to add them.
