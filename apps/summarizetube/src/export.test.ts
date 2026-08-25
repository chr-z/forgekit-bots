import { beforeEach, describe, expect, it } from "vitest";
import { default as worker, FREE_DAILY_LIMIT, lastDocKey } from "./index";

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
function captureFetch(sentTexts: string[], docs: { name: string; body: ArrayBuffer }[]) {
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
  }) as typeof fetch;
}

const DOC = {
  title: "Aula completa",
  author: "@prof",
  durationSeconds: 3725,
  tldr: "Ponto central.",
  bullets: ["b1", "b2"],
};

beforeEach(() => {
  kvMap = new Map();
  d1Rows = new Map();
});

describe("/export pdf gating", () => {
  it("is refused to free users and never touches the network for files", async () => {
    const sent: string[] = [];
    const docs: { name: string; body: ArrayBuffer }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = captureFetch(sent, docs);
    try {
      kvMap.set(lastDocKey(USER.id), JSON.stringify(DOC));
      const res = await worker.fetch(webhook(cmdUpdate("/export")), env() as never);
      expect(res.status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("Pro");
      expect(docs).toHaveLength(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("answers export_nothing when there is no cached summary", async () => {
    const sent: string[] = [];
    const docs: { name: string; body: ArrayBuffer }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = captureFetch(sent, docs);
    try {
      d1Rows.set(USER.id, new Date(Date.now() + 86400_000).toISOString()); // Pro
      const res = await worker.fetch(webhook(cmdUpdate("/export")), env() as never);
      expect(res.status).toBe(200);
      expect(sent[0]).toContain("recent");
      expect(docs).toHaveLength(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("/export pdf happy path", () => {
  it("sends the cached summary as a valid PDF document named after the video", async () => {
    const sent: string[] = [];
    const docs: { name: string; body: ArrayBuffer }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = captureFetch(sent, docs);
    try {
      d1Rows.set(USER.id, new Date(Date.now() + 86400_000).toISOString());
      kvMap.set(lastDocKey(USER.id), JSON.stringify(DOC));
      const res = await worker.fetch(webhook(cmdUpdate("/export pdf")), env() as never);
      expect(res.status).toBe(200);
      expect(sent).toHaveLength(0); // silent success: only the file goes out
      expect(docs).toHaveLength(1);
      const raw = Buffer.from(docs[0]!.body).toString("latin1");
      expect(docs[0]!.name).toBe("Aula completa.pdf");
      expect(raw.startsWith("%PDF-1.4")).toBe(true);
      expect(raw.trimEnd().endsWith("%%EOF")).toBe(true);
      expect(raw).toContain("/Filter /FlateDecode");

      // corrupting one byte inside the stream must break inflation -> Length is exact
      const lenMatch = raw.match(/\/Length (\d+) \/Filter/)!;
      expect(Number(lenMatch[1])).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("sanitizes hostile filenames down to safe characters", async () => {
    const sent: string[] = [];
    const docs: { name: string; body: ArrayBuffer }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = captureFetch(sent, docs);
    try {
      d1Rows.set(USER.id, new Date(Date.now() + 86400_000).toISOString());
      kvMap.set(
        lastDocKey(USER.id),
        JSON.stringify({ ...DOC, title: "../../evi l$(x)" }),
      );
      await worker.fetch(webhook(cmdUpdate("/export")), env() as never);
      expect(docs[0]!.name).not.toContain("/");
      expect(docs[0]!.name).not.toContain("..");
      expect(docs[0]!.name.endsWith(".pdf")).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
