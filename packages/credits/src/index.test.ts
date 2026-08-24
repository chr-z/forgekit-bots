import { beforeEach, describe, expect, it } from "vitest";
import { balanceOf, grantCredits, spendCredits } from "./index";

interface Row {
  tg_user_id: number;
  balance: number;
  created_at?: string;
}

/** In-memory D1 stub implementing exactly the surface this package uses. */
function makeD1() {
  const users = new Map<number, Row>();
  const events: Array<{ user_id: number; kind: string; amount: number; reason: string }> = [];

  const stmt = {
    first: async <T>(): Promise<T | null> => {
      // balanceOf is the only first() caller; binds userId via closure below
      throw new Error("first() must be bound");
    },
  };

  function prepare(sql: string) {
    let args: unknown[] = [];
    const api = {
      bind: (...a: unknown[]) => {
        args = a;
        return api;
      },
      run: async () => {
        if (sql.startsWith("INSERT OR IGNORE INTO users")) {
          const [id, createdAt] = args as [number, string];
          if (!users.has(id)) users.set(id, { tg_user_id: id, balance: 0, created_at: createdAt });
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("INSERT INTO credit_events")) {
          const [userId, amount, reason] = args as [number, number, string];
          events.push({ user_id: userId, kind: eventsKind(sql), amount, reason });
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("UPDATE users SET balance")) {
          const [amount, userId] = args as [number, number];
          const row = users.get(userId);
          if (!row) return { meta: { changes: 0 } };
          if (sql.includes("balance + ?")) {
            row.balance += amount;
            return { meta: { changes: 1 } };
          }
          if (row.balance < amount) return { meta: { changes: 0 } };
          row.balance -= amount;
          return { meta: { changes: 1 } };
        }
        throw new Error(`unexpected sql: ${sql}`);
      },
      first: async <T>(): Promise<T | null> => {
        if (sql.startsWith("SELECT balance FROM users")) {
          const row = users.get(args[0] as number);
          return (row ? { balance: row.balance } : null) as T | null;
        }
        throw new Error(`unexpected first(): ${sql}`);
      },
    };
    return api;
  }

  function eventsKind(sql: string): string {
    return sql.includes("'grant'") ? "grant" : "spend";
  }

  return {
    db: { prepare } as unknown as D1Database,
    users,
    events,
    stmt,
  };
}

let d1: ReturnType<typeof makeD1>;

beforeEach(() => {
  d1 = makeD1();
});

describe("credits ledger", () => {
  it("grants build up a balance and append events", async () => {
    expect(await grantCredits(d1.db, 42, 300, "pack:r10")).toBe(300);
    expect(await grantCredits(d1.db, 42, 100, "bonus")).toBe(400);
    expect(await balanceOf(d1.db, 42)).toEqual({ balance: 400 });
    expect(d1.events).toHaveLength(2);
    expect(d1.events.every((e) => e.kind === "grant")).toBe(true);
  });

  it("spends decrement atomically while funds last", async () => {
    await grantCredits(d1.db, 7, 100, "pack");
    expect(await spendCredits(d1.db, 7, 60, "transcribe:min")).toBe(40);
    expect(await spendCredits(d1.db, 7, 60, "transcribe:min")).toBeNull();
    expect(await balanceOf(d1.db, 7)).toEqual({ balance: 40 });
  });

  it("never lets an unknown user go negative", async () => {
    expect(await spendCredits(d1.db, 999, 1, "nope")).toBeNull();
    expect(await balanceOf(d1.db, 999)).toEqual({ balance: 0 });
  });

  it("rejects non-positive or fractional amounts", async () => {
    await expect(grantCredits(d1.db, 1, 0, "x")).rejects.toThrow(RangeError);
    await expect(grantCredits(d1.db, 1, -5, "x")).rejects.toThrow(RangeError);
    await expect(spendCredits(d1.db, 1, 1.5, "x")).rejects.toThrow(RangeError);
  });

  it("isolates users", async () => {
    await grantCredits(d1.db, 1, 50, "a");
    await grantCredits(d1.db, 2, 10, "b");
    expect(await spendCredits(d1.db, 2, 10, "use")).toBe(0);
    expect(await balanceOf(d1.db, 1)).toEqual({ balance: 50 });
  });
});
