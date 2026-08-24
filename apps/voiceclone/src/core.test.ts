import { describe, expect, it } from "vitest";
import {
  drainRetryQueue,
  handleChannelPost,
  limitsFor,
  VOICECLONE_CATALOG,
  FREE_TERMS,
  PRO_CHANNELS,
  PRO_TERMS,
} from "./index";
import { addTerm, upsertChannel } from "./store";
import { ALERT_TTL_MS, enqueueAlert, makeAlert, renderAlert, takeAlerts } from "./alerts";
import { makeKv, makeTgFetch, makeVcD1, type VcStore } from "./testhelpers";

type WorkerEnv = { TELEGRAM_BOT_TOKEN: string; WEBHOOK_SECRET: string; KV: KVNamespace; DB: unknown };

function setup(opts?: { failSendsTo?: Set<number>; botStatus?: string }) {
  const store: VcStore = makeVcD1();
  const kv = makeKv();
  const script = {
    sent: [] as { chatId: number; text: string }[],
    preCheckout: [] as { id: string; ok: boolean }[],
    ...opts,
  };
  globalThis.fetch = makeTgFetch(script) as typeof fetch;
  return { store, kv, script };
}

describe("limitsFor", () => {
  it("free plan gets 1 channel + 1 term; pro gets 5 + 20", () => {
    expect(limitsFor(false, 0)).toEqual({ maxChannels: 1, maxTerms: FREE_TERMS });
    expect(limitsFor(true, 0)).toEqual({ maxChannels: PRO_CHANNELS, maxTerms: PRO_TERMS });
  });

  it("credit balance converts into extra term slots (capped at hard cap)", () => {
    expect(limitsFor(false, 10).maxTerms).toBe(11);
    expect(limitsFor(true, 100).maxTerms).toBe(70);
  });
});

describe("handleChannelPost", () => {
  async function seedChannel(store: VcStore, terms: string[]) {
    await upsertChannel(store.db as never, -100777, 42, "Canal Teste");
    for (const term of terms) {
      await addTerm(store.db as never, -100777, term);
    }
  }

  it("alerts the owner when a post matches a watch term", async () => {
    const { store, kv, script } = setup();
    await seedChannel(store, ["pagamento"]);
    const out = await handleChannelPost(
      { db: store.db as never, kv, bot: { sendMessage: async (id: number, text: string) => { script.sent.push({ chatId: id, text }); } } },
      -100777,
      5,
      "O pagamento caiu hoje!",
    );
    expect(out.matched).toBe(true);
    expect(out.notified).toEqual([42]);
    expect(script.sent[0]?.text).toContain('"pagamento"');
    expect(script.sent[0]?.text).toContain("pagamento caiu");
  });

  it("ignores posts of unregistered channels and non-matching texts", async () => {
    const { store, kv } = setup();
    const deps = { db: store.db as never, kv, bot: { sendMessage: async () => {} } };
    expect((await handleChannelPost(deps, -999999, 1, "qualquer coisa")).matched).toBe(false);
    await seedChannel(store, ["pix"]);
    expect((await handleChannelPost(deps, -100777, 2, "nada a ver aqui")).matched).toBe(false);
    expect((await handleChannelPost(deps, -100777, 3, "")).matched).toBe(false);
  });

  it("queues an alert for retry when the send fails", async () => {
    const { store, kv } = setup();
    await seedChannel(store, ["ceo"]);
    const failingBot = { sendMessage: async () => { throw new Error("down"); } };
    const out = await handleChannelPost(
      { db: store.db as never, kv, bot: failingBot },
      -100777,
      9,
      "a CEO anunciou",
    );
    expect(out.matched).toBe(true);
    const queued = await takeAlerts(kv);
    expect(queued.length).toBe(1);
    expect(queued[0]?.toChatId).toBe(42);
  });

  it("dedupes webhook redelivery of the same post", async () => {
    const { store, kv, script } = setup();
    await seedChannel(store, ["pix"]);
    const deps = { db: store.db as never, kv, bot: { sendMessage: async (id: number, text: string) => { script.sent.push({ chatId: id, text }); } } };
    await handleChannelPost(deps, -100777, 11, "chave pix liberada");
    await handleChannelPost(deps, -100777, 11, "chave pix liberada");
    expect(script.sent.length).toBe(1);
  });

  it("logs matched alerts into usage_log", async () => {
    const { store, kv } = setup();
    await seedChannel(store, ["curso"]);
    await handleChannelPost(
      { db: store.db as never, kv, bot: { sendMessage: async () => {} } },
      -100777,
      12,
      "curso novo saiu",
    );
    expect(store.usage.length).toBe(1);
    expect(store.usage[0]?.[0]).toBe(42);
  });
});

describe("retry queue", () => {
  it("takeAlerts respects max and drops expired alerts", async () => {
    const kv = makeKv();
    const now = Date.now();
    await enqueueAlert(kv, makeAlert(1, "old", now - ALERT_TTL_MS - 1000));
    await enqueueAlert(kv, makeAlert(2, "fresh", now));
    await enqueueAlert(kv, makeAlert(3, "fresh2", now));
    const batch = await takeAlerts(kv, 1);
    expect(batch.map((a) => a.toChatId)).toEqual([2]);
    // second pass gets the rest
    expect((await takeAlerts(kv)).map((a) => a.toChatId)).toEqual([3]);
  });

  it("drainRetryQueue re-enqueues only failed sends", async () => {
    const { store, kv, script } = setup();
    await enqueueAlert(kv, makeAlert(111, "ok-one"));
    await enqueueAlert(kv, makeAlert(222, "fails"));
    script.failSendsTo = new Set([222]);
    const env = {
      TELEGRAM_BOT_TOKEN: "t",
      WEBHOOK_SECRET: "w",
      KV: kv,
      DB: store.db,
    } as unknown as WorkerEnv;
    const sentCount = await drainRetryQueue(env as never);
    expect(sentCount).toBe(1);
    // the failed one is still queued for the next tick
    const remaining = await takeAlerts(kv);
    expect(remaining.map((a) => a.toChatId)).toEqual([222]);
  });
});

describe("renderAlert", () => {
  it("includes terms, channel title and truncates long excerpts", () => {
    const msg = renderAlert("Meu Canal", ["pix", "sorteio"], "a".repeat(400));
    expect(msg).toContain('"pix", "sorteio"');
    expect(msg).toContain("Meu Canal");
    expect(msg.length).toBeLessThan(340);
  });
});

describe("catalog", () => {
  it("has subscription + credit pack with Stars pricing", () => {
    const kinds = VOICECLONE_CATALOG.map((p) => p.kind).sort();
    expect(kinds).toEqual(["credits", "subscription"]);
    for (const p of VOICECLONE_CATALOG) {
      expect(p.priceInStars).toBeGreaterThan(0);
      expect(p.productId.length).toBeGreaterThan(0);
    }
    expect(VOICECLONE_CATALOG.find((p) => p.kind === "subscription")?.proDays).toBe(30);
  });
});
