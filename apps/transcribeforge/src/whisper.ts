/**
 * Whisper client for Cloudflare Workers AI (@cf/openai/whisper).
 *
 * The model accepts binary audio and returns:
 *   { text: string, words?: Array<{word, start, end}>, vtt?: string }
 *
 * We prefer `words` (char-level timings) and group them into subtitle
 * segments; when only `vtt` comes back we pass it through. Everything
 * else is an honest failure.
 */

export interface WhisperWord {
  word: string;
  start: number;
  end: number;
}

export interface WhisperResponse {
  text?: string;
  words?: WhisperWord[];
  vtt?: string;
}

import type { Segment } from "./formatters";

/** Group word timings into subtitle-sized segments. */
export function wordsToSegments(
  words: readonly WhisperWord[],
  maxChars = 42,
  maxGapSeconds = 1.0,
  maxDurationSeconds = 5.0,
): Segment[] {
  const segments: Segment[] = [];
  let cur: { start: number; end: number; parts: string[] } | null = null;

  const flush = () => {
    if (cur && cur.parts.length) {
      segments.push({ start: cur.start, end: cur.end, text: cur.parts.join(" ") });
    }
    cur = null;
  };

  for (const w of words) {
    const text = (w.word ?? "").trim();
    if (!text) continue;
    if (!cur) {
      cur = { start: w.start, end: w.end, parts: [text] };
      continue;
    }
    const gap = w.start - cur.end;
    const projectedLen = cur.parts.join(" ").length + 1 + text.length;
    const projectedDur = w.end - cur.start;
    const endsSentence = /[.!?…。]$/.test(cur.parts[cur.parts.length - 1] ?? "");

    if (endsSentence || gap > maxGapSeconds || projectedLen > maxChars || projectedDur > maxDurationSeconds) {
      flush();
      cur = { start: w.start, end: w.end, parts: [text] };
    } else {
      cur.parts.push(text);
      cur.end = w.end;
    }
  }
  flush();
  return segments;
}

/** Call Workers AI Whisper with an audio buffer. */
export async function transcribeAudio(
  ai: Ai,
  model: string,
  audio: ArrayBuffer,
  language?: string,
): Promise<WhisperResponse> {
  const res = await ai.run(model, {
    // Workers AI accepts the raw bytes as the input payload.
    audio: audio as never,
    ...(language ? { language } : {}),
  });
  return res as WhisperResponse;
}
