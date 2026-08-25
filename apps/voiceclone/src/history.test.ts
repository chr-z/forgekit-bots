import { beforeEach, describe, expect, it } from "vitest";
import worker, { HISTORY_FREE_KEEP, renderHistoryPage } from "./index";
import { upsertChannel } from "./store";
import { makeKv, makeTgFetch, makeVcD1, type VcStore } from "./testhelpers";

const USER = { id: 777, is_bot: false, language_code: "pt-BR" };
const CHAT = { id: 42, type: "private" };

type AnyDb = Parameters<typeof upsertChannel>[0];

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

function postUpdate(id: number, messageId: number, text: string): unknown {
  return {
    update_id: id,
    channel_post: { message_id: messageId, chat: { id: -100123, type: "channel" }, text },
  };
}

async function call(body: unknown): Promise<Response> {
  return worker.fetch(webhook(body), env() as never);
}

/** Register the watched channel + one term through the public worker surface. */
async function setupWatchedChannel(): Promise<void> {
  script.chats = { durov: { id: -100123, type: "channel", title: "Durov" } };
  await call(cmdUpdate(1, "/addchannel https://t.me/durov"));
  await call(cmdUpdate(2, "/addterm sorteio"));
}

function makePro(): void {
  store.subs.set(USER.id, new Date(Date.now() + 30 * 24 * 3600_000).toISOString());
}

beforeEach(() => {
  store = makeVcD1();
  kv = makeKv();
  script = { sent: [], preCheckout: [] };
  globalThis.fetch = makeTgFetch(script) as typeof fetch;
});

// ------------------------------------------------------------------- tests

describe("alert history (roadmap: Pro histórico)", () => {
  it("records every fired alert with terms, title and delivery outcome", async () => {
    await setupWatchedChannel();
    await call(postUpdate(10, 500, "SORTEIO especial hoje!"));
    await call(postUpdate(11, 501, "outro SORTEIO aqui"));
    expect(store.alerts).toHaveLength(2);
    expect(store.alerts[0]).toMatchObject({
      owner_id: USER.id,
      chat_id: -100123,
      title: "Durov",
      terms: "sorteio",
      delivered: 1,
    });
    expect(store.alerts[0]!.excerpt).toContain("SORTEIO");
  });

  it("marks alerts as retry (delivered=0) when the DM send fails", async () => {
    await setupWatchedChannel();
    script.failSendsTo = new Set([USER.id]);
    await call(postUpdate(10, 500, "SORTEIO falhou o envio"));
    expect(store.alerts).toHaveLength(1);
    expect(store.alerts[0]!.delivered).toBe(0);
  });

  it("does not record non-matching posts", async () => {
    await setupWatchedChannel();
    await call(postUpdate(10, 500, "post sem nada relevante"));
    expect(store.alerts).toHaveLength(0);
  });

  it("free users keep only a tiny tail; pruning keeps the newest rows", async () => {
    await setupWatchedChannel();
    for (let i = 0; i < HISTORY_FREE_KEEP + 3; i += 1) {
      await call(postUpdate(20 + i, 600 + i, `SORTEIO numero ${i}`));
    }
    expect(store.alerts.length).toBe(HISTORY_FREE_KEEP);
    // newest survives, oldest pruned
    expect(store.alerts[0]!.excerpt).toContain(`numero ${3}`);
  });

  it("/history is Pro-gated: free user sees count + upsell instead of rows", async () => {
    await setupWatchedChannel();
    await call(postUpdate(30, 700, "SORTEIO de verdade"));
    await call(cmdUpdate(31, "/history"));
    expect(script.sent.at(-1)?.text).toContain("Pro");
    expect(script.sent.at(-1)?.text).toContain("1");
  });

  it("/history lists recorded alerts for a Pro user (pt-BR header)", async () => {
    await setupWatchedChannel();
    makePro();
    await call(postUpdate(40, 800, "primeiro SORTEIO"));
    await call(postUpdate(41, 801, "segundo SORTEIO"));
    await call(cmdUpdate(42, "/history"));
    const text = script.sent.at(-1)?.text ?? "";
    expect(text).toContain("Histórico");
    expect(text).toContain("sorteio");
    expect(text).toContain("Durov");
  });

  it("/history paginates: page 2 exists once there are more than 10 rows", async () => {
    await setupWatchedChannel();
    makePro();
    for (let i = 0; i < 12; i += 1) {
      await call(postUpdate(50 + i, 900 + i, `SORTEIO item ${i + 1}`));
    }
    await call(cmdUpdate(62, "/history 2"));
    const text = script.sent.at(-1)?.text ?? "";
    expect(text).toContain("(2/2)");
    // newest first: page 1 = item12..item3, page 2 = item2,item1
    expect(text).toContain("item 2");
    expect(text).not.toContain("item 12");
  });

  it("/history on an empty history explains how it works", async () => {
    makePro();
    await call(cmdUpdate(70, "/history"));
    expect(script.sent.at(-1)?.text).toContain("ainda");
  });

  it("/clearhistory wipes the owner's rows only", async () => {
    await setupWatchedChannel();
    await call(postUpdate(80, 1000, "SORTEIO para limpar"));
    await upsertChannel(store.db as AnyDb, -100777, 888, "Alheio");
    store.alerts.push({
      id: 999,
      owner_id: 888,
      chat_id: -100777,
      title: "Alheio",
      terms: "x",
      excerpt: "y",
      delivered: 1,
    });
    await call(cmdUpdate(81, "/clearhistory"));
    expect(script.sent.at(-1)?.text).toContain("limpo");
    expect(store.alerts.map((a) => a.owner_id)).toEqual([888]);
  });

  it("renderHistoryPage caps output inside the Telegram limit", () => {
    const fat = Array.from({ length: 400 }, (_, i) => ({
      terms: `"termo-${i}"`,
      title: "Canal Bem Comprido De Nome Para Estourar O Limite",
      excerpt: "Trecho do post que dispara o alerta e aparece na listagem",
      created_at: "2026-08-25 00:00:00",
      delivered: 1,
    }));
    const out = renderHistoryPage(fat, 1, 1, 400, "en");
    expect(out.length).toBeLessThanOrEqual(4096);
    expect(out.endsWith("…")).toBe(true);
    expect(renderHistoryPage([], 1, 1, 0, "en")).toContain("—");
  });

  it("i18n: en and pt-BR still aligned after the new keys", async () => {
    const { MESSAGES } = await import("./index");
    expect(Object.keys(MESSAGES.en).sort()).toEqual(Object.keys(MESSAGES["pt-BR"]).sort());
    expect(MESSAGES.en.history_page).toBeTruthy();
  });
});

