/**
 * VoiceClone Alerts — D1 store for channels and terms.
 *
 * Tables (infra/schema.d1.sql): vc_channels, vc_terms.
 * All statements are string-prefixed so test stubs can route them,
 * following the documind testhelpers convention.
 */

export interface ChannelRow {
  chat_id: number;
  owner_id: number;
  title: string;
}

/** Register (or re-title) a channel owned by `ownerId`. */
export async function upsertChannel(
  db: D1Database,
  chatId: number,
  ownerId: number,
  title: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO vc_channels (chat_id, owner_id, title, added_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title`,
    )
    .bind(chatId, ownerId, title)
    .run();
}

export async function getChannelByChat(db: D1Database, chatId: number): Promise<ChannelRow | null> {
  return (
    (await db
      .prepare("SELECT chat_id, owner_id, title FROM vc_channels WHERE chat_id = ?")
      .bind(chatId)
      .first<ChannelRow>()) ?? null
  );
}

/** Every channel the user registered — ownership gate for /removechannel. */
export async function listChannelsByOwner(db: D1Database, ownerId: number): Promise<ChannelRow[]> {
  const res = await db
    .prepare("SELECT chat_id, owner_id, title FROM vc_channels WHERE owner_id = ? ORDER BY added_at DESC LIMIT 20")
    .bind(ownerId)
    .all<ChannelRow>();
  return res.results;
}

export async function deleteChannel(db: D1Database, ownerId: number, chatId: number): Promise<boolean> {
  const res = await db
    .prepare("DELETE FROM vc_channels WHERE chat_id = ? AND owner_id = ?")
    .bind(chatId, ownerId)
    .run();
  if ((res.meta.changes ?? 0) === 0) return false;
  // Terms hang off the channel; removing the channel removes its terms.
  await db.prepare("DELETE FROM vc_terms WHERE chat_id = ?").bind(chatId).run();
  return true;
}

export interface TermCount {
  n: number;
}

export async function countTerms(db: D1Database, chatIds: number[]): Promise<number> {
  let total = 0;
  for (const id of chatIds) {
    const row = await db
      .prepare("SELECT COUNT(*) AS n FROM vc_terms WHERE chat_id = ?")
      .bind(id)
      .first<TermCount>();
    total += row?.n ?? 0;
  }
  return total;
}

export async function addTerm(db: D1Database, chatId: number, term: string): Promise<void> {
  await db
    .prepare(
      "INSERT OR IGNORE INTO vc_terms (chat_id, term, created_at) VALUES (?, ?, datetime('now'))",
    )
    .bind(chatId, term)
    .run();
}

export async function removeTerm(db: D1Database, chatId: number, term: string): Promise<boolean> {
  const res = await db
    .prepare("DELETE FROM vc_terms WHERE chat_id = ? AND term = ?")
    .bind(chatId, term)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function listTerms(db: D1Database, chatId: number): Promise<string[]> {
  const res = await db
    .prepare("SELECT term FROM vc_terms WHERE chat_id = ? ORDER BY created_at, rowid LIMIT 50")
    .bind(chatId)
    .all<{ term: string }>();
  return res.results.map((r) => r.term);
}

/**
 * All watch terms in the fleet grouped by channel — one query per cron /
 * post scan, keyed for O(1) lookup during matching.
 */
export async function loadWatchlist(
  db: D1Database,
): Promise<Map<number, string[]>> {
  const res = await db.prepare("SELECT chat_id, term FROM vc_terms ORDER BY created_at, rowid").all<{
    chat_id: number;
    term: string;
  }>();
  const map = new Map<number, string[]>();
  for (const r of res.results) {
    const list = map.get(r.chat_id) ?? [];
    list.push(r.term);
    map.set(r.chat_id, list);
  }
  return map;
}

/**
 * Alert history (Pro feature): snapshot of every fired alert.
 *
 * Recording is best-effort at scan time — a failed history insert must
 * never break alert delivery, so the caller wraps it in try/catch.
 */
export interface AlertRow {
  id: number;
  chat_id: number;
  title: string;
  /** Comma-joined matched terms. */
  terms: string;
  /** Post excerpt snapshot (truncated by the caller). */
  excerpt: string;
  /** 1 = DM delivered, 0 = went to the retry queue. */
  delivered: number;
  created_at: string;
}

export async function recordAlert(
  db: D1Database,
  ownerId: number,
  chatId: number,
  title: string,
  terms: readonly string[],
  excerpt: string,
  delivered: boolean,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO vc_alerts (owner_id, chat_id, title, terms, excerpt, delivered) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(ownerId, chatId, title, terms.join(", "), excerpt, delivered ? 1 : 0)
    .run();
}

export interface HistoryPage {
  rows: AlertRow[];
  total: number;
}

/** Newest-first page of one owner's alert history. */
export async function listAlertHistory(
  db: D1Database,
  ownerId: number,
  limit: number,
  offset: number,
): Promise<HistoryPage> {
  const countRow = await db
    .prepare("SELECT COUNT(*) AS n FROM vc_alerts WHERE owner_id = ?")
    .bind(ownerId)
    .first<{ n: number }>();
  const res = await db
    .prepare(
      "SELECT id, chat_id, title, terms, excerpt, delivered, created_at FROM vc_alerts WHERE owner_id = ? ORDER BY id DESC LIMIT ? OFFSET ?",
    )
    .bind(ownerId, limit, offset)
    .all<AlertRow>();
  return { rows: res.results, total: countRow?.n ?? 0 };
}

/** Wipe one owner's history (/clearhistory). Returns rows removed. */
export async function clearAlertHistory(db: D1Database, ownerId: number): Promise<number> {
  const res = await db
    .prepare("DELETE FROM vc_alerts WHERE owner_id = ?")
    .bind(ownerId)
    .run();
  return res.meta.changes ?? 0;
}

/**
 * Retention cap: keep only the newest `keep` rows of one owner.
 * Called right after each insert so storage stays O(plan) forever.
 */
export async function pruneAlertHistory(db: D1Database, ownerId: number, keep: number): Promise<void> {
  await db
    .prepare(
      "DELETE FROM vc_alerts WHERE owner_id = ? AND id NOT IN (SELECT id FROM vc_alerts WHERE owner_id = ? ORDER BY id DESC LIMIT ?)",
    )
    .bind(ownerId, ownerId, keep)
    .run();
}
