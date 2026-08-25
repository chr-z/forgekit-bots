import { beforeEach, describe, expect, it } from "vitest";
import {
  default as worker,
  DOCUMIND_CATALOG,
  FREE_DOC_LIMIT,
  FREE_QUESTION_LIMIT,
  QUOTA_WINDOW_DAYS,
} from "./index";
import { fulfillSuccessfulPayment } from "@forgekit/stars";
import { buildDocxBytes, buildPdfBytes, makeCaptureFetch, makeDocD1 } from "./testhelpers";

const USER = { id: 777, is_bot: false, language_code: "pt-BR" };
const CHAT = { id: 42, type: "private" };

let store: ReturnType<typeof makeDocD1>;
let sent: string[];
let kvMap: Map<string, string>;
let aiOverride: Ai | undefined;

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
    AI: aiOverride,
  };
}

function webhook(body: unknown, secret = "s3cret"): Request {
  return new Request("https://documind.bot/hook", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": secret, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function mimeFor(name: string): string {
  if (name.endsWith(".pdf")) return "application/pdf";
  if (name.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (name.endsWith(".doc")) return "application/msword";
  if (name.endsWith(".jpg")) return "image/jpeg";
  return "text/plain";
}

function docUpdate(id: number, fileName = "contrato.pdf"): unknown {
  return {
    update_id: id,
    message: {
      message_id: id,
      from: USER,
      chat: CHAT,
      document: { file_id: `F${id}`, file_name: fileName, mime_type: mimeFor(fileName), file_size: 1024 },
    },
  };
}

function cmdUpdate(id: number, text: string): unknown {
  return { update_id: id, message: { message_id: id, from: USER, chat: CHAT, text } };
}

function makeAi(reply: string): Ai {
  return { run: async () => ({ response: reply }) } as unknown as Ai;
}

beforeEach(() => {
  store = makeDocD1();
  sent = [];
  kvMap = new Map();
  aiOverride = undefined;
  globalThis.fetch = makeCaptureFetch({ sent }) as never;
});

// ------------------------------------------------------------------- tests

describe("catalog & quotas", () => {
  it("sells Pro + question packs via Stars only; roadmap quotas intact", () => {
    expect(DOCUMIND_CATALOG).toHaveLength(2);
    const sub = DOCUMIND_CATALOG.find((p) => p.kind === "subscription");
    const pack = DOCUMIND_CATALOG.find((p) => p.kind === "credits");
    expect(sub?.priceInStars).toBe(300);
    expect(sub?.proDays).toBe(30);
    expect(pack?.priceInStars).toBe(150);
    expect(pack?.creditsAmount).toBe(150);
    expect(FREE_DOC_LIMIT).toBe(2);
    expect(FREE_QUESTION_LIMIT).toBe(10);
    expect(QUOTA_WINDOW_DAYS).toBe(30);
  });
});

describe("webhook auth & probe", () => {
  it("rejects wrong secret and serves probe on GET", async () => {
    const bad = await worker.fetch(webhook({}, "wrong"), env() as never);
    expect(bad.status).toBe(401);
    const probe = await worker.fetch(new Request("https://x/"), env() as never);
    expect(await probe.text()).toContain("documind");
  });
});

describe("document intake over the webhook", () => {
  it("indexes a real flated PDF and persists numbered chunks", async () => {
    const bytes = await buildPdfBytes();
    globalThis.fetch = makeCaptureFetch({ sent, fileBytes: bytes }) as never;
    const res = await worker.fetch(webhook(docUpdate(1)), env() as never);
    expect(res.status).toBe(200);
    expect(store.docs).toHaveLength(1);
    expect(store.chunks.length).toBeGreaterThan(0);
    expect(store.chunks[0]!.text).toContain("garantia");
  });

  it("refuses scanned PDFs honestly without persisting", async () => {
    globalThis.fetch = makeCaptureFetch({
      sent,
      fileBytes: new TextEncoder().encode("%PDF-1.4 no streams here"),
    }) as never;
    await worker.fetch(webhook(docUpdate(2, "scan.pdf")), env() as never);
    expect(store.docs).toHaveLength(0);
    expect(sent.at(-1)).toContain("texto legível");
  });

  it("unsupported formats are refused before any download", async () => {
    const res = await worker.fetch(webhook(docUpdate(3, "foto.jpg")), env() as never);
    expect(res.status).toBe(200);
    expect(store.docs).toHaveLength(0);
  });

  it("indexes a real .docx over the webhook and answers questions about it", async () => {
    globalThis.fetch = makeCaptureFetch({
      sent,
      fileBytes: await buildDocxBytes(),
    }) as never;
    const res = await worker.fetch(webhook(docUpdate(30, "parecer.docx")), env() as never);
    expect(res.status).toBe(200);
    expect(store.docs).toHaveLength(1);
    expect(store.chunks[0]!.text).toContain("garantia");
    expect(sent.at(-1)).toContain("parecer"); // doc_ready names the file

    aiOverride = makeAi("A multa é de quarenta por cento [1].");
    await worker.fetch(webhook(cmdUpdate(31, "/ask qual a multa rescisória?")), env() as never);
    expect(sent.some((s) => s.includes("quarenta por cento [1]"))).toBe(true);
  });

  it("legacy .doc (not OOXML) is refused with the format message", async () => {
    await worker.fetch(webhook(docUpdate(32, "antigo.doc")), env() as never);
    expect(store.docs).toHaveLength(0);
    expect(sent.at(-1)).toContain(".docx");
  });
});

describe("ask flow", () => {
  it("answers with citations from indexed passages", async () => {
    const bytes = await buildPdfBytes();
    globalThis.fetch = makeCaptureFetch({ sent, fileBytes: bytes }) as never;
    await worker.fetch(webhook(docUpdate(4)), env() as never);
    aiOverride = makeAi("A garantia dura doze meses [1].");
    await worker.fetch(webhook(cmdUpdate(5, "/ask Qual é o prazo de garantia?")), env() as never);
    expect(sent.some((s) => s.includes("doze meses [1]"))).toBe(true);
  });

  it("zero-match questions cost nothing and reply honestly", async () => {
    const bytes = await buildPdfBytes();
    globalThis.fetch = makeCaptureFetch({ sent, fileBytes: bytes }) as never;
    await worker.fetch(webhook(docUpdate(6)), env() as never);
    sent.length = 0;
    await worker.fetch(webhook(cmdUpdate(7, "/ask receita de bolo")), env() as never);
    expect(sent.at(-1)).toContain("Não achei nada");
    expect([...kvMap.keys()].some((k) => k.startsWith("rl:documind"))).toBe(false); // no charge
  });

  it("free quota gates after limit; credit pack covers extra questions", async () => {
    const bytes = await buildPdfBytes();
    globalThis.fetch = makeCaptureFetch({ sent, fileBytes: bytes }) as never;
    await worker.fetch(webhook(docUpdate(8)), env() as never);
    aiOverride = makeAi("Resposta citada [1].");
    // User buys the question pack through the REAL Stars fulfillment path.
    const fulfillment = await fulfillSuccessfulPayment(
      store.db,
      {
        currency: "XTR",
        total_amount: 150,
        invoice_payload: "pack:q150",
        telegram_payment_charge_id: "chg-test-1",
        from: { id: USER.id },
      },
      DOCUMIND_CATALOG,
    );
    expect(fulfillment.status).toBe("credited");
    for (let i = 9; i <= 18; i++) {
      await worker.fetch(webhook(cmdUpdate(i, "/ask garantia multa")), env() as never);
    }
    const res = await worker.fetch(webhook(cmdUpdate(19, "/ask garantia multa")), env() as never);
    expect(res.status).toBe(200);
    expect(sent.at(-1)).toContain("saldo restante");
    expect(store.balances.get(USER.id)).toBe(149); // 150 granted - 1 spent
  });

  it("/use pins a doc, /forget deletes doc+chunks, /docs lists", async () => {
    const bytes = await buildPdfBytes();
    globalThis.fetch = makeCaptureFetch({ sent, fileBytes: bytes }) as never;
    await worker.fetch(webhook(docUpdate(21)), env() as never);
    await worker.fetch(webhook(cmdUpdate(22, "/use 1")), env() as never);
    expect(kvMap.get("dm:active:777")).toBe("1");
    await worker.fetch(webhook(cmdUpdate(23, "/docs")), env() as never);
    expect(sent.at(-1)).toContain("📚");
    await worker.fetch(webhook(cmdUpdate(24, "/forget 1")), env() as never);
    expect(store.docs).toHaveLength(0);
    expect(store.chunks).toHaveLength(0);
  });

  it("/ask without any document replies honestly", async () => {
    await worker.fetch(webhook(cmdUpdate(25, "/ask qualquer coisa")), env() as never);
    expect(sent.at(-1)).toContain("Me manda um documento");
  });
});
