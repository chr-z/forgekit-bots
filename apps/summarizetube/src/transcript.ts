/**
 * summarizetube/transcript — Pro transcript delivery.
 *
 * The summary pipeline already builds a cleaned transcript (one sentence
 * stream deduped against rolling-caption repeats). Until now it was only
 * fed to the AI and discarded. This module turns it into a deliverable:
 * an inline Telegram reply when it fits, otherwise a preview plus a .txt
 * document, and optionally a real PDF via the shared writer.
 */

import { renderPdf } from "./pdf";

/** KV key holding the last transcript of a user (source for /transcript). */
export function transcriptDocKey(userId: number): string {
  return `summarizetube:lasttranscript:${userId}`;
}

/** Structured transcript payload cached next to the summary doc. */
export interface TranscriptDoc {
  title?: string;
  author?: string;
  durationSeconds?: number;
  languageCode?: string;
  /** Cleaned transcript: one sentence-stream, newline-separated sentences. */
  text: string;
}

/** Max characters we paste inline into a Telegram message. */
export const TRANSCRIPT_INLINE_LIMIT = 3500;

export interface TranscriptRenderOptions {
  inlineLimit?: number;
  /**
   * Localized hint appended when the text had to be previewed.
   * Supports a {chars} placeholder (total character count).
   */
  moreHint?: string;
}

export interface TranscriptRenderResult {
  reply: string;
  /** True when the text did not fit inline and a .txt should follow. */
  truncated: boolean;
}

function fmtDuration(seconds?: number): string {
  if (!seconds || seconds <= 0) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = String(m).padStart(h ? 2 : 1, "0");
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Compose the Telegram reply: meta header + full text when it fits,
 * otherwise a paragraph-boundary preview plus the localized hint.
 */
export function renderTranscriptReply(
  doc: TranscriptDoc,
  opts: TranscriptRenderOptions = {},
): TranscriptRenderResult {
  const inlineLimit = opts.inlineLimit ?? TRANSCRIPT_INLINE_LIMIT;
  const header = [`📹 ${doc.title ?? "YouTube video"}`];
  if (doc.author) header.push(`👤 ${doc.author}`);
  const dur = fmtDuration(doc.durationSeconds);
  if (dur) header.push(`⏱ ${dur}`);
  if (doc.languageCode) header.push(`🌐 ${doc.languageCode}`);
  const head = header.join("\n");

  const text = doc.text ?? "";
  if (text.length <= inlineLimit) {
    return { reply: `${head}\n\n${text}`.trimEnd(), truncated: false };
  }

  // Cut the preview at a paragraph boundary so it never ends mid-word.
  const headSlice = text.slice(0, inlineLimit);
  const cut = headSlice.lastIndexOf("\n");
  const preview = cut > inlineLimit * 0.5 ? headSlice.slice(0, cut) : headSlice;
  const hint = (opts.moreHint ?? "(+{chars} characters total)").split("{chars}").join(
    String(text.length),
  );
  return { reply: `${head}\n\n${preview}\n\n${hint}`, truncated: true };
}

/** Plain-text file body: small metadata block, blank line, full transcript. */
export function toPlainTextFile(doc: TranscriptDoc): string {
  const meta: string[] = [];
  if (doc.title) meta.push(`Title: ${doc.title}`);
  if (doc.author) meta.push(`Channel: ${doc.author}`);
  const dur = fmtDuration(doc.durationSeconds);
  if (dur) meta.push(`Duration: ${dur}`);
  if (doc.languageCode) meta.push(`Language: ${doc.languageCode}`);
  return `${meta.join("\n")}${meta.length ? "\n\n" : ""}${doc.text ?? ""}\n`;
}

/**
 * Real PDF through the shared writer: each transcript paragraph becomes a
 * bullet-style block; the TLDR lead line stays empty so no summary label
 * is printed (the writer skips it when tldr is blank).
 */
export async function renderTranscriptPdf(doc: TranscriptDoc): Promise<Uint8Array> {
  const paragraphs = (doc.text ?? "")
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean);
  return renderPdf({
    title: doc.title?.trim() || "YouTube transcript",
    author: doc.author,
    durationSeconds: doc.durationSeconds,
    tldr: "",
    bullets: paragraphs,
  });
}
