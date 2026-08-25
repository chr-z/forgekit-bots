/**
 * documind/ingest — document intake pipeline (DI-friendly, no globals).
 *
 * Telegram bot flow: file_id -> getFile -> download URL (bot token scoped,
 * hard 20MB cap on the Bot API itself) -> sniff format -> extract text ->
 * chunk -> persist (dm_docs + dm_chunks). Every failure mode maps to a
 * stable reason string the worker translates into an honest user message;
 * nothing is persisted unless extraction yields usable text.
 */

import { extractDocxText } from "./docx";
import { extractPdfText } from "./pdf";
import { buildIndex } from "./rag";

export const MAX_DOC_BYTES = 20 * 1024 * 1024; // Bot API download ceiling
export const MAX_INDEX_CHARS = 60_000; // keeps D1 rows + AI prompts sane

export type IngestReason =
  | "too_large"
  | "unsupported_format"
  | "no_text"
  | "failed";

export interface IngestResult {
  ok: boolean;
  reason?: IngestReason;
  doc?: {
    id: number;
    title: string;
    nPages: number;
    nChunks: number;
    chars: number;
    truncated: boolean;
  };
}

export interface TgFileInfo {
  file_path?: string;
}

/** Guess (format, title) from the Telegram document attachment metadata. */
export function classifyAttachment(doc: {
  file_name?: string;
  mime_type?: string;
}): { kind: "pdf" | "docx" | "text" | null; title: string } {
  const name = (doc.file_name ?? "").trim();
  const lower = name.toLowerCase();
  const mime = (doc.mime_type ?? "").toLowerCase();
  let kind: "pdf" | "docx" | "text" | null = null;
  if (lower.endsWith(".pdf") || mime === "application/pdf") kind = "pdf";
  else if (lower.endsWith(".docx") || mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    kind = "docx";
  else if (
    mime.startsWith("text/") ||
    /\.(txt|md|csv|log)$/.test(lower) ||
    (!kind && mime === "application/json")
  ) {
    kind = "text";
  }
  return { kind, title: name.replace(/\.[a-z0-9]+$/i, "").slice(0, 120) || "documento" };
}

/** Minimal async D1 surface this module needs (subset of D1Database). */
export interface DocStore {
  prepare(sql: string): {
    bind(...args: unknown[]): {
      run(): Promise<{ meta: { last_row_id?: number } }>;
    };
  };
}

/**
 * Full intake. `fetchImpl` lets tests fake the two Telegram round-trips
 * (getFile JSON + file download) without network.
 */
export async function ingestDocument(
  opts: {
    fileId: string;
    title: string;
    kind: "pdf" | "docx" | "text";
    userId: number;
    botToken: string;
  },
  deps: {
    fetchImpl: typeof fetch;
    db: DocStore;
    decompress?: typeof import("./pdf").inflateDeflate;
  },
): Promise<IngestResult> {
  // 1) Resolve the download path via getFile.
  let filePath: string;
  try {
    const res = await deps.fetchImpl(
      `https://api.telegram.org/bot${opts.botToken}/getFile?file_id=${encodeURIComponent(opts.fileId)}`,
    );
    const json = (await res.json()) as { result?: TgFileInfo };
    filePath = json.result?.file_path ?? "";
  } catch {
    return { ok: false, reason: "failed" };
  }
  if (!filePath) return { ok: false, reason: "failed" };

  // 2) Download the bytes (Bot API caps at 20MB — anything above fails here).
  let bytes: Uint8Array;
  try {
    const res = await deps.fetchImpl(`https://api.telegram.org/file/bot${opts.botToken}/${filePath}`);
    if (!res.ok) return res.status === 413 ? { ok: false, reason: "too_large" } : { ok: false, reason: "failed" };
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_DOC_BYTES) return { ok: false, reason: "too_large" };
    bytes = new Uint8Array(buf);
  } catch {
    return { ok: false, reason: "failed" };
  }

  // 3) Extract text — sniff the magic bytes instead of trusting the mime.
  let pageTexts: string[];
  try {
    if (opts.kind === "pdf") {
      const head = String.fromCharCode(...bytes.subarray(0, 5));
      if (head !== "%PDF-") return { ok: false, reason: "unsupported_format" };
      const extracted = await extractPdfText(bytes, { decompress: deps.decompress });
      pageTexts = extracted.pages;
    } else if (opts.kind === "docx") {
      // OOXML containers: PK\x03\x04 magic, else honest unsupported (same
      // anti-spoofing stance as the PDF magic check above).
      const head = String.fromCharCode(...bytes.subarray(0, 2));
      if (head !== "PK") return { ok: false, reason: "unsupported_format" };
      try {
        const extracted = await extractDocxText(bytes);
        pageTexts = extracted.pages;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        return { ok: false, reason: msg === "no_text" ? "no_text" : "failed" };
      }
    } else {
      const text = new TextDecoder().decode(bytes);
      pageTexts = text ? [text] : [];
    }
  } catch {
    return { ok: false, reason: "failed" };
  }

  const totalChars = pageTexts.reduce((n, p) => n + p.length, 0);
  if (totalChars === 0) return { ok: false, reason: "no_text" };

  // 4) Truncate honestly at the index budget.
  let truncated = false;
  const kept: string[] = [];
  let budget = MAX_INDEX_CHARS;
  for (const page of pageTexts) {
    if (budget <= 0) {
      truncated = true;
      break;
    }
    if (page.length > budget) {
      kept.push(page.slice(0, budget));
      budget = 0;
      truncated = true;
    } else {
      kept.push(page);
      budget -= page.length;
    }
  }

  // 5) Persist doc + numbered chunks in one shot.
  const chunks = buildIndex(kept);
  try {
    const ins = deps.db
      .prepare("INSERT INTO dm_docs (tg_user_id, title, n_pages, n_chunks) VALUES (?, ?, ?, ?)")
      .bind(opts.userId, opts.title, kept.length, chunks.length);
    const res = await ins.run();
    const docId = res.meta.last_row_id ?? 0;
    for (const c of chunks) {
      await deps.db.prepare("INSERT INTO dm_chunks (doc_id, n, text) VALUES (?, ?, ?)").bind(docId, c.n, c.text).run();
    }
    return {
      ok: true,
      doc: {
        id: docId,
        title: opts.title,
        nPages: kept.length,
        nChunks: chunks.length,
        chars: Math.min(totalChars, MAX_INDEX_CHARS),
        truncated,
      },
    };
  } catch {
    return { ok: false, reason: "failed" };
  }
}
