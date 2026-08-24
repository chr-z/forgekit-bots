/**
 * Resolver contract for ClipGrab.
 *
 * Every platform lives in its own module and speaks only this interface,
 * so a broken platform never leaks breakage into the others. Resolvers
 * MUST NOT require credentials and MUST NOT proxy media bytes — they
 * return a direct URL the user opens themselves.
 */

export type ResolveResult =
  | {
      kind: "ok";
      platform: Platform;
      /** Direct media URL (expires — say so in the reply). */
      directUrl: string;
      watermarkFree: boolean;
      /** Which strategy won, for logs/metrics. */
      via: string;
      /** Canonical source page, for attribution in the reply. */
      sourceUrl: string;
    }
  | {
      kind: "unsupported";
      platform: Platform | null;
      reason: string;
    }
  | {
      kind: "failed";
      platform: Platform;
      /** User-safe message key; details go to logs only. */
      reason: string;
    };

export type Platform = "tiktok" | "instagram" | "youtube";

export interface Resolver {
  platform: Platform;
  /** Does this resolver claim this URL? */
  matches(url: URL): boolean;
  /** Expand short/share links to the canonical form (best effort). */
  canonicalize(url: URL): Promise<URL>;
  /** Produce the direct download URL or a typed failure. */
  resolve(url: URL): Promise<ResolveResult>;
}

/** Hostnames each resolver claims (checked against url.hostname). */
export function hostEndsWith(hostname: string, suffixes: readonly string[]): boolean {
  const h = hostname.toLowerCase();
  return suffixes.some((s) => h === s || h.endsWith(`.${s}`));
}
