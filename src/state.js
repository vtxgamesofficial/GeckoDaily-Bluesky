import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, "..", "data", "state.json");

const DEFAULT_STATE = {
  postedIds: [], // item ids already posted, oldest first
  recentTexts: [], // last N final post texts, for near-duplicate checks
  speciesCursor: 0, // round-robin pointer into SPECIES
  typeCursor: 0, // round-robin pointer into content types
  likedUris: [], // uris already liked by the engagement module
  lastRunAt: null,
};

const MAX_POSTED_IDS = 500;
const MAX_RECENT_TEXTS = 30;
const MAX_LIKED_URIS = 500;

export async function loadState() {
  try {
    const raw = await readFile(STATE_PATH, "utf-8");
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch (err) {
    if (err.code !== "ENOENT") logger.warn("Could not read state.json, starting fresh:", err.message);
    return { ...DEFAULT_STATE };
  }
}

export async function saveState(state) {
  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf-8");
}

export function markPosted(state, itemId, text) {
  state.postedIds.push(itemId);
  if (state.postedIds.length > MAX_POSTED_IDS) {
    state.postedIds = state.postedIds.slice(-MAX_POSTED_IDS);
  }
  state.recentTexts.push(normalize(text));
  if (state.recentTexts.length > MAX_RECENT_TEXTS) {
    state.recentTexts = state.recentTexts.slice(-MAX_RECENT_TEXTS);
  }
  state.lastRunAt = new Date().toISOString();
}

export function markLiked(state, uri) {
  state.likedUris.push(uri);
  if (state.likedUris.length > MAX_LIKED_URIS) {
    state.likedUris = state.likedUris.slice(-MAX_LIKED_URIS);
  }
}

function normalize(text) {
  return text.toLowerCase().replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
}

// Cheap near-duplicate check: normalized text overlap against recent posts.
export function isNearDuplicate(state, text) {
  const n = normalize(text);
  return state.recentTexts.some((prev) => {
    if (prev === n) return true;
    const shorter = Math.min(prev.length, n.length);
    if (shorter < 20) return prev === n;
    // Simple shared-prefix/substring heuristic — good enough to catch the
    // AI repeating itself without pulling in a full string-diff library.
    return prev.includes(n.slice(0, 40)) || n.includes(prev.slice(0, 40));
  });
}
