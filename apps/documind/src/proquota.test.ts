import { beforeEach, describe, expect, it } from "vitest";
import { default as worker, PRO_QUESTION_LIMIT } from "./index";
import { buildPdfBytes, makeCaptureFetch, makeDocD1 } from "./testhelpers";

/**
 * Roadmap line 42 enforcement: Pro = docs ilimitados + 500 perguntas.
 * These tests drive the REAL webhook pipeline (ingest -> ask) against the
 * D1/KV fakes, seeding the Pro KV counter directly like production KV would.
 */

const CHAT = { id: 42, type: "private" };
const WINDOW_30D = 30 * 86400;

interface TestUser {
  id: number;
  is_bot: boolean;
  language_code: string;
}

let store: ReturnType<typeof makeDocD1>;
let sent: string[];
let kvMap: Map<string, string>;

function env(): Record<string, unknown> {
  return {
    TELEGRAM_BOT_TOKEN: "TESTTOKEN",
    WEBHOOK_SECRET: "s3cret",
    KV: {
      // Mirrors KVNamespace.get(_, "json"): stored values come back parsed.
      get: async (k: string) => {
        const v = kvMap.get(k);
        if (v === undefined) return null;
        try {
          return JSON.parse(v);
        } catch {
          return v;
        }
      },
      put: async (k: string, v: string) => {
        kvMap.set(k, v);
      },
      delete: async (k: string) => {
        kvMap.delete(k);
      },
    },
    DB: store.db,
    AI: undefined,
  };
}

function webhook(body: unknown): Request {
  return new Request("https://documind.bot/hook", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "s3cret", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function cmdUpdate(user: TestUser, id: number, text: string): unknown {
  return { update_id: id, message: { message_id: id, from: user, chat: CHAT, text } };
}

function makePro(userId: number): void {
  store.subs.set(userId, new Date(Date.now() + 86400_000).toISOString());
}

/** Current-window key for the Pro counter of a user (mirrors RateLimiter). */
function proCounterKey(userId: number, used?: number): string {
  const w = Math.floor(Date.now() / 1000 / WINDOW_30D);
  const key = `rl:documind:q:${userId}:pro:${w}`;
  if (used !== undefined) kvMap.set(key, JSON.stringify({ window: w, used }));
  return key;
}

async function ingestDoc(user: TestUser, updId: number): Promise<void> {
  const bytes = await buildPdfBytes();
  globalThis.fetch = makeCaptureFetch({ sent, fileBytes: bytes }) as never;
  await worker.fetch(
    webhook({
      update_id: updId,
      message: {
        message_id: updId,
        from: user,
        chat: CHAT,
        document: {
          file_id: `F${updId}`,
          file_name: "contrato.pdf",
          mime_type: "application/pdf",
          file_size: 1024,
        },
      },
    }),
    env() as never,
  );
  globalThis.fetch = makeCaptureFetch({ sent }) as never;
  expect(sent).toHaveLength(1); // doc_ready
}

async function ask(user: TestUser, updId: number, q: string): Promise<void> {
  await worker.fetch(webhook(cmdUpdate(user, updId, q)), env() as never);
}

beforeEach(() => {
  store = makeDocD1();
  sent = [];
  kvMap = new Map();
  globalThis.fetch = makeCaptureFetch({ sent }) as never;
});

const PT: TestUser = { id: 777, is_bot: false, language_code: "pt-BR" };
const EN: TestUser = { id: 888, is_bot: false, language_code: "en-US" };
const Q = "/ask Qual é o prazo de garantia?";

describe("DocuMind Pro question ceiling (roadmap line 42)", () => {
  it("answers normally while under the 500-question ceiling", async () => {
    makePro(PT.id);
    await ingestDoc(PT, 201);
    await ask(PT, 202, Q);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("doze meses"); // real cited answer
    expect(sent[1]).not.toContain("Cota Pro");
    expect(store.balances.get(PT.id) ?? 0).toBe(0); // no credit spent
  });

  it("dry at the ceiling with zero credits refuses, upsells and charges nothing", async () => {
    makePro(PT.id);
    await ingestDoc(PT, 211);
    proCounterKey(PT.id, PRO_QUESTION_LIMIT);
    await ask(PT, 212, Q);
    expect(sent).toHaveLength(2); // refusal replaces the answer
    expect(sent[1]).not.toContain("doze meses");
    expect(sent[1]).toContain(`${PRO_QUESTION_LIMIT} perguntas Pro`);
    expect(sent[1]).toContain("/buy");
    expect(store.balances.get(PT.id) ?? 0).toBe(0);
  });

  it("past the ceiling spends one credit and appends the notice to the answer", async () => {
    makePro(PT.id);
    store.balances.set(PT.id, 5);
    await ingestDoc(PT, 221);
    proCounterKey(PT.id, PRO_QUESTION_LIMIT);
    await ask(PT, 222, Q);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("doze meses"); // user still gets the answer
    expect(sent[1]).toContain("Cota Pro atingida (500)");
    expect(sent[1]).toContain("1 crédito");
    expect(store.balances.get(PT.id)).toBe(4); // exactly one credit debited
  });

  it("localizes the dry-ceiling refusal for EN users", async () => {
    makePro(EN.id);
    await ingestDoc(EN, 231);
    proCounterKey(EN.id, PRO_QUESTION_LIMIT);
    await ask(EN, 232, Q);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain(`all ${PRO_QUESTION_LIMIT} Pro questions`);
    expect(sent[1]).toContain("/buy");
  });
});
