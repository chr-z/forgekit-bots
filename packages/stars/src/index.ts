/**
 * forgekit-stars — Telegram Stars payment handling.
 *
 * Flow:
 *   user pays with Stars -> Bot API sends a `pre_checkout_query` ->
 *   we must answer `ok: true` within 10s or the payment is aborted ->
 *   Bot API sends the final `message.successful_payment` -> we credit.
 *
 * Idempotency: Telegram Charges use unique `telegram_payment_charge_id`s.
 * We record them in `star_payments` (PK) and skip duplicates, so webhook
 * retries never double-credit. The payload string on the invoice carries
 * our own product id (`pack:r10`, `sub:clipgrab-pro`, ...) which maps to
 * a credit grant or a Pro flag in `subscriptions`.
 */

export interface StarProduct {
  /** payload string embedded in the invoice. */
  productId: string;
  title: string;
  description: string;
  priceInStars: number;
  /** XTR currency amounts are integers (Stars). */
  kind: "credits" | "subscription";
  creditsAmount?: number;
  /** For subscriptions: days of Pro access granted per purchase. */
  proDays?: number;
}

export interface SuccessfulPayment {
  currency: string; // "XTR" for Stars
  total_amount: number;
  invoice_payload: string;
  telegram_payment_charge_id: string;
  from: { id: number };
}

/** Build an inline invoice link payload for sendInvoice. */
export function makeInvoicePayload(productId: string): string {
  return productId;
}

/**
 * Decide whether to approve a pre-checkout query. We accept everything that
 * maps to a known product; real stock is unlimited so there is nothing else
 * to check. Returns `{ ok: true }` or `{ ok: false, errorMessage }`.
 */
export function reviewPreCheckout(
  query: { invoice_payload?: string },
  catalog: readonly StarProduct[],
): { ok: boolean; errorMessage?: string } {
  const product = catalog.find((p) => p.productId === query.invoice_payload);
  if (!product) {
    return { ok: false, errorMessage: "Unknown product. Please /start again." };
  }
  return { ok: true };
}

export type FulfillmentResult =
  | { status: "credited"; balance: number }
  | { status: "pro_until"; proUntil: string }
  | { status: "duplicate" }
  | { status: "unknown_product" };

const iso = () => new Date().toISOString();

/**
 * Fulfill a successful payment against D1. Idempotent by charge id.
 * Assumes schema from infra/schema.d1.sql (users, credit_events,
 * star_payments, subscriptions).
 */
export async function fulfillSuccessfulPayment(
  db: D1Database,
  payment: SuccessfulPayment,
  catalog: readonly StarProduct[],
): Promise<FulfillmentResult> {
  if (payment.currency !== "XTR") {
    return { status: "unknown_product" };
  }

  // Insert-first idempotency gate: only one webhook wins the PK.
  const inserted = await db
    .prepare(
      `INSERT OR IGNORE INTO star_payments
         (charge_id, tg_user_id, product_id, stars_amount, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(
      payment.telegram_payment_charge_id,
      payment.from.id,
      payment.invoice_payload,
      payment.total_amount,
      iso(),
    )
    .run();
  if ((inserted.meta.changes ?? 0) === 0) {
    return { status: "duplicate" };
  }

  const product = catalog.find((p) => p.productId === payment.invoice_payload);
  if (!product) return { status: "unknown_product" };

  await db
    .prepare("INSERT OR IGNORE INTO users (tg_user_id, created_at) VALUES (?, ?)")
    .bind(payment.from.id, iso())
    .run();

  if (product.kind === "credits") {
    const amount = product.creditsAmount ?? 0;
    await db
      .prepare(
        "INSERT INTO credit_events (user_id, kind, amount, reason) VALUES (?, 'grant', ?, ?)",
      )
      .bind(payment.from.id, amount, `stars:${product.productId}:${payment.telegram_payment_charge_id}`)
      .run();
    await db
      .prepare("UPDATE users SET balance = balance + ? WHERE tg_user_id = ?")
      .bind(amount, payment.from.id)
      .run();
    return { status: "credited", balance: -1 }; // caller re-reads balance if needed
  }

  // subscription: extend from max(now, current expiry) — stacking purchases
  const row = await db
    .prepare("SELECT pro_until FROM subscriptions WHERE tg_user_id = ?")
    .bind(payment.from.id)
    .first<{ pro_until: string }>();
  const base =
    row?.pro_until && new Date(row.pro_until).getTime() > Date.now()
      ? new Date(row.pro_until).getTime()
      : Date.now();
  const proUntil = new Date(base + (product.proDays ?? 30) * 86400_000).toISOString();
  await db
    .prepare(
      `INSERT INTO subscriptions (tg_user_id, pro_until, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(tg_user_id) DO UPDATE SET pro_until = excluded.pro_until, updated_at = excluded.updated_at`,
    )
    .bind(payment.from.id, proUntil, iso())
    .run();
  return { status: "pro_until", proUntil };
}
