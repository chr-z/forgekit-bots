import { beforeEach, describe, expect, it } from "vitest";
import { default as worker, transcriptDocKey } from "./index";

const USER = { id: 321, is_bot: false, language_code: "pt-BR" };
const CHAT = { id: 42, type: "private" };

let kvMap: Map<string, string>;
let d1Rows: Map<number, string>;

function env(): Record<string, unknown> {
  return {
    TELEGRAM_BOT_TOKEN: "TESTTOKEN",
    WEBHOOK_SECRET: "s3cret",
    KV: {
      get: async (k: string) => kvMap.get(k) ?? null,
      put: async (k: string, v: string, _opts?: unknown) => {
        kvMap.set(k, v);
      },
      delete: async (k: string) => {
        kvMap.delete(k);
      },
    },
    DB: {
      prepare: (_sql: string) => ({
        bind: (id: number) => ({
          first: async () => {
            const proUntil = d1Rows.get(id);
            return proUntil ? { pro_until: proUntil } : null;
          },
        }),
      }),
    } as unknown as D1Database,
    AI: undefined,
  };
}

function webhook(body: unknown): Request {
  return new Request("https://st.bot/hook", {
    method: "POST",
    headers: { "X-Telegram-Bot-Api-Secret-Token": "s3cret", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function cmdUpdate(text: string): unknown {
  return { update_id: Date.now(), message: { message_id: 7, from: USER, chat: CHAT, text } };
}

/** Captures outgoing Telegram calls; sendDocument exposes the multipart body. */
interface SentDoc {
  name: string;
  body: ArrayBuffer;
}
function captureFetch(
  sentTexts: string[],
  docs: SentDoc[],
): typeof fetch {
  return (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    if (url.includes("/sendMessage")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
      sentTexts.push(String(body.text ?? ""));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    }
    if (url.includes("/sendDocument")) {
      const form = init?.body as FormData;
      const file = form.get("document") as File;
      docs.push({ name: file.name, body: await file.arrayBuffer() });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 2 } }));
    }
    return new Response(JSON.stringify({ ok: true, result: {} }));
  }) as unknown as typeof fetch;
}

const SHORT_DOC = {
  title: "Aula completa",
  author: "@prof",
  durationSeconds: 3725,
  languageCode: "pt-BR",
  text: "Primeira frase da aula.\nSegunda frase com mais contexto.",
};

const LONG_PARAGRAPHS = Array.from({ length: 400 }, (_, i) => `Bloco ${i}: frase com algumas palavras.`);
const LONG_DOC = {
  title: "Aula longa demais pro chat",
  author: "@canal",
  durationSeconds: 9000,
  languageCode: "en",
  text: LONG_PARAGRAPHS.join("\n"),
};

beforeEach(() => {
  kvMap = new Map();
  d1Rows = new Map();
});

describe("/transcript gating", () => {
  it("is refused to free users and never touches the network", async () => {
    const sent: string[] = [];
    const docs: SentDoc[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = captureFetch(sent, docs);
    try {
      kvMap.set(transcriptDocKey(USER.id), JSON.stringify(SHORT_DOC));
      const res = await worker.fetch(webhook(cmdUpdate("/transcript")), env() as never);
      expect(res.status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("Pro");
      expect(docs).toHaveLength(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("answers transcript_nothing when nothing was summarized yet", async () => {
    const sent: string[] = [];
    const docs: SentDoc[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = captureFetch(sent, docs);
    try {
      d1Rows.set(USER.id, new Date(Date.now() + 86400_000).toISOString()); // Pro
      const res = await worker.fetch(webhook(cmdUpdate("/transcript txt")), env() as never);
      expect(res.status).toBe(200);
      expect(sent[0]).toContain("recent");
      expect(docs).toHaveLength(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("/transcript delivery", () => {
  it("delivers short transcripts fully inline", async () => {
    const sent: string[] = [];
    const docs: SentDoc[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = captureFetch(sent, docs);
    try {
      d1Rows.set(USER.id, new Date(Date.now() + 86400_000).toISOString()); // Pro
      kvMap.set(transcriptDocKey(USER.id), JSON.stringify(SHORT_DOC));
      const res = await worker.fetch(webhook(cmdUpdate("/transcript")), env() as never);
      expect(res.status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(docs).toHaveLength(0);
      expect(sent[0]).toContain("📹 Aula completa");
      expect(sent[0]).toContain("🌐 pt-BR");
      expect(sent[0]).toContain("Primeira frase da aula.");
      expect(sent[0]).toContain("Segunda frase com mais contexto.");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("previews long transcripts and follows with a .txt document", async () => {
    const sent: string[] = [];
    const docs: SentDoc[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = captureFetch(sent, docs);
    try {
      d1Rows.set(USER.id, new Date(Date.now() + 86400_000).toISOString()); // Pro
      kvMap.set(transcriptDocKey(USER.id), JSON.stringify(LONG_DOC));
      const res = await worker.fetch(webhook(cmdUpdate("/transcript")), env() as never);
      expect(res.status).toBe(200);
      expect(sent).toHaveLength(1); // preview message
      expect(docs).toHaveLength(1); // .txt file
      expect(docs[0]!.name).toBe("Aula longa demais pro chat.txt");
      expect(sent[0]).toContain("(+");
      expect(sent[0]).toContain("caracteres no total"); // pt-BR locale
      expect(sent[0]).toContain("Bloco 0:");
      expect(sent[0]).not.toContain("Bloco 399:");
      const txt = new TextDecoder().decode(new Uint8Array(docs[0]!.body));
      expect(txt).toContain("Title: Aula longa demais pro chat");
      expect(txt).toContain("Duration: 2:30:00");
      expect(txt).toContain("Bloco 399: frase com algumas palavras.");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("renders /transcript pdf as a real PDF named after the video", async () => {
    const sent: string[] = [];
    const docs: SentDoc[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = captureFetch(sent, docs);
    try {
      d1Rows.set(USER.id, new Date(Date.now() + 86400_000).toISOString()); // Pro
      kvMap.set(transcriptDocKey(USER.id), JSON.stringify(SHORT_DOC));
      const res = await worker.fetch(webhook(cmdUpdate("/transcript PDF")), env() as never);
      expect(res.status).toBe(200);
      expect(sent).toHaveLength(0); // silent success: only the file goes out
      expect(docs).toHaveLength(1);
      expect(docs[0]!.name).toBe("Aula completa - transcript.pdf");
      const rawHead = Buffer.from(docs[0]!.body.slice(0, 8)).toString("latin1");
      expect(rawHead.startsWith("%PDF-1.4")).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("sanitizes hostile video titles in both file names", async () => {
    const docs: SentDoc[] = [];
    const sent: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = captureFetch(sent, docs);
    try {
      d1Rows.set(USER.id, new Date(Date.now() + 86400_000).toISOString()); // Pro
      kvMap.set(
        transcriptDocKey(USER.id),
        JSON.stringify({ ...LONG_DOC, title: "../../evi l$(x)" }),
      );
      await worker.fetch(webhook(cmdUpdate("/transcript txt")), env() as never);
      expect(docs[0]!.name).not.toContain("/");
      expect(docs[0]!.name).not.toContain("..");
      expect(docs[0]!.name.endsWith(".txt")).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
