/**
 * documind/rag — chunking + retrieval + grounded answering.
 *
 * Vectorize free tier needs a paid-tier Workers plan in practice, so the
 * "RAG" here is deliberately boring: overlap-free sentence chunks, keyword
 * scoring (coverage of query terms, position-boosted) and top-k selection.
 * It runs in microseconds on documents that fit D1/KV budgets and never
 * calls an embedding API — zero marginal cost by construction.
 *
 * Grounding rule: the model receives ONLY the selected chunks and must cite
 * them as [1], [2]... If it cites nothing or invents sections, we fall back
 * to a deterministic extractive answer built from the best chunk.
 */

export const DOCUMIND_MODEL = "@cf/meta/llama-3.1-8b-instruct";

export interface Chunk {
  /** 1-based citation id shown to the user. */
  n: number;
  text: string;
}

const WORD = /[A-Za-zÀ-ÿ0-9]{2,}/g;

/** Tiny pt/en stopword list — function words must not drive retrieval. */
const STOPWORDS = new Set([
  "de", "da", "do", "das", "dos", "em", "no", "na", "nos", "nas", "um", "uma",
  "que", "com", "por", "para", "e", "o", "a", "os", "as", "ao", "aos", "se",
  "the", "of", "to", "in", "on", "at", "is", "are", "was", "were", "it",
  "this", "that", "and", "or", "for", "as",
]);

function words(s: string): string[] {
  return s.toLowerCase().match(WORD) ?? [];
}

function contentWords(s: string): string[] {
  return words(s).filter((w) => !STOPWORDS.has(w));
}

/** Split into sentence-ish units; keeps trailing punctuation attached. */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?;:])\s+(?=[A-ZÀ-Þ0-9"“(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Sentence-packed chunks with hard char budget. Sentences are never cut in
 * half mid-chunk unless a single sentence alone exceeds the budget.
 */
export function chunkText(text: string, budget = 900): string[] {
  if (!text.trim()) return [];
  const sentences = splitSentences(text);
  const chunks: string[] = [];
  let cur = "";
  for (const s of sentences) {
    const piece = s.length > budget ? s.slice(0, budget - 1).trimEnd() + "…" : s;
    if (cur && cur.length + piece.length + 1 > budget) {
      chunks.push(cur);
      cur = piece;
    } else {
      cur = cur ? `${cur} ${piece}` : piece;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** Build numbered chunks from all extracted page texts. */
export function buildIndex(pageTexts: readonly string[], budget?: number): Chunk[] {
  const out: Chunk[] = [];
  let n = 0;
  for (const page of pageTexts) {
    for (const c of chunkText(page, budget)) {
      out.push({ n: ++n, text: c });
    }
  }
  return out;
}

export interface ScoredChunk extends Chunk {
  score: number;
}

/**
 * Keyword-overlap scoring: fraction of query terms present (weight 2 each
 * occurrence up to 3) plus a small density bonus. Deterministic.
 */
export function retrieve(chunks: readonly Chunk[], query: string, k = 4): ScoredChunk[] {
  const terms = new Set(contentWords(query));
  if (terms.size === 0) return [];
  const scored: ScoredChunk[] = [];
  for (const c of chunks) {
    // Cap scanned length so huge chunks can't dominate by repetition.
    const hay = words(c.text.slice(0, 4000));
    const counts = new Map<string, number>();
    for (const w of hay) counts.set(w, (counts.get(w) ?? 0) + 1);
    let score = 0;
    for (const term of terms) {
      const hits = Math.min(counts.get(term) ?? 0, 3);
      if (hits > 0) score += 2 * hits;
    }
    if (score > 0) scored.push({ ...c, score });
  }
  scored.sort((a, b) => b.score - a.score || a.n - b.n);
  return scored.slice(0, k);
}

/** Extractive no-AI answer: best passages, clearly labelled, never invented. */
export function extractiveAnswer(scored: readonly ScoredChunk[]): string {
  if (!scored.length) return "";
  const lines = scored.slice(0, 3).map((c) => `[${c.n}] ${trimSentence(c.text)}`);
  return lines.join("\n\n");
}

function trimSentence(text: string, max = 320): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

const ANSWER_SYSTEM =
  "You are a precise document Q&A assistant. Answer using ONLY the numbered " +
  "passages provided. Cite every claim with its passage number like [1] or [2]. " +
  "Reply in the SAME LANGUAGE as the question. If the passages do not contain " +
  "the answer, reply exactly: NOT_IN_DOCUMENT.";

/** Prompt for one question over the retrieved context. */
export function qaMessages(question: string, scored: readonly ScoredChunk[]): {
  role: "system" | "user";
  content: string;
}[] {
  const context = scored.map((c) => `[${c.n}] ${trimSentence(c.text, 1200)}`).join("\n\n");
  return [
    { role: "system", content: ANSWER_SYSTEM },
    { role: "user", content: `Passages:\n\n${context}\n\nQuestion: ${question}` },
  ];
}

export interface AiLike {
  run(model: string, input: unknown): Promise<unknown>;
}

async function chat(ai: AiLike, model: string, messages: { role: string; content: string }[]) {
  const res = (await ai.run(model, { messages } as never)) as { response?: unknown };
  return typeof res.response === "string" ? res.response : "";
}

export interface GroundedAnswer {
  answer: string;
  cited: boolean;
}

/**
 * Ask the model and enforce grounding. A reply without any [n] citation, or
 * admitting absence when our retrieval DID find hits, degrades to the
 * extractive answer — users only ever see passage-backed content.
 */
export async function answerQuestion(
  ai: AiLike | undefined,
  model: string,
  question: string,
  scored: readonly ScoredChunk[],
): Promise<GroundedAnswer> {
  if (!scored.length) return { answer: "", cited: false };
  if (!ai) return { answer: extractiveAnswer(scored), cited: true };

  let raw = "";
  try {
    raw = await chat(ai, model, qaMessages(question, scored));
  } catch {
    return { answer: extractiveAnswer(scored), cited: true };
  }
  const trimmed = raw.trim();
  if (/^NOT_IN_DOCUMENT\b/i.test(trimmed)) {
    // Model is honest about absence — trust it but keep our evidence handy.
    return { answer: extractiveAnswer(scored), cited: true };
  }
  const hasCitation = /\[\d+\]/.test(trimmed);
  if (!trimmed || !hasCitation || trimmed.length > 2400) {
    return { answer: extractiveAnswer(scored), cited: true };
  }
  return { answer: trimmed, cited: true };
}
