import { beforeEach, describe, expect, it } from "vitest";
import { default as worker, lastDocKey } from "./index";
import { notionParentKey, notionTokenKey } from "./notion";

const USER = { id: 321, is_bot: false, language_code: "pt-BR" };
const CHAT = { id: 42, type: "private" };
const TOKEN = "secret_integration_token_abc";
const PARENT_RAW =
  "https://www.notion.so/Resumos-0f3f2a1b6c7d4e5f8091a2b3c4d5e6f7?pvs=4";
const PARENT_DASHED = "0f3f2a1b-6c7d-4e5f-8091-a2b3c4d5e6f7";

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

interface NotionCall {
  url: string;
  init: RequestInit;
}

/**
 * Routes fetch between Telegram captures and canned api.notion.com replies,
 * mirroring what production does through one socket.
 */
function routeFetch(
  sentTexts: string[],
  notionCalls: NotionCall[],
  notionReply?: { status: number; body: unknown },
): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.notion.com")) {
      notionCalls.push({ url, init: init ?? {} });
      const r = notionReply ?? { status: 200, body: {} };
      return new Response(JSON.stringify(r.body), {
        status: r.status,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/sendMessage")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
      sentTexts.push(String(body.text ?? ""));
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    }
    return new Response(JSON.stringify({ ok: true, result: {} }));
  }) as unknown as typeof fetch;
}

const DOC = {
  title: "Aula completa",
  author: "@prof",
  durationSeconds: 3725,
  tldr: "TLDR de teste.",
  bullets: ["Ponto um", "Ponto dois"],
};

function grantPro() {
  d1Rows.set(USER.id, new Date(Date.now() + 86400_000).toISOString());
}

beforeEach(() => {
  kvMap = new Map();
  d1Rows = new Map();
});

describe("/connect gating and validation", () => {
  it("refuses free users before touching the network", async () => {
    const sent: string[] = [];
    const calls: NotionCall[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = routeFetch(sent, calls);
    try {
      const res = await worker.fetch(webhook(cmdUpdate("/connect tok https://notion.so/x")), env() as never);
      expect(res.status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("Pro");
      expect(calls).toHaveLength(0);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("answers connect_invalid on malformed args without any request", async () => {
    const sent: string[] = [];
    const calls: NotionCall[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = routeFetch(sent, calls);
    try {
      grantPro();
      const res = await worker.fetch(webhook(cmdUpdate("/connect only-token")), env() as never);
      expect(res.status).toBe(200);
      expect(sent[0]).toContain("Formato");
      expect(calls).toHaveLength(0);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("probes the token first, stores nothing on rejection and never echoes it", async () => {
    const sent: string[] = [];
    const calls: NotionCall[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = routeFetch(sent, calls, { status: 401, body: { code: "unauthorized" } });
    try {
      grantPro();
      const res = await worker.fetch(
        webhook(cmdUpdate(`/connect ${TOKEN} ${PARENT_RAW}`)),
        env() as never,
      );
      expect(res.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("https://api.notion.com/v1/users/me");
      expect(sent[0]).toContain("recusou");
      expect(kvMap.has(notionTokenKey(USER.id))).toBe(false);
      expect(kvMap.has(notionParentKey(USER.id))).toBe(false);
      for (const msg of sent) expect(msg).not.toContain(TOKEN);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("stores token + dashed parent page after a successful probe", async () => {
    const sent: string[] = [];
    const calls: NotionCall[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = routeFetch(sent, calls, {
      status: 200,
      body: { object: "user", type: "user", name: "Zee" },
    });
    try {
      grantPro();
      const res = await worker.fetch(
        webhook(cmdUpdate(`/connect ${TOKEN} ${PARENT_RAW}`)),
        env() as never,
      );
      expect(res.status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("Conectado ao Notion (Zee)");
      expect(kvMap.get(notionTokenKey(USER.id))).toBe(TOKEN);
      expect(kvMap.get(notionParentKey(USER.id))).toBe(PARENT_DASHED);
      for (const msg of sent) expect(msg).not.toContain(TOKEN);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("/export notion", () => {
  it("asks for /connect when no workspace is linked", async () => {
    const sent: string[] = [];
    const calls: NotionCall[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = routeFetch(sent, calls);
    try {
      grantPro();
      kvMap.set(lastDocKey(USER.id), JSON.stringify(DOC));
      const res = await worker.fetch(webhook(cmdUpdate("/export notion")), env() as never);
      expect(res.status).toBe(200);
      expect(sent[0]).toContain("Nenhum workspace");
      expect(calls).toHaveLength(0);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("pushes the cached summary as a child page and replies with its url", async () => {
    const sent: string[] = [];
    const calls: NotionCall[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = routeFetch(sent, calls, {
      status: 200,
      body: { id: "new-page", url: "https://notion.so/new-page" },
    });
    try {
      grantPro();
      kvMap.set(lastDocKey(USER.id), JSON.stringify(DOC));
      kvMap.set(notionTokenKey(USER.id), TOKEN);
      kvMap.set(notionParentKey(USER.id), PARENT_DASHED);
      const res = await worker.fetch(webhook(cmdUpdate("/export notion")), env() as never);
      expect(res.status).toBe(200);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("Enviado pro Notion");
      expect(sent[0]).toContain("https://notion.so/new-page");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.url).toBe("https://api.notion.com/v1/pages");
      const headers = calls[0]!.init.headers as Record<string, string>;
      expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
      const body = JSON.parse(String(calls[0]!.init.body));
      expect(body.parent.page_id).toBe(PARENT_DASHED);
      const flat = String(calls[0]!.init.body);
      expect(flat).toContain("Aula completa");
      expect(flat).toContain("Ponto um");
      for (const msg of sent) expect(msg).not.toContain(TOKEN);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("maps an API refusal to notion_push_failed without leaking the token", async () => {
    const sent: string[] = [];
    const calls: NotionCall[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = routeFetch(sent, calls, { status: 404, body: { code: "object_not_found" } });
    try {
      grantPro();
      kvMap.set(lastDocKey(USER.id), JSON.stringify(DOC));
      kvMap.set(notionTokenKey(USER.id), TOKEN);
      kvMap.set(notionParentKey(USER.id), PARENT_DASHED);
      const res = await worker.fetch(webhook(cmdUpdate("/export notion")), env() as never);
      expect(res.status).toBe(200);
      expect(sent[0]).toContain("Reconecta");
      expect(calls).toHaveLength(1);
      for (const msg of sent) expect(msg).not.toContain(TOKEN);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("keeps treating unknown export kinds as export_nothing", async () => {
    const sent: string[] = [];
    const calls: NotionCall[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = routeFetch(sent, calls);
    try {
      grantPro();
      kvMap.set(lastDocKey(USER.id), JSON.stringify(DOC));
      const res = await worker.fetch(webhook(cmdUpdate("/export xlsx")), env() as never);
      expect(res.status).toBe(200);
      expect(sent[0]).toContain("recente");
      expect(calls).toHaveLength(0);
    } finally {
      globalThis.fetch = real;
    }
  });
});
