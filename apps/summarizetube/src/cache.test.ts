import { beforeEach, describe, expect, it } from "vitest";
import { default as worker, FREE_DAILY_LIMIT, lastDocKey, transcriptDocKey } from "./index";
import { loadCachedSummary, saveCachedSummary, summaryCacheKey } from "./cache";

const USER = { id: 777, is_bot: false, language_code: "pt-BR" };
const CHAT = { id: 99, type: "private" };
const VIDEO_ID = "dQw4w9WgXcQ";
const VIDEO_URL = `https://youtu.be/${VIDEO_ID}`;

const WATCH_HTML = `<html><script>
var ytInitialPlayerResponse = {
  videoDetails: { title: "Aula completa", author: "@prof", lengthSeconds: "3725" },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        { baseUrl: "https://www.youtube.com/api/timedtext?lang=pt-BR&v=${VIDEO_ID}", languageCode: "pt-BR" }
      ]
    }
  }
};
</script></html>`;

function makeCues(): string {
  const events = Array.from({ length: 30 }, (_, i) => ({
    tStartMs: i * 2000,
    dDurationMs: 1900,
    segs: [{ utf8: `Frase da aula numero ${i}. [${i}]` }],
  }));
  return JSON.stringify({ events });
}

let aiCalls: number;
let ytFetches: number;

function makeAi(): Ai {
  return {
    run: async (): Promise<unknown> => {
      aiCalls++;
      return { response: "TLDR: Aula sobre fundamentos.\n- ponto com [00:12]" };
    },
  } as unknown as Ai;
}

/** Routes telegram + youtube calls; counts upstream (youtube) fetches. */
function captureFetch(sentTexts: string[]): typeof fetch {
  return (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    if (url.includes("api.telegram.org")) {
      if (url.includes("/sendMessage")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
        sentTexts.push(String(body.text ?? ""));
      }
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    }
    if (url.includes("/watch?v=")) {
      ytFetches++;
      return new Response(WATCH_HTML, { status: 200 });
    }
    if (url.includes("/api/timedtext")) {
      ytFetches++;
      return new Response(makeCues(), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true, result: {} }));
  }) as unknown as typeof fetch;
}

let kvMap: Map<string, string>;
let d1Rows: Map<number, string>;

beforeEach(() => {
  kvMap = new Map();
  d1Rows = new Map();
  aiCalls = 0;
  ytFetches = 0;
});

describe("summary replay cache", () => {
  it("round-trips through KV and rejects junk on load", async () => {
    const kv = {
      get: async (k: string) => kvMap.get(k) ?? null,
      put: async (k: string, v: string) => {
        kvMap.set(k, v);
      },
    } as unknown as KVNamespace;
    await saveCachedSummary(kv, VIDEO_ID, {
      deep: false,
      reply: "R",
      doc: { tldr: "t", bullets: [] },
      transcript: { text: "x" },
    });
    expect(await loadCachedSummary(kv, VIDEO_ID)).toMatchObject({ reply: "R", deep: false });
    expect(await loadCachedSummary(kv, "other-video")).toBeNull();
    kvMap.set(summaryCacheKey(VIDEO_ID), "{{{broken");
    expect(await loadCachedSummary(kv, VIDEO_ID)).toBeNull();
    kvMap.set(summaryCacheKey(VIDEO_ID), JSON.stringify({ v: 999, reply: "old" }));
    expect(await loadCachedSummary(kv, VIDEO_ID)).toBeNull();
  });
});

/* ---------- webhook e2e ---------- */

function env(): Record<string, unknown> {
  return {
    TELEGRAM_BOT_TOKEN: "TESTTOKEN",
    WEBHOOK_SECRET: "s3cret",
    KV: {
      // Mirrors production KV: get(key, "json") returns the PARSED object.
      get: async (k: string, type?: string) => {
        const raw = kvMap.get(k) ?? null;
        if (raw === null || type !== "json") return raw;
        try {
          return JSON.parse(raw) as unknown;
        } catch {
          return null;
        }
      },
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
    AI: makeAi(),
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

/** Runs one webhook call against the real fetch swap, restoring afterwards. */
async function hook(text: string, sent: string[]): Promise<number> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = captureFetch(sent);
  try {
    const res = await worker.fetch(webhook(cmdUpdate(text)), env() as never);
    return res.status;
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe("/summarize replay behavior", () => {
  it("first run pays the full pipeline (AI + youtube fetches) and stores the cache", async () => {
    const sent: string[] = [];
    expect(await hook(`/summarize ${VIDEO_URL}`, sent)).toBe(200);
    expect(aiCalls).toBe(1);
    expect(ytFetches).toBe(2); // watch page + timedtext
    expect(kvMap.has(summaryCacheKey(VIDEO_ID))).toBe(true);
    expect(sent[0]).toContain("Assistindo");
    expect(sent[1]).toContain("📹 Aula completa");
  });

  it("replay of the same video serves KV with zero AI calls and zero upstream fetches", async () => {
    const sentFirst: string[] = [];
    await hook(`/summarize ${VIDEO_URL}`, sentFirst);
    const storedBefore = kvMap.get(summaryCacheKey(VIDEO_ID));
    expect(storedBefore).toBeTruthy();

    aiCalls = 0;
    ytFetches = 0;
    const sent: string[] = [];
    expect(await hook(`/summarize ${VIDEO_URL}`, sent)).toBe(200);
    expect(aiCalls).toBe(0);
    expect(ytFetches).toBe(0);
    expect(sent).toHaveLength(1); // no "working…" message on a hit
    expect(sent[0]).toContain("♻️ Resumo em cache");
    expect(sent[0]).toContain("📹 Aula completa");
    expect(sent[0]).toContain("💡 Aula sobre fundamentos.");
    expect(kvMap.get(summaryCacheKey(VIDEO_ID))).toBe(storedBefore);
  });

  it("a replay consumes nothing — window and credits stay untouched", async () => {
    await saveCachedSummary(
      {
        get: async (k: string) => kvMap.get(k) ?? null,
        put: async (k: string, v: string) => {
          kvMap.set(k, v);
        },
      } as unknown as KVNamespace,
      VIDEO_ID,
      {
        deep: false,
        reply: "📹 Video\n\n💡 TLDR aqui.\n• ponto [00:01]",
        doc: { tldr: "TLDR aqui.", bullets: ["ponto"] },
        transcript: { text: "x" },
      },
    );
    const allSent: string[] = [];
    for (let i = 0; i < FREE_DAILY_LIMIT + 2; i++) {
      expect(await hook(`/s ${VIDEO_URL}`, allSent)).toBe(200);
      const rlKey = [...kvMap.keys()].find((k) => k.startsWith("rl:"));
      expect(rlKey).toBeUndefined(); // limiter never even wrote a window
    }
    expect(allSent.every((m) => m.includes("♻️"))).toBe(true);
    expect(aiCalls).toBe(0);
  });

  it("fresh requests beyond the free window still hit the quota wall", async () => {
    const sent: string[] = [];
    for (let i = 0; i < FREE_DAILY_LIMIT + 1; i++) {
      await hook(`/s https://youtu.be/fresh${i}xyz01`, sent);
    }
    expect(sent.filter((m) => m.includes("Assistindo"))).toHaveLength(FREE_DAILY_LIMIT);
    expect(sent.some((m) => m.includes("Limite diário grátis atingido"))).toBe(true);
    expect(kvMap.has(summaryCacheKey("fresh0xyz01"))).toBe(true); // first run cached
  });

  it("pro replay refreshes both perk docs from the cached payload and stays unlimited", async () => {
    d1Rows.set(USER.id, new Date(Date.now() + 86400_000).toISOString()); // Pro
    await saveCachedSummary(
      {
        get: async (k: string) => kvMap.get(k) ?? null,
        put: async (k: string, v: string) => {
          kvMap.set(k, v);
        },
      } as unknown as KVNamespace,
      VIDEO_ID,
      {
        deep: false,
        reply: "📹 Aula completa\n\n💡 TLDR.\n• ponto [00:01]",
        doc: { title: "Aula completa", tldr: "TLDR.", bullets: [] },
        transcript: { title: "Aula completa", text: "transcricao" },
      },
    );
    const sent: string[] = [];
    expect(await hook(`/summarize ${VIDEO_URL}`, sent)).toBe(200);
    expect(aiCalls).toBe(0);
    expect(sent).toHaveLength(1); // cached summary, NO quota nag (pro is unlimited)
    expect(sent[0]).toContain("♻️ Resumo em cache");
    expect(kvMap.has(lastDocKey(USER.id))).toBe(true);
    expect(kvMap.has(transcriptDocKey(USER.id))).toBe(true);
  });
});
