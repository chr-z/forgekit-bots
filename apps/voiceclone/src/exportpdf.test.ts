import { beforeEach, describe, expect, it } from "vitest";
import worker from "./index";
import { exportCaption, exportFileName, historyToPdfDoc, renderHistoryPdf } from "./exportpdf";
import { makeKv, makeTgFetch, makeVcD1, type VcStore } from "./testhelpers";

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
  docs?: { chatId: number; name: string; caption?: string; body: ArrayBuffer }[];
};

function env(): Record<string, unknown> {
  return { TELEGRAM_BOT_TOKEN: "TESTTOKEN", WEBHOOK_SECRET: "s3cret", KV: kv, DB: store.db };
}

function webhook(body: unknown): Request {
  return new Request("https://voiceclone.bot/hook", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "s3cret", "content-type": "application/json" },
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

/** Register the watched channel + term through the public worker surface. */
async function setupWatchedChannel(): Promise<void> {
  script.chats = { durov: { id: -100123, type: "channel", title: "Durov" } };
  await call(cmdUpdate(1, "/addchannel https://t.me/durov"));
  await call(cmdUpdate(2, "/addterm sorteio"));
}

function makePro(): void {
  store.subs.set(USER.id, new Date(Date.now() + 30 * 24 * 3600_000).toISOString());
}

/** Inflate the FlateDecode content stream of a rendered PDF back to text. */
async function inflatePdfText(bytes: Uint8Array): Promise<string> {
  const raw = Buffer.from(bytes).toString("latin1");
  const marker = raw.match(/\/Filter \/FlateDecode >>\nstream\n/);
  if (!marker || marker.index === undefined) throw new Error("no flate stream found");
  const start = marker.index + marker[0].length;
  const end = raw.indexOf("\nendstream", start);
  const chunk = bytes.subarray(start, end);
  const ds = new DecompressionStream("deflate");
  const buf = await new Response(new Blob([chunk]).stream().pipeThrough(ds)).arrayBuffer();
  return Buffer.from(buf).toString("latin1");
}

beforeEach(() => {
  store = makeVcD1();
  kv = makeKv();
  script = { sent: [], preCheckout: [], docs: [] };
  globalThis.fetch = makeTgFetch(script) as typeof fetch;
});

describe("history -> PdfDoc mapping", () => {
  it("maps rows into labeled bullets with retry marks and excerpt truncation", () => {
    const rows = [
      {
        terms: "sorteio",
        title: "Durov",
        excerpt: "x".repeat(120),
        created_at: "2026-08-26 03:00",
        delivered: 0,
      },
      {
        terms: "vaga, sorteio",
        title: "Jobs BR",
        excerpt: "curto",
        created_at: "2026-08-26 04:30",
        delivered: 1,
      },
    ];
    const doc = historyToPdfDoc(rows, 2, 45, "pt-BR");
    expect(doc.title).toBe("VoiceClone Alerts");
    expect(doc.tldrLabel).toBe("Alertas");
    expect(doc.tldr).toContain("página 2");
    expect(doc.tldr).toContain("45 no total");
    expect(doc.bullets[0]).toContain("Página 2");
    expect(doc.bullets[0]).toContain("45 no total");
    const first = String(doc.bullets[2]);
    expect(first).toContain("2026-08-26 03:00 · Durov · sorteio");
    expect(first).toContain("na fila de reenvio");
    expect(first).toContain("…" );
    expect(String(doc.bullets[3])).toContain("vaga, sorteio");
    expect(String(doc.bullets[3])).not.toContain("fila");
  });

  it("localizes header lines to English when the locale is en", () => {
    const doc = historyToPdfDoc(
      [{ terms: "t", title: "C", excerpt: "e", created_at: "2026-01-01", delivered: 1 }],
      1,
      7,
      "en",
    );
    expect(doc.tldrLabel).toBe("Alerts");
    expect(doc.tldr).toContain("page 1");
    expect(doc.tldr).toContain("7 total");
    expect(doc.bullets[0]).toContain("Page 1");
  });
});

describe("export helpers", () => {
  it("builds safe filenames and bounded captions", () => {
    expect(exportFileName(3)).toBe("voiceclone-history-p3.pdf");
    expect(exportFileName(-5)).toBe("voiceclone-history-p1.pdf");
    const cap = exportCaption(12, "pt-BR");
    expect(cap).toContain("12 alerta(s)");
    expect(cap.length).toBeLessThanOrEqual(200);
    const long = "y".repeat(500);
    expect(exportCaption(long.length, "en").length).toBeLessThanOrEqual(200);
  });

  it("renders a structurally valid PDF whose stream carries the mapped content", async () => {
    const rows = [
      {
        terms: "sorteio",
        title: "Durov",
        excerpt: "SORTEIO especial hoje!",
        created_at: "2026-08-26 03:00",
        delivered: 1,
      },
    ];
    const bytes = await renderHistoryPdf(rows, 1, 1, "pt-BR");
    const raw = Buffer.from(bytes).toString("latin1");
    expect(raw.startsWith("%PDF-1.4")).toBe(true);
    expect(raw.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(raw).toContain("/Filter /FlateDecode");
    const text = await inflatePdfText(bytes);
    expect(text).toContain("(Alertas: Histórico de alertas");
    expect(text).toContain("SORTEIO especial hoje!");
    expect(text).not.toContain("(TLDR:");
  });
});
