/**
 * summarizetube/summarizer — Workers AI summarization pipeline.
 *
 * Map-reduce over transcript chunks: each chunk yields partial key points,
 * then a reduce pass merges them into TLDR + bullets. When the AI binding
 * is unavailable we degrade to an extractive fallback built from the
 * timestamp index (honest, never fabricated).
 */

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
 * Full pipeline. Returns null when the AI produced nothing usable
 * (caller then tries the extractive fallback).
 */
export async function aiSummarize(
  ai: Ai,
  model: string,
  chunks: readonly string[],
  deep: boolean,
): Promise<ParsedSummary | null> {
  const partials: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const text = await chat(ai, model, mapMessages(chunks[i]!, i + 1, chunks.length));
    if (text.trim()) partials.push(text.trim());
  }
  if (!partials.length) return null;
  const raw =
    partials.length === 1 && !deep ? partials[0]! : await chat(ai, model, reduceMessages(partials, deep));
  return parseModelSummary(raw);
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

/** Compose the Telegram reply from meta + parsed summary. */
export function renderSummary(meta: VideoMeta, summary: ParsedSummary, deep: boolean): string {
  const header = [`📹 ${meta.title ?? "YouTube video"}`];
  if (meta.author) header.push(`👤 ${meta.author}`);
  const dur = fmtDuration(meta.durationSeconds);
  if (dur) header.push(`⏱ ${dur}`);

  const parts: string[] = [header.join("\n"), ""];
  if (summary.tldr) parts.push(`💡 ${summary.tldr}`, "");
  if (summary.bullets.length) {
    parts.push(summary.bullets.map((b) => `• ${b}`).join("\n"), "");
  }
  if (deep) parts.push("(modo profundo)");
  return parts.join("\n").trim();
}
