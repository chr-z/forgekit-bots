/**
 * summarizetube/cache — replay cache for identical video summaries.
 *
 * Re-summarizing the SAME video re-runs the whole map-reduce AI pipeline
 * and pays Workers AI neurons again for a byte-identical reply. This module
 * caches the finished payload (reply + doc + transcript) per videoId in KV
 * for 7 days, so a replay costs one KV read instead of N AI calls — direct
 * protection for owner directive #1 ("free tier must fit the infra free
 * tier"). Entries are SHARED across users (payload is public video info)
 * and a hit consumes neither the daily free window nor a credit pack.
 */

import type { SummaryDoc } from "./index";
import type { TranscriptDoc } from "./transcript";

/** Bump when the reply format changes materially: old entries stop being served. */
const CACHE_VERSION = 1;

export interface CachedSummary {
  v: number;
  /** Effective deep flag the pipeline actually rendered with. */
  deep: boolean;
  reply: string;
  doc: SummaryDoc;
  transcript: TranscriptDoc;
}

export function summaryCacheKey(videoId: string): string {
  return `summarizetube:cache:${videoId}`;
}

export async function saveCachedSummary(
  kv: KVNamespace,
  videoId: string,
  payload: { deep: boolean; reply: string; doc: SummaryDoc; transcript: TranscriptDoc },
): Promise<void> {
  const entry: CachedSummary = { v: CACHE_VERSION, ...payload };
  await kv.put(summaryCacheKey(videoId), JSON.stringify(entry), {
    expirationTtl: 7 * 86400,
  });
}

/**
 * Returns null on miss, corruption or version mismatch — callers simply
 * re-run the pipeline, exactly as if the cache did not exist.
 */
export async function loadCachedSummary(
  kv: KVNamespace,
  videoId: string,
): Promise<CachedSummary | null> {
  let raw: string | null;
  try {
    raw = await kv.get(summaryCacheKey(videoId));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CachedSummary;
    if (parsed?.v !== CACHE_VERSION) return null;
    if (typeof parsed.reply !== "string" || !parsed.reply) return null;
    if (typeof parsed.deep !== "boolean") return null;
    if (!parsed.doc || !Array.isArray(parsed.doc.bullets)) return null;
    if (!parsed.transcript || typeof parsed.transcript.text !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}
