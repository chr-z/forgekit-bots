/**
 * voiceclone test helpers — D1/KV/Telegram-fetch fakes shared by the suite.
 * Modeled on apps/documind/src/testhelpers.ts conventions.
 */

export interface VcStore {
  db: unknown; // D1Database-shaped
  channels: Map<number, { chat_id: number; owner_id: number; title: string }>;
  terms: Map<number, string[]>;
  usage: unknown[][];
  subs: Map<number, string>;
  balances: Map<number, number>;
  charges: Set<string>;
}

/** D1 stub covering every statement store.ts + stars/credits issue. */
export function makeVcD1(): VcStore {
  const channels = new Map<number, { chat_id: number; owner_id: number; title: string }>();
  const terms = new Map<number, string[]>();
  const usage: unknown[][] = [];
  const subs = new Map<number, string>();
  const balances = new Map<number, number>();
  const charges = new Set<string>();

  function prepare(sql: string) {
    let args: unknown[] = [];
    const api = {
      bind(...a: unknown[]) {
        args = a;
        return api;
      },
      async run() {
        if (sql.startsWith("INSERT INTO vc_channels")) {
          const [chatId, ownerId, title] = args as [number, number, string];
          channels.set(chatId, { chat_id: chatId, owner_id: ownerId, title });
          return { meta: {} };
        }
        if (sql.startsWith("DELETE FROM vc_channels")) {
          const [chatId, ownerId] = args as [number, number];
          const ch = channels.get(chatId);
          if (!ch || ch.owner_id !== ownerId) return { meta: { changes: 0 } };
          channels.delete(chatId);
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("INSERT OR IGNORE INTO vc_terms")) {
          const [chatId, term] = args as [number, string];
          const list = terms.get(chatId) ?? [];
          if (list.includes(term)) return { meta: { changes: 0 } };
          list.push(term);
          terms.set(chatId, list);
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("DELETE FROM vc_terms WHERE chat_id = ? AND term = ?")) {
          const [chatId, term] = args as [number, string];
          const list = terms.get(chatId) ?? [];
          const idx = list.indexOf(term);
          if (idx === -1) return { meta: { changes: 0 } };
          list.splice(idx, 1);
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("DELETE FROM vc_terms")) {
          terms.delete(args[0] as number);
          return { meta: {} };
        }
        if (sql.startsWith("INSERT INTO usage_log")) {
          usage.push(args);
          return { meta: {} };
        }
        if (sql.startsWith("INSERT OR IGNORE INTO star_payments")) {
          const chargeId = args[0] as string;
          if (charges.has(chargeId)) return { meta: { changes: 0 } };
          charges.add(chargeId);
          return { meta: { changes: 1 } };
        }
        if (sql.startsWith("INSERT OR IGNORE INTO users")) {
          const id = args[0] as number;
          if (!balances.has(id)) balances.set(id, 0);
          return { meta: {} };
        }
        if (sql.startsWith("INSERT INTO subscriptions")) {
          const [userId, proUntil] = args as [number, string];
          subs.set(userId, proUntil);
          return { meta: {} };
        }
        if (sql.startsWith("INSERT INTO credit_events")) {
          return { meta: {} }; // ledger row; cached column below mirrors delta
        }
        if (sql.startsWith("UPDATE users SET balance")) {
          const [amount, userId] = args as [number, number];
          balances.set(userId, (balances.get(userId) ?? 0) + amount);
          return { meta: { changes: 1 } };
        }
        throw new Error(`unexpected run(): ${sql}`);
      },
      async first<T>(): Promise<T | null> {
        if (sql.startsWith("SELECT pro_until")) {
          const until = subs.get(args[0] as number);
          return (until ? { pro_until: until } : null) as T | null;
        }
        if (sql.startsWith("SELECT balance FROM users")) {
          return { balance: balances.get(args[0] as number) ?? 0 } as T | null;
        }
        if (sql.startsWith("SELECT chat_id, owner_id, title FROM vc_channels WHERE chat_id")) {
          const ch = channels.get(args[0] as number);
          return (ch as T) ?? null;
        }
        if (sql.startsWith("SELECT COUNT(*) AS n FROM vc_terms")) {
          return { n: terms.get(args[0] as number)?.length ?? 0 } as T | null;
        }
        throw new Error(`unexpected first(): ${sql}`);
      },
      async all<T>(): Promise<{ results: T[] }> {
        if (sql.includes("FROM vc_channels") && sql.includes("owner_id = ?")) {
          const ownerId = args[0] as number;
          const rows = [...channels.values()]
            .filter((c) => c.owner_id === ownerId)
            .reverse();
          return { results: rows as T[] };
        }
        if (sql.startsWith("SELECT term FROM vc_terms WHERE chat_id")) {
          const list = terms.get(args[0] as number) ?? [];
          return { results: list.map((term) => ({ term })) as T[] };
        }
        if (sql.startsWith("SELECT chat_id, term FROM vc_terms")) {
          const rows: T[] = [];
          for (const [chat_id, list] of terms) {
            for (const term of list) rows.push({ chat_id, term } as T);
          }
          return { results: rows };
        }
        throw new Error(`unexpected all(): ${sql}`);
      },
    };
    return api;
  }

  return {
    db: { prepare } as unknown,
    channels,
    terms,
    usage,
    subs,
    balances,
    charges,
  };
}

/** KVNamespace stub (get(_, "json") parses like production). */
export function makeKv(): KVNamespace {
  const m = new Map<string, string>();
  return {
    get: async (key: string) => {
      const v = m.get(key);
      if (v === undefined) return null;
      try {
        return JSON.parse(v);
      } catch {
        return v;
      }
    },
    put: async (key: string, value: string) => {
      m.set(key, value);
    },
    delete: async (key: string) => {
      m.delete(key);
    },
  } as unknown as KVNamespace;
}

export interface TgScript {
  /** Captured outgoing DMs (in order). */
  sent: { chatId: number; text: string }[];
  /** Captured pre-checkout answers. */
  preCheckout: { id: string; ok: boolean }[];
  /** sendMessage calls toward these chat ids fail (retry-queue path). */
  failSendsTo?: Set<number>;
  /** Status returned by getChatMember for the BOT (default administrator). */
  botStatus?: string;
  /** Chat directory for getChat, keyed by handle (no @, lowercase) or id string. */
  chats?: Record<string, { id: number; type: string; title: string }>;
}

const R = (obj: unknown) => new Response(JSON.stringify(obj));

/** Global-fetch fake for api.telegram.org used by BotApi. */
export function makeTgFetch(s: TgScript): typeof fetch {
  const impl = async (input: unknown, init?: { body?: unknown }): Promise<Response> => {
    const url = String(input);
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
    } catch {
      body = {};
    }
    // Order matters: /getChatMember contains /getChat as a substring.
    if (url.includes("/getChatMember")) {
      return R({ ok: true, result: { status: s.botStatus ?? "administrator" } });
    }
    if (url.includes("/getChat")) {
      const key = String(body.chat_id ?? "").replace(/^@/, "").toLowerCase();
      const chat = s.chats?.[key];
      if (!chat) return R({ ok: false, description: "chat not found" });
      return R({ ok: true, result: { id: chat.id, type: chat.type, title: chat.title } });
    }
    if (url.includes("/getMe")) {
      return R({ ok: true, result: { id: 999000, username: "VcAlertsBot" } });
    }
    if (url.includes("/answerPreCheckoutQuery")) {
      s.preCheckout.push({
        id: String(body.pre_checkout_query_id),
        ok: Boolean(body.ok),
      });
      return R({ ok: true, result: true });
    }
    if (url.includes("/sendMessage")) {
      const chatId = Number(body.chat_id);
      if (s.failSendsTo?.has(chatId)) {
        return R({ ok: false, description: "send failed (scripted)" });
      }
      s.sent.push({ chatId, text: String(body.text ?? "") });
      return R({ ok: true, result: { message_id: 1 } });
    }
    return R({ ok: false, description: `unscripted ${url}` });
  };
  return impl as unknown as typeof fetch;
}

/** Worker env assembled from the fakes. */
export function makeEnv(store: VcStore, kv: KVNamespace): Record<string, unknown> {
  return {
    TELEGRAM_BOT_TOKEN: "TESTTOKEN",
    WEBHOOK_SECRET: "s3cret",
    KV: kv,
    DB: store.db,
  };
}
