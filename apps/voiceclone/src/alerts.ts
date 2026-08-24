/**
 * VoiceClone Alerts — alert delivery + retry queue on KV.
 *
 * Delivery is fire-then-record: if sendMessage fails (Telegram hiccup,
 * bot kicked, network), the alert lands in a KV retry list and the cron
 * trigger re-sends later. This replaces the "poll via getUpdates" design:
 * once setWebhook is registered, getUpdates returns 409 Conflict — so the
 * webhook IS the ingestion path for channel posts, and the cron only
 * drains this queue. Free tier: 1k reads + 1k writes/day cover a small
 * fleet of channels comfortably.
 */

export interface PendingAlert {
  /** Destination chat id (the subscriber's DM). */
  toChatId: number;
  /** Rendered message body. */
  text: string;
  /** Enqueued at epoch ms; entries older than ALERT_TTL_MS are dropped. */
  enqueuedAt: number;
}

const QUEUE_KEY = "vc:alert-retry";
/** Give up after 24h — the post is old news by then. */
export const ALERT_TTL_MS = 24 * 3600_000;
/** Cron drain budget: stay far inside Workers free CPU/req limits. */
export const MAX_DRAIN_PER_TICK = 20;

export function makeAlert(toChatId: number, text: string, now = Date.now()): PendingAlert {
  return { toChatId, text, enqueuedAt: now };
}

export async function enqueueAlert(kv: KVNamespace, alert: PendingAlert): Promise<void> {
  const list = (await kv.get<PendingAlert[]>(QUEUE_KEY, "json")) ?? [];
  list.push(alert);
  await kv.put(QUEUE_KEY, JSON.stringify(list));
}

/**
 * Pop up to `max` non-expired alerts. Expired ones are silently discarded
 * (stale alerts are worse than none). Returns [] when the queue is empty.
 */
export async function takeAlerts(kv: KVNamespace, max = MAX_DRAIN_PER_TICK): Promise<PendingAlert[]> {
  const list = (await kv.get<PendingAlert[]>(QUEUE_KEY, "json")) ?? [];
  const now = Date.now();
  const fresh = list.filter((a) => now - a.enqueuedAt < ALERT_TTL_MS);
  const batch = fresh.slice(0, max);
  const rest = fresh.slice(max);
  await kv.put(QUEUE_KEY, JSON.stringify(rest));
  return batch;
}

export function renderAlert(channelTitle: string, terms: string[], excerpt: string): string {
  const clean = excerpt.length > 280 ? `${excerpt.slice(0, 277)}…` : excerpt;
  return [
    `🔔 ${terms.map((t) => `"${t}"`).join(", ")} — ${channelTitle}`,
    "",
    clean,
  ].join("\n");
}
