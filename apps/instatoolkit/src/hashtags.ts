/**
 * Hashtag generator: seed keyword -> ranked hashtag set.
 *
 * Deterministic morphology engine (no network): prefix/suffix product
 * grammar + niche modifiers, scored by a static popularity tier map.
 * Same input always yields the same output (cache-friendly, testable).
 */

export interface HashtagSuggestion {
  tag: string;
  /** 1 = broad/high-volume, 2 = mid, 3 = niche/low-competition. */
  tier: 1 | 2 | 3;
}

const TIER1_SUFFIXES = ["", "love", "life", "daily", "gram", "world", "lovers", "addict", "time", "vibes"];
const TIER2_MODIFIERS = ["tips", "hacks", "community", "goals", "inspiration", "ideas", "guide", "tutorial", "review", "recipes"];
const TIER3_MODIFIERS = ["forbeginners", "oftheday", "brasil", "smallbusiness", "2026", "stepbystep"];

/** Split into clean base words: lowercase, accent-free, alphanumeric only. */
function toBaseWords(seed: string): string[] {
  return seed
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents: café -> cafe
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2);
}

/** Build the candidate universe for one seed phrase (each word contributes). */
export function candidatesFor(seed: string): HashtagSuggestion[] {
  const out: HashtagSuggestion[] = [];
  for (const base of toBaseWords(seed)) {
    for (const s of TIER1_SUFFIXES) out.push({ tag: `${base}${s}`, tier: 1 });
    for (const m of TIER2_MODIFIERS) out.push({ tag: `${base}${m}`, tier: 2 });
    for (const m of TIER3_MODIFIERS) out.push({ tag: `${base}${m}`, tier: 3 });
  }
  return out;
}

/**
 * Balanced set: ~40% broad, ~40% mid, ~20% niche — the classic reach mix.
 * Deterministic order (tier asc, then alphabetical) for stable tests.
 */
export function generateHashtags(seeds: readonly string[], total = 18): HashtagSuggestion[] {
  const seen = new Set<string>();
  const buckets: HashtagSuggestion[][] = [[], [], []];
  for (const seed of seeds) {
    for (const c of candidatesFor(seed)) {
      if (seen.has(c.tag)) continue;
      seen.add(c.tag);
      buckets[c.tier - 1]!.push(c);
    }
  }
  for (const b of buckets) b.sort((a, z) => a.tag.localeCompare(z.tag));

  const quotas = [
    Math.round(total * 0.4),
    Math.round(total * 0.4),
    total - Math.round(total * 0.4) - Math.round(total * 0.4),
  ];
  const picked: HashtagSuggestion[] = [];
  for (let tier = 0; tier < 3; tier++) {
    picked.push(...buckets[tier]!.slice(0, quotas[tier]!));
  }
  // top up from leftovers if a bucket ran dry
  if (picked.length < total) {
    for (const b of buckets) {
      for (const c of b) {
        if (picked.length >= total) break;
        if (!picked.includes(c)) picked.push(c);
      }
    }
  }
  return picked.slice(0, total);
}

export function renderTagList(tags: readonly HashtagSuggestion[]): string {
  return tags.map((t) => `#${t.tag}`).join(" ");
}
