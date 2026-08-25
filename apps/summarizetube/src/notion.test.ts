import { describe, expect, it } from "vitest";
import {
  buildChildren,
  notionTokenKey,
  parseConnectArgs,
  parseNotionPageId,
  pushToNotion,
  type NotionSummaryDoc,
} from "./notion";

const DOC: NotionSummaryDoc = {
  title: "Aula completa de fundamentos",
  author: "@prof",
  durationSeconds: 3725,
  tldr: "Resumo com acentuação: informação, código e ação.",
  bullets: ["Primeiro ponto", "Segundo ponto"],
};

/** Records requests and replays canned Notion API responses. */
function notionFetch(responses: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    return new Response(JSON.stringify(r?.body ?? {}), {
      status: r?.status ?? 500,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("parseNotionPageId", () => {
  it("accepts bare ids, dashed UUIDs and notion.so URLs", () => {
    expect(parseNotionPageId("0f3f2a1b6c7d4e5f8091a2b3c4d5e6f7")).toBe(
      "0f3f2a1b-6c7d-4e5f-8091-a2b3c4d5e6f7",
    );
    expect(parseNotionPageId("0F3F2A1B-6C7D-4E5F-8091-A2B3C4D5E6F7")).toBe(
      "0f3f2a1b-6c7d-4e5f-8091-a2b3c4d5e6f7",
    );
    expect(
      parseNotionPageId(
        "https://www.notion.so/Minha-Página-0f3f2a1b6c7d4e5f8091a2b3c4d5e6f7?pvs=4",
      ),
    ).toBe("0f3f2a1b-6c7d-4e5f-8091-a2b3c4d5e6f7");
    expect(parseNotionPageId("https://nota.so/random")).toBeNull();
    expect(parseNotionPageId("")).toBeNull();
  });
});

describe("parseConnectArgs", () => {
  it("splits token + page ref and rejects garbage without echoing input", () => {
    const ok = parseConnectArgs("secret_ABC123 https://notion.so/Page-deadbeef00112233445566778899aabb");
    expect(ok).toEqual({
      token: "secret_ABC123",
      parentId: "deadbeef-0011-2233-4455-66778899aabb",
    });
    expect(parseConnectArgs("only-token")).toBeNull();
    expect(parseConnectArgs("   ")).toBeNull();
  });
});

describe("buildChildren", () => {
  it("emits meta callout, TLDR heading + paragraph and one bullet block each", () => {
    const blocks = buildChildren(DOC) as Array<Record<string, any>>;
    const types = blocks.map((b) => b.type);
    expect(types[0]).toBe("callout");
    expect(JSON.stringify(blocks[0])).toContain("@prof");
    expect(JSON.stringify(blocks[0])).toContain("1:02:05");
    expect(types.filter((t) => t === "heading_2").length).toBe(2);
    const para = blocks.find((b) => b.type === "paragraph");
    expect(para!.paragraph.rich_text[0].text.content).toContain("informação, código e ação");
    const bullets = blocks.filter((b) => b.type === "bulleted_list_item");
    expect(bullets.length).toBe(2);
    expect(bullets[0]!.bulleted_list_item.rich_text[0].text.content).toBe("Primeiro ponto");
  });

  it("omits empty TLDR section and truncates pathological bullets", () => {
    const blocks = buildChildren({ tldr: "", bullets: ["x".repeat(3000)] }) as Array<
      Record<string, any>
    >;
    expect(blocks.some((b) => JSON.stringify(b).includes('"content":"TLDR"'))).toBe(false);
    const bullet = blocks.find((b) => b.type === "bulleted_list_item")!;
    expect(bullet.bulleted_list_item.rich_text[0].text.content.length).toBeLessThanOrEqual(1900);
    expect(bullet.bulleted_list_item.rich_text[0].text.content.endsWith("…")).toBe(true);
  });
});

describe("pushToNotion", () => {
  it("creates a child page under the given parent with auth headers and returns its url", async () => {
    const { fn, calls } = notionFetch([
      { status: 200, body: { id: "page-1", url: "https://notion.so/page-1" } },
    ]);
    const out = await pushToNotion("tok", "parent-id", DOC, fn);
    expect(out).toEqual({ url: "https://notion.so/page-1" });
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("https://api.notion.com/v1/pages");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok");
    expect(headers["Notion-Version"]).toBe("2022-06-28");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.parent.page_id).toBe("parent-id");
    expect(body.properties.title.title[0].text.content).toContain("Aula completa");
    expect(body.children.length).toBeGreaterThan(2);
  });

  it("returns null on HTTP errors, missing url and network failures", async () => {
    const bad = notionFetch([{ status: 401, body: { code: "unauthorized" } }]);
    expect(await pushToNotion("tok", "p", DOC, bad.fn)).toBeNull();

    const nourl = notionFetch([{ status: 200, body: { id: "x" } }]);
    expect(await pushToNotion("tok", "p", DOC, nourl.fn)).toBeNull();

    const boom = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    expect(await pushToNotion("tok", "p", DOC, boom)).toBeNull();
  });

  it("chunks >100 blocks into create + append batches of at most 100", async () => {
    const big: NotionSummaryDoc = { ...DOC, bullets: Array.from({ length: 150 }, (_, i) => `b${i}`) };
    const { fn, calls } = notionFetch([
      { status: 200, body: { id: "big-page", url: "https://notion.so/big-page" } },
      { status: 200 },
      { status: 200 },
    ]);
    const out = await pushToNotion("tok", "parent", big, fn);
    expect(out).toEqual({ url: "https://notion.so/big-page" });
    expect(calls.length).toBe(3); // 1 create + 2 append batches (99 + 51)
    const createBody = JSON.parse(String(calls[0]!.init.body));
    expect(createBody.children).toBeUndefined();
    const batch1 = JSON.parse(String(calls[1]!.init.body));
    const batch2 = JSON.parse(String(calls[2]!.init.body));
    expect(batch1.children.length).toBe(99);
    expect(batch2.children.length).toBe(buildChildren(big).length - 99);
    expect(batch1.children.length + batch2.children.length).toBe(buildChildren(big).length);
    expect(calls[1]!.url).toContain("/blocks/big-page/children");
  });
});

describe("kv helpers", () => {
  it("namespaces tokens per user", () => {
    expect(notionTokenKey(42)).toBe("summarizetube:notion:42");
  });
});
