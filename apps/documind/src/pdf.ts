/**
 * documind/pdf — minimal pure-TS PDF text extraction.
 *
 * Constraints that shape this module:
 * - Cloudflare Workers: no binaries, no ffmpeg, no wasm pdf libs. What we
 *   DO have natively is `DecompressionStream("deflate")`, which inflates
 *   FlateDecode content streams (what virtually every real PDF uses).
 * - Honesty over coverage: if a document yields no usable text (scanned
 *   images, exotic encodings), we report that instead of inventing content.
 *
 * Strategy: scan the raw bytes for `stream ... endstream` payloads, inflate
 * FlateDecode ones, then pull literal/hex strings out of text-showing
 * operators (Tj / TJ inside BT..ET). Each content stream maps to one "page
 * unit" in appearance order — a deliberate approximation, clearly labelled
 * in the UI as approximate pagination.
 */

export interface PdfExtraction {
  /** Extracted text per content stream (appearance order). */
  pages: string[];
  totalChars: number;
}

/** Bytes -> byte-faithful latin1 string (for regex scanning). */
export function bytesToLatin1(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

/** Latin1 string -> bytes (inverse, used before inflation). */
export function latin1ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** Inflate a zlib-deflate payload; null when unsupported/broken. */
export async function inflateDeflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const ds = new DecompressionStream("deflate");
    const view = new Uint8Array(bytes); // copy-free Blob input via ArrayBufferView
    const stream = new Blob([view.buffer as ArrayBuffer]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

interface RawStream {
  dict: string;
  data: string; // latin1
}

/** Find `stream ... endstream` payloads with their nearest dictionary. */
export function findStreams(pdf: string): RawStream[] {
  const out: RawStream[] = [];
  let i = 0;
  while ((i = pdf.indexOf("stream", i)) !== -1) {
    if (pdf[i - 1] === "d") {
      i += 6; // "endstream"
      continue;
    }
    // Skip the EOL right after the `stream` keyword (\r\n counts as one).
    let dataStart = i + 6;
    if (pdf[dataStart] === "\r") dataStart++;
    if (pdf[dataStart] === "\n") dataStart++;
    const end = pdf.indexOf("endstream", dataStart);
    if (end === -1) break;
    // The writer's EOL right before `endstream` belongs to the framing, not
    // the payload — trailing newlines would also corrupt zlib inflating.
    let dataEnd = end;
    while (dataEnd > dataStart && (pdf[dataEnd - 1] === "\r" || pdf[dataEnd - 1] === "\n")) dataEnd--;
    const dictStart = Math.max(0, pdf.lastIndexOf("<<", i));
    const dict = pdf.slice(dictStart, i);
    out.push({ dict, data: pdf.slice(dataStart, dataEnd) });
    i = end + 9;
  }
  return out;
}

const ESCAPES: Record<string, string> = {
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
  "(": "(",
  ")": ")",
  "\\": "\\",
};

/** Decode a PDF literal-string body (between the parens) to text. */
export function unescapeLiteral(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = body[++i];
    if (next === undefined) break;
    if (next in ESCAPES) {
      out += ESCAPES[next];
      continue;
    }
    if (/[0-7]/.test(next)) {
      // Up to 3 octal digits.
      let oct = next;
      while (oct.length < 3 && /[0-7]/.test(body[i + 1] ?? "")) oct += body[++i];
      out += String.fromCharCode(parseInt(oct, 8));
      continue;
    }
    // Unknown escape: keep the char literally (PDF spec says so).
    out += next;
  }
  return maybeUtf16Be(out);
}

/** Detect a UTF-16BE BOM (U+00FE U+00FF seen through latin1) and decode. */
function maybeUtf16Be(s: string): string {
  if (s.charCodeAt(0) !== 0xfe || s.charCodeAt(1) !== 0xff) return s;
  let out = "";
  for (let i = 2; i + 1 < s.length; i += 2) {
    out += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
  }
  return out;
}

/** Decode a PDF hex string body (between < >), tolerating whitespace. */
export function decodeHexString(body: string): string {
  const hex = body.replace(/[^0-9A-Fa-f]/g, "");
  const clean = hex.length % 2 ? hex + "0" : hex;
  let raw = "";
  for (let i = 0; i < clean.length; i += 2) {
    raw += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
  }
  return maybeUtf16Be(raw);
}

/**
 * Pull visible text out of one decoded content stream: every (...) literal
 * and <...> hex string that appears in a text-showing context. We accept a
 * little noise (strings outside BT/ET) — chunking + retrieval downstream
 * cares about recall more than perfect operator fidelity.
 */
export function contentStreamToText(content: string): string {
  let out = "";
  for (let i = 0; i < content.length; i++) {
    const c = content[i]!;
    if (c === "(") {
      // Balanced-paren scan honouring escapes.
      let depth = 1;
      let j = i + 1;
      let body = "";
      while (j < content.length && depth > 0) {
        const ch = content[j]!;
        if (ch === "\\") {
          body += ch + (content[j + 1] ?? "");
          j += 2;
          continue;
        }
        if (ch === "(") depth++;
        else if (ch === ")") {
          depth--;
          if (depth === 0) break;
        }
        body += ch;
        j++;
      }
      out += unescapeLiteral(body);
      out += " "; // separator: adjacent shown strings must not glue together
      i = j;
      continue;
    }
    if (c === "<" && content[i + 1] !== "<") {
      const close = content.indexOf(">", i + 1);
      if (close === -1) break;
      const body = content.slice(i + 1, close);
      if (/^[0-9A-Fa-f\s]*$/.test(body)) {
        out += decodeHexString(body);
        out += " "; // separator, same rationale as literal strings
      }
      i = close;
      continue;
    }
    if (c === ")" || c === ">" || c === "[") {
      // Separator between adjacent shown strings (TJ arrays, kerning gaps).
      out += " ";
    }
  }
  return out.replace(/\x00/g, "").replace(/[ \t]+/g, " ").trim();
}

/**
 * Full extraction. Never throws on malformed input — a broken document
 * degrades to whatever streams parsed, possibly zero.
 */
export async function extractPdfText(
  input: Uint8Array | ArrayBuffer,
  deps: { decompress?: typeof inflateDeflate } = {},
): Promise<PdfExtraction> {
  const decompress = deps.decompress ?? inflateDeflate;
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const pdf = bytesToLatin1(bytes);

  const pages: string[] = [];
  for (const stream of findStreams(pdf)) {
    let content = stream.data;
    if (/\/Filter\s*(?:\[|\s)*\/FlateDecode/.test(stream.dict)) {
      const inflated = await decompress(latin1ToBytes(stream.data));
      if (!inflated) continue; // undecodable stream -> skipped, not fatal
      content = bytesToLatin1(inflated);
    }
    if (!/(BT\b|Tj|TJ)/.test(content)) continue; // fonts, XObjects, metadata
    const text = contentStreamToText(content);
    if (text.length > 0) pages.push(text);
  }

  return { pages, totalChars: pages.reduce((n, p) => n + p.length, 0) };
}
