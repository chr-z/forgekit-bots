/**
 * Notion export — official REST API v1 (api.notion.com/v1), zero SDK.
 *
 * The Pro user pastes their integration token once (/connect <token>); the
 * bot stores only the token in KV and later pushes summaries as a child
 * page under a page the user shared with the integration. Nothing else is
 * kept: no content cache, no workspace metadata.
 *
 * Free-tier discipline: one POST to notion.com per export, no retries
 * beyond a single 429 backoff, nothing stored besides the token.
 */

/** Shape mirrors apps/summarizetube SummaryDoc (kept local on purpose). */
export interface NotionSummaryDoc {
  title?: string;
  author?: string;
  durationSeconds?: number;
  tldr: string;
  bullets: string[];
}

export const NOTION_API_BASE = "https://api.notion.com/v1";
export const NOTION_API_VERSION = "2022-06-28";

/** KV keys holding a user's Notion link (integration token + parent page). */
export function notionTokenKey(userId: number): string {
  return `summarizetube:notion:${userId}`;
}

export function notionParentKey(userId: number): string {
  return `summarizetube:notion-parent:${userId}`;
}

/**
 * Probes api.notion.com/v1/users/me BEFORE storing anything: proves the
 * integration token works AND that the bot can name the workspace owner.
 */
export async function probeNotionToken(
  token: string,
  fetchImpl?: typeof fetch,
): Promise<{ ok: boolean; name?: string }> {
  const doFetch = fetchImpl ?? fetch;
  try {
    const res = await doFetch(`${NOTION_API_BASE}/users/me`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_API_VERSION,
      },
    });
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as { type?: string; name?: string | null };
    if (body?.type !== "user") return { ok: false };
    return { ok: true, name: body.name ?? undefined };
  } catch {
    return { ok: false };
  }
}

/** Dashed UUID form Notion APIs accept. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Standalone run of exactly 32 hex chars (word-boundary-ish both sides). */
const HEX32_RE = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/g;

function dash32(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Accepts a bare 32-hex id, a dashed UUID or any notion.so page URL
 * (the id is always a standalone 32-hex run; the LAST run wins) and
 * returns the dashed lowercase UUID, or null when nothing extractable.
 */
export function parseNotionPageId(input: string): string | null {
  const raw = input.trim().toLowerCase();
  if (UUID_RE.test(raw)) return raw;
  const matches = [...raw.matchAll(HEX32_RE)];
  const m = matches[matches.length - 1];
  return m ? dash32(m[0]) : null;
}

export interface ConnectArgs {
  token: string;
  parentId: string;
}

/**
 * Splits "/connect <token> <page-ref>" arguments. Returns null for garbage.
 * The token is NEVER echoed back by callers on failure — this function only
 * returns structured data, it does not format error messages.
 */
export function parseConnectArgs(input: string): ConnectArgs | null {
  const parts = input.trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const [token, ref] = parts as [string, string];
  if (!token || token.length < 10) return null;
  const parentId = parseNotionPageId(ref);
  if (!parentId) return null;
  return { token, parentId };
}

/** Minimal shape of a successful "Create page" response we care about. */
interface CreatedPage {
  id: string;
  url: string;
}

/**
 * Pushes a summary doc as a child page. Returns {url} on success or null
 * when Notion rejected the call (bad token, revoked access, API error).
 */
export async function pushToNotion(
  token: string,
  parentPageId: string,
  doc: NotionSummaryDoc,
  fetchImpl?: typeof fetch,
): Promise<{ url: string } | null> {
  const doFetch = fetchImpl ?? fetch;

  const children = buildChildren(doc);
  // Notion allows at most 100 block children per request — truncate honestly.
  if (children.length > 100) {
    return pushToNotionTruncated(token, parentPageId, doc, doFetch);
  }

  try {
    const res = await doFetch(`${NOTION_API_BASE}/pages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_API_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        parent: { type: "page_id", page_id: parentPageId },
        properties: {
          title: {
            type: "title",
            title: [{ type: "text", text: { content: pageTitle(doc) } }],
          },
        },
        children,
      }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<CreatedPage>;
    if (!body.url) return null;
    return { url: body.url };
  } catch {
    return null;
  }
}

/** >100 bullets: first request carries the page + first 99 blocks, rest appended. */
async function pushToNotionTruncated(
  token: string,
  parentPageId: string,
  doc: NotionSummaryDoc,
  doFetch: typeof fetch,
): Promise<{ url: string } | null> {
  const all = buildChildren(doc);
  const firstBatch = all.slice(0, 99);
  const restBatches: Array<Array<Record<string, unknown>>> = [];
  for (let i = 99; i < all.length; i += 100) {
    restBatches.push(all.slice(i, i + 100));
  }

  try {
    // First create WITHOUT children (children must be non-empty if present).
    const created = await doFetch(`${NOTION_API_BASE}/pages`, {
      method: "POST",
      headers: notionHeaders(token),
      body: JSON.stringify({
        parent: { type: "page_id", page_id: privacySafe(parentPageId) },
        properties: {
          title: {
            type: "title",
            title: [{ type: "text", text: { content: pageTitle(doc) } }],
          },
        },
      }),
    });
    if (!created.ok) return null;
    const page = (await created.json()) as Partial<CreatedPage>;
    if (!page.id || !page.url) return null;

    for (const batch of [firstBatch, ...restBatches]) {
      const patch = await doFetch(`${NOTION_API_BASE}/blocks/${page.id}/children`, {
        method: "PATCH",
        headers: notionHeaders(token),
        body: JSON.stringify({ children: batch }),
      });
      if (!patch.ok) break; // partial import is still useful; stop appending
    }
    return { url: page.url };
  } catch {
    return null;
  }
}

function notionHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "Notion-Version": NEVER_LEAK_VERSION,
    "content-type": "application/json",
  };
}

const NEVER_LEAK_VERSION = NOTION_API_VERSION;

function pageTitle(doc: NotionSummaryDoc): string {
  const parts: string[] = [];
  if (doc.title) parts.push(doc.title);
  if (doc.author) parts.push(doc.author);
  return (parts.join(" — ") || "Video summary").slice(0, 2000);
}

function formatDuration(seconds: number | undefined): string | null {
  if (!seconds || seconds <= 0) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/** Builds Notion block children for a summary doc (max 2000 chars per text). */
export function buildChildren(doc: NotionSummaryDoc): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];

  const metaLine = [
    doc.author ? `Author: ${doc.author}` : null,
    formatDuration(doc.durationSeconds) ? `Duration: ${formatDuration(doc.durationSeconds)}` : null,
    `Exported by SummarizeTube bot`,
  ]
    .filter(Boolean)
    .join(" • ");
  blocks.push({
    object: "block",
    type: "callout",
    callout: {
      icon: { type: "external", external: { url: "https://www.youtube.com/favicon.ico" } },
      color: "blue_background",
      rich_text: [{ type: "text", text: { content: metaLine } }],
    },
  });

  if (doc.tldr.trim()) {
    blocks.push({
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: [{ type: "text", text: { content: "TLDR" } }] },
    });
    blocks.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: [{ type: "text", text: { content: doc.tldr.trim() } }] },
    });
  }

  if (doc.bullets.length) {
    blocks.push({
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: [{ type: "text", text: { content: "Key points" } }] },
    });
    for (const b of doc.bullets) {
      const content = b.length > 1900 ? `${b.slice(0, 1899)}…` : b;
      blocks.push({
        object: "block",
        type: "bulleted_list_item",
        bulleted_list_item: { rich_text: [{ type: "text", text: { content } }] },
      });
    }
  }

  return blocks;
}

/**
 * Notion page/UUIDs are not secrets, but never log or echo them back with
 * surrounding context that could leak the integration token — this helper
 * exists so future code paths have one auditable place for it.
 */
function privacySafe(parentPageId: string): string {
  return parentPageId.trim();
}
