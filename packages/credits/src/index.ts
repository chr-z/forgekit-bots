/**
 * forgekit-credits — D1-backed credits ledger.
 *
 * Money-adjacent state lives ONLY here. Rules:
 * - Balances are derived from an append-only `credit_events` table
 *   (grant / spend), never stored as a single mutable number.
 * - Spends use a conditional UPDATE guarded by the current balance
 *   (compare-and-set) so concurrent requests cannot overspend.
 * - Credits never expire (owner directive).
 */

export type CreditEventKind = "grant" | "spend";

export interface CreditEvent {
  id: number;
  user_id: number;
  kind: CreditEventKind;
  amount: number;
  reason: string;
  created_at: string;
}

export interface Balance {
  balance: number;
}

/** Ensure the user row exists; safe to call on every request (idempotent). */
async function ensureUser(db: D1Database, userId: number): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO users (tg_user_id, created_at) VALUES (?, ?)")
    .bind(userId, new Date().toISOString())
    .run();
}

export async function grantCredits(
  db: D1Database,
  userId: number,
  amount: number,
  reason: string,
): Promise<number> {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new RangeError(`grant amount must be a positive integer, got ${amount}`);
  }
  await ensureUser(db, userId);
  await db
    .prepare(
      "INSERT INTO credit_events (user_id, kind, amount, reason) VALUES (?, 'grant', ?, ?)",
    )
    .bind(userId, amount, reason)
    .run();
  // Keep the cached balance in users in sync with the append-only ledger.
  await db
    .prepare("UPDATE users SET balance = balance + ? WHERE tg_user_id = ?")
    .bind(amount, userId)
    .run();
  const row = await balanceOf(db, userId);
  return row.balance;
}

/**
 * Atomically spend credits. Returns null when funds are insufficient —
 * callers translate that into an "out of credits" upsell message.
 */
export async function spendCredits(
  db: D1Database,
  userId: number,
  amount: number,
  reason: string,
): Promise<number | null> {
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new RangeError(`spend amount must be a positive integer, got ${amount}`);
  }
  await ensureUser(db, userId);
  // Compare-and-set: only debits when balance covers the amount.
  // A missing row would also yield 0 changes -> treated as insufficient funds.
  const res = await db
    .prepare(
      `UPDATE users SET balance = balance - ?
       WHERE tg_user_id = ? AND balance >= ?`,
    )
    .bind(amount, userId, amount)
    .run();
  if ((res.meta.changes ?? 0) === 0) return null;

  await db
    .prepare(
      "INSERT INTO credit_events (user_id, kind, amount, reason) VALUES (?, 'spend', ?, ?)",
    )
    .bind(userId, amount, reason)
    .run();
  const row = await balanceOf(db, userId);
  return row.balance;
}

export async function balanceOf(
  db: D1Database,
  userId: number,
): Promise<Balance> {
  const row = await db
    .prepare("SELECT balance FROM users WHERE tg_user_id = ?")
    .bind(userId)
    .first<{ balance: number }>();
  return { balance: row?.balance ?? 0 };
}
