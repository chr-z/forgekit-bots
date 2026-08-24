import { beforeEach, describe, expect, it } from "vitest";
import { fulfillSuccessfulPayment, makeInvoicePayload, reviewPreCheckout, type StarProduct } from "./index";

const CATALOG: StarProduct[] = [
  { productId: "pack:r10", title: "300 credits", description: "300 transcription credits", priceInStars: 250, kind: "credits", creditsAmount: 300 },
  { productId: "sub:clipgrab-pro", title: "ClipGrab Pro", description: "30 days of Pro", priceInStars: 500, kind: "subscription", proDays: 30 },
];

interface Row {
  tg_user_id: number;
  balance: number;
}
interface SubRow {
  tg_user_id: number;
  pro_until: string;
}

/** In-memory D1 covering the SQL surface used by fulfillSuccessfulPayment. */
function makeD1() {
  const users = new Map<number, Row>();
  const subs = new Map<number, SubRow>();
  const payments = new Map<string, { stars: number; product: string }>();
  const events: Array<{ user_id: number; kind: string; amount: number; reason: string }> = [];

  function prepare(sql: string) {
    let args: unknown[] = [];
    const api = {
      bind: (...a: unknown[]) => {
        args = a;
        return api;
      },
      run: async () => {
        if (sql.startsWith("INSERT OR IGNORE INTO star_payments")) {
          const [charge, userId, product, stars] = args as [string, number, string, number];
          if (payments.has(charge)) return { meta: { changes: 0 } };
          payments.set(charge, { stars, product });
          void userId;
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("INSERT OR IGNORE INTO users")) {
          const [id] = args as [number];
          if (!users.has(id)) users.set(id, { tg_user_id: id, balance: 0 });
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("INSERT INTO credit_events")) {
          const [userId, amount, reason] = args as [number, number, string];
          events.push({ user_id: userId, kind: "grant", amount, reason });
          return { meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE users SET balance = balance + ?")) {
          const [amount, userId] = args as [number, number];
          const row = users.get(userId);
          if (!row) return { meta: { changes: 0 } };
          row.balance += amount;
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("INSERT INTO subscriptions")) {
          const [id, proUntil] = args as [number, string];
          subs.set(id, { tg_user_id: id, pro_until: proUntil });
          return { meta: { changes: 1 } };
        }
        throw new Error(`unexpected run sql: ${sql}`);
      },
      first: async <T>(): Promise<T | null> => {
        if (sql.startsWith("SELECT balance FROM users")) {
          const row = users.get(args[0] as number);
          return (row ? { balance: row.balance } : null) as T | null;
        }
        if (sql.startsWith("SELECT pro_until FROM subscriptions")) {
          const row = subs.get(args[0] as number);
          return (row ? { pro_until: row.pro_until } : null) as T | null;
        }
        throw new Error(`unexpected first sql: ${sql}`);
      },
    };
    return api;
  }

  return {
    db: { prepare } as unknown as D1Database,
    users,
    subs,
    payments,
    events,
  };
}

function payment(over: Partial<Parameters<typeof fulfillSuccessfulPayment>[1]> = {}) {
  return {
    currency: "XTR",
    total_amount: 250,
    invoice_payload: "pack:r10",
    telegram_payment_charge_id: "chg_001",
    from: { id: 42 },
    ...over,
  };
}

let d1: ReturnType<typeof makeD1>;
beforeEach(() => {
  d1 = makeD1();
});

describe("reviewPreCheckout", () => {
  it("approves known products and rejects unknown payloads", () => {
    expect(reviewPreCheckout({ invoice_payload: "pack:r10" }, CATALOG).ok).toBe(true);
    const bad = reviewPreCheckout({ invoice_payload: "nope" }, CATALOG);
    expect(bad.ok).toBe(false);
    expect(bad.errorMessage).toContain("Unknown");
    expect(reviewPreCheckout({}, CATALOG).ok).toBe(false);
  });

  it("makeInvoicePayload echoes the product id", () => {
    expect(makeInvoicePayload("sub:clipgrab-pro")).toBe("sub:clipgrab-pro");
  });
});

describe("fulfillSuccessfulPayment", () => {
  it("credits a credit-pack purchase exactly once", async () => {
    const r1 = await fulfillSuccessfulPayment(d1.db, payment(), CATALOG);
    expect(r1.status).toBe("credited");

    // webhook retry with the SAME charge id must not double-credit
    const r2 = await fulfillSuccessfulPayment(d1.db, payment(), CATALOG);
    expect(r2.status).toBe("duplicate");
    expect(d1.events).toHaveLength(1);
    expect(d1.users.get(42)?.balance).toBe(300);
  });

  it("grants a subscription and stacks extensions from the later expiry", async () => {
    const now = Date.now();
    const r1 = await fulfillSuccessfulPayment(d1.db, payment({
      invoice_payload: "sub:clipgrab-pro",
      total_amount: 500,
      telegram_payment_charge_id: "chg_a",
    }), CATALOG);
    expect(r1.status).toBe("pro_until");
    const until1 = new Date((r1 as { proUntil: string }).proUntil).getTime();
    expect(until1 - now).toBeGreaterThan(29 * 86400_000);

    // second purchase stacks on top of the remaining time
    await new Promise((r) => setTimeout(r, 5));
    const r2 = await fulfillSuccessfulPayment(d1.db, payment({
      invoice_payload: "sub:clipgrab-pro",
      total_amount: 500,
      telegram_payment_charge_id: "chg_b",
    }), CATALOG);
    const until2 = new Date((r2 as { proUntil: string }).proUntil).getTime();
    expect(until2 - until1).toBeGreaterThanOrEqual(29 * 86400_000);
  });

  it("rejects non-Star currencies and unknown products after recording the payment", async () => {
    expect((await fulfillSuccessfulPayment(d1.db, payment({ currency: "USD" }), CATALOG)).status).toBe("unknown_product");
    expect((await fulfillSuccessfulPayment(d1.db, payment({ invoice_payload: "ghost" }), CATALOG)).status).toBe("unknown_product");
  });
});
