/**
 * summarizetube/summarizer — Workers AI summarization pipeline.
 *
 * Map-reduce over transcript chunks: each chunk yields partial key points,
 * then a reduce pass merges them into TLDR + bullets. When the AI binding
 * is unavailable we degrade to an extractive fallback built from the
 * timestamp index (honest, never fabricated).
 */

import { fmtStamp } from "./youtube";

export const SUMMARIZE_MODEL_FREE = "@cf/meta/llama-3.1-8b-instruct";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function chat(ai: Ai, model: string, messages: readonly ChatMessage[]): Promise<string> {
  const res = await ai.run(model, { messages } as never);
  const out = res as { response?: unknown };
  return typeof out.response === "string" ? out.response : "";
}

export interface ParsedSummary {
  tldr: string;
  bullets: string[];
}

/**
 * Lenient parse of the model reply. Expected shape:
 *   TLDR: one sentence
 *   - bullet
 *   - bullet
 * Falls back gracefully when the model ignores the format.
 */
export function parseModelSummary(raw: string): ParsedSummary | null {
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let tldr = "";
  const bullets: string[] = [];
  for (const line of lines) {
    const tldrMatch = line.match(/^TLDR\s*[:\-–]\s*(.+)$/i);
    if (tldrMatch) {
      tldr = tldrMatch[1]!.trim();
      continue;
    }
    const bulletMatch = line.match(/^[-•*]\s+(.{4,})$/);
    if (bulletMatch) {
      bullets.push(bulletMatch[1]!.trim());
    }
  }
  if (!tldr && bullets.length === 0) {
    // No TLDR, no bullets: accept a short prose paragraph as the TLDR
    // (models sometimes ignore the format entirely) — but it must carry
    // some actual words, not just punctuation.
    const prose = lines.join(" ").trim();
    const wordish = prose.replace(/[^A-Za-zÀ-ÿ0-9]/g, "");
    if (!prose || wordish.length < 8 || prose.length > 300) return null;
    return { tldr: prose, bullets: [] };
  }
  if (!tldr) {
    // Bullets but no explicit TLDR: first short prose line, else first bullet.
    const prose = lines.filter((l) => !/^[-•*]/.test(l) && !/^TLDR/i.test(l));
    tldr = prose.find((l) => l.length <= 200) ?? bullets[0] ?? "";
  }
  return { tldr, bullets };
}

const SYSTEM_PROMPT =
  "You are a precise video-summary assistant. Use ONLY the transcript content provided. " +
  "Reply in the SAME LANGUAGE the transcript is written in. Keep any [mm:ss] timestamps " +
  "from the transcript inside your bullets so users can jump to that moment.";

/** One map pass: key points for a transcript slice. */
export function mapMessages(chunk: string, part: number, total: number): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `Transcript part ${part}/${total} (timestamps like [mm:ss] mark positions):\n\n${chunk}\n\n` +
        "List the key points of this part as '- bullet' lines. Keep the [mm:ss] markers.",
    },
  ];
}

/** Reduce pass: merge partials into TLDR + final bullets. */
export function reduceMessages(partials: readonly string[], deep: boolean): ChatMessage[] {
  const target = deep ? "8 and 14" : "5 and 8";
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `These are partial summaries of ONE video (in order):\n\n${partials.join("\n\n")}\n\n` +
        `Merge them into a final summary in this exact format:\n` +
        `TLDR: <one sentence capturing what the video delivers>\n` +
        `- <key point with [mm:ss] when known>\n` +
        `Write between ${target} bullets. No intro, no outro, no markdown headers.`,
    },
  ];
}

/**
 * Topics pass (roadmap line 35 promises "topicos"). Runs ONLY in deep mode
 * when the creator gave no chapters: one extra chat call over the timestamp
 * index producing a coarse table-of-contents. Free-tier call count stays
 * identical to the pre-topics pipeline.
 */
export function topicsMessages(indexText: string): ChatMessage[] {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `Timestamped transcript index:\n\n${indexText}\n\n` +
        `List the main topics of this video as a table of contents, one per line, ` +
        `in this exact format:\n- [mm:ss] Short topic name\n` +
        `Use the FIRST block timestamp where each topic starts. Write between 3 and 8 topics. ` +
        `No intro, no outro.`,
    },
  ];
}

/** Lenient parse of the topics reply ("- [mm:ss] Topic", stamps optional). */
export function parseTopics(raw: string): { start?: number; label: string }[] {
  const items: { start?: number; label: string }[] = [];
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*[-•*]?\s*\[?(\d{1,2}):([0-5]\d)(?::([0-5]\d))?\]?\s+(.{4,120}?)\s*$/);
    if (!m) continue;
    if (!/^[\p{L}\p{N}]/u.test(m[4]!)) continue;
    const seconds =
      m[3] !== undefined
        ? parseInt(m[1]!, 10) * 3600 + parseInt(m[2]!, 10) * 60 + parseInt(m[3], 10)
        : parseInt(m[1]!, 10) * 60 + parseInt(m[2]!, 10);
    items.push({ start: seconds, label: m[4]! });
  }
  return items.length >= 3 ? items.slice(0, 8) : [];
}

export interface AiSummaryResult {
  summary: ParsedSummary;
  /** Coarse table of contents — deep mode only, [] when unavailable. */
  topics: { start?: number; label: string }[];
}

/**
 * Full pipeline. Returns null when the AI produced nothing usable
 * (caller then tries the extractive fallback).
 */
export async function aiSummarize(
  ai: Ai,
  model: string,
  chunks: readonly string[],
  deep: boolean,
  opts: { topics?: boolean; indexText?: string } = {},
): Promise<AiSummaryResult | null> {
  const partials: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const text = await chat(ai, model, mapMessages(chunks[i]!, i + 1, chunks.length));
    if (text.trim()) partials.push(text.trim());
  }
  if (!partials.length) return null;
  let raw: string;
  try {
    raw =
      partials.length === 1 && !deep
        ? partials[0]!
        : await chat(ai, model, reduceMessages(partials, deep));
  } catch {
    return null;
  }
  const summary = parseModelSummary(raw);
  if (!summary) return null;
  // Topics are a bonus pass: a failure here must never fail the summary.
  let topics: AiSummaryResult["topics"] = [];
  if (deep && opts.topics && opts.indexText) {
    try {
      topics = parseTopics(await chat(ai, model, topicsMessages(opts.indexText)));
    } catch {
      topics = [];
    }
  }
  return { summary, topics };
}

/**
 * Deterministic no-AI fallback: pull the opening sentences of each
 * timestamp block from the index. Clearly labelled, never invented.
 */
export function extractiveFallback(indexText: string, maxBullets = 8): ParsedSummary {
  const bullets: string[] = [];
  for (const line of indexText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("[")) continue;
    // First ~140 chars of each block as the bullet.
    const body = trimmed.slice(0, 160).replace(/\s+\S*$/, "");
    bullets.push(body.startsWith("[") ? body : `[00:00] ${body}`);
    if (bullets.length >= maxBullets) break;
  }
  return { tldr: "", bullets };
}

export interface VideoMeta {
  title?: string;
  author?: string;
  durationSeconds?: number;
  languageCode?: string;
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

/** Compose the Telegram reply from meta + parsed summary (+ optional topics/chapters block). */
export function renderSummary(
  meta: VideoMeta,
  summary: ParsedSummary,
  deep: boolean,
  extras = "",
): string {
  const header = [`📹 ${meta.title ?? "YouTube video"}`];
  if (meta.author) header.push(`👤 ${meta.author}`);
  const dur = fmtDuration(meta.durationSeconds);
  if (dur) header.push(`⏱ ${dur}`);

  const parts: string[] = [header.join("\n"), ""];
  if (summary.tldr) parts.push(`💡 ${summary.tldr}`, "");
  if (summary.bullets.length) {
    parts.push(summary.bullets.map((b) => `• ${b}`).join("\n"), "");
  }
  if (extras) parts.push(extras.replace(/^\n+/, ""), "");
  if (deep) parts.push("(modo profundo)");
  return parts.join("\n").trim();
}

/** Render AI topics as a section block shaped like creator chapters ("" when empty). */
export function renderTopics(topics: readonly { start?: number; label: string }[]): string {
  if (!topics.length) return "";
  return [
    "",
    "📚 Topicos:",
    ...topics.map((tp) =>
      tp.start === undefined ? `  ${tp.label}` : `  ${fmtStamp(tp.start)} ${tp.label}`,
    ),
  ].join("\n");
}
