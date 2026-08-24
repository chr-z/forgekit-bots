/**
 * forgekit-ratelimit — fixed-window rate limiter on Workers KV.
 *
 * Design notes:
 * - One KV key per (bot, subject, window). Value = usage count.
 * - Fixed windows are good enough for freemium quotas and cost ~1 KV op.
 * - Pro users skip the anonymous limit entirely (they have credits instead).
 * - `consume` is best-effort atomic: concurrent requests may both read the
 *   same count. That is acceptable for quota UX, not for billing — billing
 *   goes through the D1 ledger in @forgekit/credits.
 */

export interface RateLimitConfig {
  /** Maximum uses per window for free/anonymous users. */
  freeLimit: number;
  /** Window length in seconds (default 86400 = daily). */
  windowSeconds?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  used: number;
  limit: number;
  /** Seconds until the current window resets (for "try again in Xh"). */
  resetAfter: number;
}

interface WindowState {
  window: number;
  used: number;
}

function nowWindow(windowSeconds: number): number {
  return Math.floor(Date.now() / 1000 / windowSeconds);
}

export class RateLimiter {
  constructor(
    private readonly kv: KVNamespace,
    private readonly config: RateLimitConfig,
  ) {}

  private key(bot: string, subject: string): string {
    const ws = this.config.windowSeconds ?? 86400;
    return `rl:${bot}:${subject}:${nowWindow(ws)}`;
  }

  /**
   * Count one use against `subject` unless they are exempt.
   * `exempt=true` means a paying user (Pro) or an admin — always allowed.
   */
  async consume(
    bot: string,
    subject: string,
    exempt: boolean,
  ): Promise<RateLimitResult> {
    const ws = this.config.windowSeconds ?? 86400;
    if (exempt) {
      return { allowed: true, used: 0, limit: Infinity, resetAfter: 0 };
    }

    const key = this.key(bot, subject);
    const existing = await this.kv.get<WindowState>(key, "json");
    const cur = existing ?? { window: nowWindow(ws), used: 0 };
    const used = cur.used + 1;
    await this.kv.put(key, JSON.stringify({ window: nowWindow(ws), used }), {
      expirationTtl: ws + 60,
    });

    return {
      allowed: used <= this.config.freeLimit,
      used,
      limit: this.config.freeLimit,
      // Time until the next window boundary starts.
      resetAfter:
        ws - Math.floor((Date.now() / 1000) % ws),
    };
  }
}
