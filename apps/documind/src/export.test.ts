import { beforeEach, describe, expect, it } from "vitest";
import { default as worker, lastAnswerKey } from "./index";
import { buildPdfBytes, makeCaptureFetch, makeDocD1 } from "./testhelpers";

const USER = { id: 777, is_bot: false, language_code: "pt-BR" };
const CHAT = { id: 42, type: "private" };

let store: ReturnType<typeof makeDocD1>;
let sent: string[];
let docs: { name: string; body: ArrayBuffer }[];
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

function cmdUpdate(id: number, text: string): unknown {
  return { update_id: id, message: { message_id: id, from: USER, chat: CHAT, text } };
}

function makePro(): void {
  store.subs.set(USER.id, new Date(Date.now() + 86400_000).toISOString());
}

/** Ingest the fixture PDF and get one cited answer into the chat (real flow). */
async function ingestAndAsk(startId: number): Promise<void> {
  const bytes = await buildPdfBytes();
  globalThis.fetch = makeCaptureFetch({ sent, docs, fileBytes: bytes }) as never;
  const docMsg = {
    update_id: startId,
    message: {
      message_id: startId,
      from: USER,
      chat: CHAT,
      document: {
        file_id: `F${startId}`,
        file_name: "contrato.pdf",
        mime_type: "application/pdf",
        file_size: 1024,
      },
    },
  };
  await worker.fetch(webhook(docMsg), env() as never);
  expect(store.docs).toHaveLength(1);
  globalThis.fetch = makeCaptureFetch({ sent, docs }) as never;
  await worker.fetch(
    webhook(cmdUpdate(startId + 1, "/ask Qual é o prazo de garantia?")),
    env() as never,
  );
}

beforeEach(() => {
  store = makeDocD1();
  sent = [];
  docs = [];
  kvMap = new Map();
  globalThis.fetch = makeCaptureFetch({ sent, docs }) as never;
});

describe("/export gating & empty states", () => {
  it("refuses free users without touching sendDocument", async () => {
    await worker.fetch(webhook(cmdUpdate(101, "/export pdf")), env() as never);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Pro");
    expect(docs).toHaveLength(0);
  });

  it("replies export_nothing when no question was answered yet", async () => {
    makePro();
    await worker.fetch(webhook(cmdUpdate(102, "/export pdf")), env() as never);
    expect(sent.at(-1)).toContain("pergunta");
    expect(docs).toHaveLength(0);
  });

  it("unknown export kinds fall back to the nothing-yet reply", async () => {
    makePro();
    await worker.fetch(webhook(cmdUpdate(103, "/export docx")), env() as never);
    expect(sent.at(-1)).toContain("pergunta");
    expect(docs).toHaveLength(0);
  });
});

describe("/export happy path through the real ask flow", () => {
  it("caches the answered Q&A on /ask and re-renders it as a valid PDF", async () => {
    makePro();
    await ingestAndAsk(110);
    // The ask flow itself persisted the structured Q&A for export.
    const cached = JSON.parse(kvMap.get(lastAnswerKey(USER.id))!) as {
      docTitle: string;
      question: string;
      answer: string;
      sourcesLine?: string;
    };
    expect(cached.docTitle).toBe("contrato");
    expect(cached.question).toContain("garantia");
    expect(cached.answer).toContain("[1]");
    expect(cached.sourcesLine).toBe("Fontes: p. 1"); // page provenance persists
    expect(sent.some((s) => s.includes("doze meses"))).toBe(true);

    const repliesBefore = sent.length;
    await worker.fetch(webhook(cmdUpdate(112, "/export pdf")), env() as never);
    expect(docs).toHaveLength(1); // silent success: only the file goes out
    expect(sent.length).toBe(repliesBefore);
    expect(docs[0]!.name).toBe("contrato - answers.pdf");
    const raw = Buffer.from(docs[0]!.body).toString("latin1");
    expect(raw.startsWith("%PDF-1.4")).toBe(true);
    expect(raw.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(raw).toContain("/Filter /FlateDecode");
    // The sources line is really rendered inside the PDF content stream.
    const payload = raw.slice(raw.indexOf("stream\n") + 7, raw.lastIndexOf("endstream")).trimEnd();
    const z = new Uint8Array(payload.length);
    for (let i = 0; i < payload.length; i++) z[i] = payload.charCodeAt(i);
    const inflated = await new Response(
      new Blob([z]).stream().pipeThrough(new DecompressionStream("deflate")),
    ).arrayBuffer();
    expect(new TextDecoder().decode(inflated)).toContain("Fontes: p. 1");
  });

  it("sanitizes hostile document titles in the filename", async () => {
    makePro();
    kvMap.set(
      lastAnswerKey(USER.id),
      JSON.stringify({ docTitle: "../../evi l$(x)", question: "q?", answer: "[1] a" }),
    );
    await worker.fetch(webhook(cmdUpdate(120, "/export pdf")), env() as never);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.name).not.toContain("/");
    expect(docs[0]!.name).not.toContain("..");
    expect(docs[0]!.name.endsWith(".pdf")).toBe(true);
  });
});

describe("i18n behavior per locale", () => {
  it("free-user refusal is localized (en + pt-BR)", async () => {
    await worker.fetch(
      webhook({
        update_id: 130,
        message: {
          message_id: 130,
          from: { id: 778, is_bot: false, language_code: "en" },
          chat: CHAT,
          text: "/export",
        },
      }),
      env() as never,
    );
    expect(sent.at(-1)).toContain("PDF export is a Pro feature");
    await worker.fetch(webhook(cmdUpdate(131, "/export")), env() as never);
    expect(sent.at(-1)).toContain("recurso Pro");
  });
});
