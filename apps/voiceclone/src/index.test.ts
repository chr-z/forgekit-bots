import { beforeEach, describe, expect, it } from "vitest";
import worker, { MESSAGES, VOICECLONE_CATALOG } from "./index";
import { upsertChannel, addTerm } from "./store";
import { makeKv, makeTgFetch, makeVcD1, type VcStore } from "./testhelpers";

type AnyDb = Parameters<typeof upsertChannel>[0];

const USER = { id: 777, is_bot: false, language_code: "pt-BR" };
const CHAT = { id: 42, type: "private" };

let store: VcStore;
let kv: KVNamespace;
let script: {
  sent: { chatId: number; text: string }[];
  preCheckout: { id: string; ok: boolean }[];
  failSendsTo?: Set<number>;
  botStatus?: string;
  chats?: Record<string, { id: number; type: string; title: string }>;
};

function env(): Record<string, unknown> {
  return { TELEGRAM_BOT_TOKEN: "TESTTOKEN", WEBHOOK_SECRET: "s3cret", KV: kv, DB: store.db };
}

function webhook(body: unknown, secret = "s3cret"): Request {
  return new Request("https://voiceclone.bot/hook", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": secret, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function cmdUpdate(id: number, text: string): unknown {
  return { update_id: id, message: { message_id: id, from: USER, chat: CHAT, text } };
}

async function call(body: unknown, secret?: string): Promise<Response> {
  return worker.fetch(webhook(body, secret), env() as never);
}

beforeEach(() => {
  store = makeVcD1();
  kv = makeKv();
  script = { sent: [], preCheckout: [] };
  globalThis.fetch = makeTgFetch(script) as typeof fetch;
});

// ------------------------------------------------------------------- tests

describe("worker surface", () => {
  it("GET returns an up banner; wrong webhook secret is rejected", async () => {
    const banner = await worker.fetch(new Request("https://x/"), env() as never);
    expect(banner.status).toBe(200);
    expect(await banner.text()).toContain("voiceclone");
    const bad = await call(cmdUpdate(1, "/start"), "wrong-secret");
    expect(bad.status).toBe(401);
  });

  it("/start greets in pt-BR with setup steps", async () => {
    await call(cmdUpdate(1, "/start"));
    expect(script.sent[0]?.chatId).toBe(42);
    expect(script.sent[0]?.text).toContain("/addchannel");
    expect(script.sent[0]?.text).toContain("/addterm");
  });

  it("non-command chatter gets silence with 200", async () => {
    const res = await call({ update_id: 2, message: { message_id: 2, from: USER, chat: CHAT, text: "oi" } });
    expect(res.status).toBe(200);
    expect(script.sent.length).toBe(0);
  });
});

describe("/addchannel", () => {
  it("registers the channel after proving BOT admin membership", async () => {
    script.chats = { durov: { id: -100123, type: "channel", title: "Durov" } };
    await call(cmdUpdate(1, "/addchannel https://t.me/durov"));
    expect(store.channels.get(-100123)).toMatchObject({ owner_id: 777, title: "Durov" });
    expect(script.sent[0]?.text).toContain("Durov");
  });

  it("refuses when the bot is not an admin there", async () => {
    script.chats = { durov: { id: -100123, type: "channel", title: "Durov" } };
    script.botStatus = "member";
    await call(cmdUpdate(1, "/addchannel @durov"));
    expect(store.channels.size).toBe(0);
    expect(script.sent[0]?.text).toContain("admin");
  });

  it("refuses non-channel targets", async () => {
    script.chats = { joao: { id: 555, type: "user", title: "João" } };
    await call(cmdUpdate(1, "/addchannel @joao"));
    expect(store.channels.size).toBe(0);
    expect(script.sent[0]?.text.length).toBeGreaterThan(5);
  });

  it("enforces the free plan channel limit (1)", async () => {
    await upsertChannel(store.db as AnyDb, -100999, 777, "Já Registrado");
    script.chats = { durov: { id: -100123, type: "channel", title: "Durov" } };
    await call(cmdUpdate(1, "/addchannel @durov"));
    expect(store.channels.has(-100123)).toBe(false);
    expect(script.sent[0]?.text).toMatch(/1|Limite|limit/i);
  });
});

describe("/addterm + /terms + /removeterm", () => {
  beforeEach(async () => {
    await upsertChannel(store.db as AnyDb, -100123, 777, "Durov");
  });

  it("adds a term to the single registered channel", async () => {
    await call(cmdUpdate(1, "/addterm pagamento"));
    expect(store.terms.get(-100123)).toEqual(["pagamento"]);
    expect(script.sent[0]?.text).toContain("pagamento");
  });

  it("rejects duplicate terms without burning quota", async () => {
    await addTerm(store.db as AnyDb, -100123, "pix");
    await call(cmdUpdate(1, "/addterm PIX"));
    expect(store.terms.get(-100123)?.length).toBe(1);
    expect(script.sent[0]?.text).toContain("já estava");
  });

  it("free plan stops at 1 term total", async () => {
    await addTerm(store.db as AnyDb, -100123, "primeiro");
    await call(cmdUpdate(2, "/addterm segundo"));
    expect(store.terms.get(-100123)).toEqual(["primeiro"]);
    expect(script.sent[0]?.text).toContain("Limite");
  });

  it("credit balance raises the term ceiling", async () => {
    store.balances.set(777, 5);
    await call(cmdUpdate(1, "/addterm qualquer"));
    expect(store.terms.get(-100123)).toEqual(["qualquer"]);
  });

  it("/terms lists watch words; /removeterm removes only existing ones", async () => {
    await addTerm(store.db as AnyDb, -100123, "pix");
    await call(cmdUpdate(1, "/terms"));
    expect(script.sent[0]?.text).toContain("pix");
    await call(cmdUpdate(2, "/removeterm pix"));
    expect(script.sent[1]?.text).toContain("removida");
    expect(store.terms.get(-100123)).toEqual([]);
    await call(cmdUpdate(3, "/removeterm fantasma"));
    expect(script.sent[2]?.text.length).toBeGreaterThan(5);
  });

  it("/addterm without any channel explains how to start", async () => {
    await deleteAllChannels();
    await call(cmdUpdate(9, "/addterm pix"));
    expect(script.sent[0]?.text).toContain("/addchannel");
  });

  async function deleteAllChannels(): Promise<void> {
    store.channels.clear();
  }
});

describe("payments", () => {
  it("pre_checkout approves known products and rejects unknown ones", async () => {
    await call({
      update_id: 1,
      pre_checkout_query: { id: "pcq1", from: USER, invoice_payload: "sub:voiceclone-pro" },
    });
    await call({
      update_id: 2,
      pre_checkout_query: { id: "pcq2", from: USER, invoice_payload: "sub:nao-existe" },
    });
    expect(script.preCheckout).toEqual([
      { id: "pcq1", ok: true },
      { id: "pcq2", ok: false },
    ]);
  });

  it("successful_payment grants Pro and confirms (Stars-only catalog intact)", async () => {
    const sub = VOICECLONE_CATALOG.find((p) => p.kind === "subscription");
    await call({
      update_id: 1,
      message: {
        message_id: 1,
        from: USER,
        chat: CHAT,
        successful_payment: {
          currency: "XTR",
          total_amount: sub!.priceInStars,
          invoice_payload: sub!.productId,
          telegram_payment_charge_id: "chg_1",
        },
      },
    });
    expect(store.subs.get(777)).toBeTruthy();
    expect(new Date(store.subs.get(777)!).getTime()).toBeGreaterThan(Date.now());
    expect(script.sent[0]?.text).toContain("Stars");
  });
});

describe("channel_post ingestion (webhook-driven)", () => {
  it("scans posts of registered channels and DMs the owner", async () => {
    await upsertChannel(store.db as AnyDb, -100123, 777, "Durov");
    await addTerm(store.db as AnyDb, -100123, "sorteio");
    const res = await call({
      update_id: 10,
      channel_post: {
        message_id: 500,
        chat: { id: -100123, type: "channel" },
        text: "SORTEIO especial hoje!",
      },
    });
    expect(res.status).toBe(200);
    expect(script.sent).toHaveLength(1);
    expect(script.sent[0]?.chatId).toBe(777);
    expect(script.sent[0]?.text).toContain('"sorteio"');
  });

  it("ignores posts of channels it does not watch", async () => {
    await upsertChannel(store.db as AnyDb, -100123, 777, "Durov");
    await addTerm(store.db as AnyDb, -100123, "sorteio");
    await call({
      update_id: 11,
      channel_post: {
        message_id: 501,
        chat: { id: -100555, type: "channel" },
        text: "SORTEIO aqui!",
      },
    });
    expect(script.sent).toHaveLength(0);
  });
});

describe("i18n dictionary integrity", () => {
  it("en and pt-BR carry exactly the same keys", () => {
    expect(Object.keys(MESSAGES.en).sort()).toEqual(Object.keys(MESSAGES["pt-BR"]).sort());
    expect(Object.keys(MESSAGES.en).length).toBeGreaterThan(15);
  });
});
