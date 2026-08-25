/**
 * documind/docx — minimal DOCX (Office Open XML) text extractor, pure TS.
 *
 * A .docx file is a ZIP archive whose main content lives in `word/document.xml`
 * (plus optional `word/header*.xml` / `word/footer*.xml` parts). Instead of
 * pulling in a full ZIP dependency we read the **central directory** directly
 * and inflate `deflate`-compressed entries with the Workers-native
 * `DecompressionStream("deflate")` — the exact same trick the PDF extractor
 * uses for FlateDecode streams. Stored (uncompressed) entries are supported
 * too. Every entry's CRC32 is verified after decompression so silently
 * corrupted content is refused, not hallucinated.
 *
 * Text conversion walks the OOXML body and emits:
 *   - `<w:p>`  → paragraph boundary (newline)
 *   - `<w:tab/>` → tab, `<w:br/>`/`<w:cr/>` → newline
 *   - `<w:t>` text runs → decoded XML text (`&amp;` etc.)
 *
 * Deliberate scope limits, mirroring the PDF module's honesty rules:
 *   - ZIP64 archives are out of scope (Bot API caps files at 20MB long before
 *     ZIP64 matters). Entries are read via their central-directory metadata
 *     (sizes/CRC), so bit-3 "streaming" entries with a trailing data
 *     descriptor still resolve correctly; only entries whose central record
 *     itself lies about sizes fail (by design — refuse, don't guess).
 *   - Only deflate/stored compression is understood; anything else fails the
 *     whole extraction honestly instead of producing partial guesses.
 */

/** Inflate a RAW-deflate payload (ZIP method 8); null when unsupported/broken. */
async function defaultInflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    // NB: zip entries hold RFC 1951 raw deflate, so "deflate-raw" — NOT the
    // zlib-wrapped "deflate" the PDF extractor uses for FlateDecode streams.
    const ds = new DecompressionStream("deflate-raw");
    // NB2: `bytes` is usually a subarray VIEW into the archive (byteOffset >
    // 0). Wrapping `bytes.buffer` would feed the WHOLE zip to the inflater;
    // Blob honors the view's bounds, so pass the view itself.
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ crc32

const CRC_TABLE: number[] = (() => {
  const table = new Array<number>(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ------------------------------------------------------------- zip reading

/** Little-endian readers over the raw byte array. */
function u16le(b: Uint8Array, off: number): number {
  return b[off]! | (b[off + 1]! << 8);
}
function u32le(b: Uint8Array, off: number): number {
  return (b[off]! | (b[off + 1]! << 8) | (b[off + 2]! << 16) | (b[off + 3]! << 24)) >>> 0;
}

const SIG_CENTRAL_DIR = 0x02014b50;
const SIG_LOCAL_HEADER = 0x04034b50;

interface ZipEntry {
  method: number;
  crc32Expected: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

/**
 * Parse the End Of Central Directory record + central directory entries.
 * Returns null when the EOCD signature cannot be found (not a zip).
 */
export function parseZipDirectory(bytes: Uint8Array): Map<string, ZipEntry> | null {
  if (bytes.length < 22) return null;
  // EOCD is at least 22 bytes and sits at the tail; comment may follow it.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65_536); i--) {
    if (u32le(bytes, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = u16le(bytes, eocd + 10);
  let ptr = u32le(bytes, eocd + 16); // offset of start of central directory
  if (ptr >= bytes.length) return null;
  const entries = new Map<string, ZipEntry>();
  for (let n = 0; n < count; n++) {
    if (ptr + 46 > bytes.length || u32le(bytes, ptr) !== SIG_CENTRAL_DIR) break;
    const nameLen = u16le(bytes, ptr + 28);
    const extraLen = u16le(bytes, ptr + 30);
    const commentLen = u16le(bytes, ptr + 32);
    const nameBytes = bytes.subarray(ptr + 46, ptr + 46 + nameLen);
    const name = new TextDecoder().decode(nameBytes);
    entries.set(name, {
      method: u16le(bytes, ptr + 10),
      crc32Expected: u32le(bytes, ptr + 16),
      compressedSize: u32le(bytes, ptr + 20),
      uncompressedSize: u32le(bytes, ptr + 24),
      localHeaderOffset: u32le(bytes, ptr + 42),
    });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries.size > 0 || count === 0 ? entries : null;
}

/** Extract + inflate one entry by exact name; null on any failure. */
export async function zipReadEntry(
  bytes: Uint8Array,
  entry: ZipEntry,
  inflate: (b: Uint8Array) => Promise<Uint8Array | null>,
): Promise<Uint8Array | null> {
  const off = entry.localHeaderOffset;
  if (off + 30 > bytes.length || u32le(bytes, off) !== SIG_LOCAL_HEADER) return null;
  const lNameLen = u16le(bytes, off + 26);
  const lExtraLen = u16le(bytes, off + 28);
  const dataStart = off + 30 + lNameLen + lExtraLen;
  if (dataStart + entry.compressedSize > bytes.length) return null;
  const payload = bytes.subarray(dataStart, dataStart + entry.compressedSize);

  let data: Uint8Array | null;
  if (entry.method === 0) {
    data = payload.slice();
  } else if (entry.method === 8) {
    data = await inflate(payload);
  } else {
    return null; // bzip2/lzma/encrypted... honest refusal
  }
  if (!data) return null;
  if (data.length !== entry.uncompressedSize) return null;
  if (crc32(data) !== entry.crc32Expected) return null;
  return data;
}

// ------------------------------------------------------------ ooxml to text

/** Decode the XML entities OOXML actually uses in `w:t` content. */
export function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Convert one document.xml into plain text. Paragraphs become newlines,
 * tabs/line breaks inside a paragraph are honored, everything outside
 * `<w:t ...>` runs (formatting tags, properties) contributes no text.
 */
export function documentXmlToText(xml: string): string {
  const out: string[] = [];
  // Tokenize just enough: paragraphs, tabs/breaks and text runs.
  const paraRe = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>|<w:p(?:\s[^>]*)?\/>/g;
  let m: RegExpExecArray | null;
  while ((m = paraRe.exec(xml)) !== null) {
    const body = m[1];
    if (body === undefined) continue; // self-closed empty paragraph → blank line only via join below
    let line = "";
    const runRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:cr\s*\/>/g;
    let r: RegExpExecArray | null;
    while ((r = runRe.exec(body)) !== null) {
      if (r[1] !== undefined) {
        line += decodeXmlEntities(r[1]);
      } else if (r[0].startsWith("<w:tab")) {
        line += "\t";
      } else {
        line += "\n";
      }
    }
    out.push(line);
  }
  // Preserve empty paragraphs as blank lines but never end with trailing blanks.
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return out.join("\n") + (out.length > 0 ? "\n" : "");
}

/** Parts of a docx that carry user-visible text, in reading order. */
const TEXT_PARTS = ["word/document.xml", "word/header1.xml", "word/footer1.xml"];

export interface DocxExtract {
  pages: string[]; // one entry per text-bearing part (document first)
  chars: number;
  parts: number;
}

export interface DocxExtractDeps {
  inflate?: typeof defaultInflate;
}

/**
 * Extract text from .docx bytes. Throws `Error("no_text")` when the container
 * or its parts hold nothing readable — callers map that to the same honest
 * "no readable text" path used for scanned PDFs.
 */
export async function extractDocxText(
  bytes: Uint8Array,
  deps: DocxExtractDeps = {},
): Promise<DocxExtract> {
  const inflate = deps.inflate ?? defaultInflate;
  const dir = parseZipDirectory(bytes);
  if (!dir) throw new Error("no_text");

  const pages: string[] = [];
  for (const part of TEXT_PARTS) {
    const entry = dir.get(part);
    if (!entry) continue;
    const data = await zipReadEntry(bytes, entry, inflate);
    if (!data) throw new Error("corrupt_entry");
    const xml = new TextDecoder().decode(data);
    const text = documentXmlToText(xml).trim();
    if (text) pages.push(text);
  }
  const chars = pages.reduce((n, p) => n + p.length, 0);
  if (chars === 0) throw new Error("no_text");
  return { pages, chars, parts: pages.length };
}
