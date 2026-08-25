/**
 * SummarizeTube -- PDF writer for the Pro-tier /export command.
 *
 * Constraints: Cloudflare Workers — no binaries, no ffmpeg, no wasm/pdf libs.
 * We assemble a valid single-page PDF 1.4 byte-by-byte in pure TypeScript:
 *   - Helvetica (base-14) font, no embedding required;
 *   - /WinAnsiEncoding so accented PT-BR text renders correctly;
 *   - FlateDecode content stream via native CompressionStream, with an
 *     uncompressed fallback for runtimes without it;
 *   - classic xref table whose offsets are computed over real byte positions
 *     (binary-safe: the compressed stream is never base64-mangled).
 */

export interface PdfDoc {
  title?: string;
  author?: string;
  durationSeconds?: number;
  tldr: string;
  bullets: readonly string[];
}

/* Page geometry (A4 points) and layout budget. */
const LEFT = 56;
const TOP_Y = 792;
const BOTTOM_Y = 56;
const LINE_HEIGHT = 14;
const CHARS_PER_LINE = 90;
const MAX_ROWS = Math.floor((TOP_Y - BOTTOM_Y) / LINE_HEIGHT);

/* Unicode -> WinAnsi for characters outside Latin-1 (everything else <= U+00FF maps 1:1). */
const WINANSI_MAP: Record<string, string> = {
  "\u20AC": "\x80", "\u201A": "\x82", "\u0192": "\x83", "\u201E": "\x84",
  "\u2026": "\x85", "\u2020": "\x86", "\u2021": "\x87", "\u02C6": "\x88", "\u2030": "\x89", "\u0160": "\x8A", "\u2039": "\x8B",
  "\u0152": "\x8C", "\u017D": "\x8E", "\u2018": "\x91", "\u2019": "\x92",
  "\u201C": "\x93", "\u201D": "\x94", "\u2022": "\x95", "\u2013": "\x96",
  "\u2014": "\x97", "\u02DC": "\x98", "\u2122": "\x99", "\u0161": "\x9A",
  "\u203A": "\x9B", "\u0153": "\x9C", "\u017E": "\x9E", "\u0178": "\x9F",
};

function toWinAnsi(text: string): string {
  let out = "";
  for (const ch of text) {
    const mapped = WINANSI_MAP[ch];
    if (mapped !== undefined) {
      out += mapped;
    } else if ((ch.codePointAt(0) ?? 0) <= 0xff) {
      out += ch;
    } else {
      out += "?";
    }
  }
  return out;
}

/** Byte length of a string whose chars are at most 2 bytes (post-WinAnsi safety net). */
function byteLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) n += s.charCodeAt(i) > 0xff ? 2 : 1;
  return n;
}

/** Escape a WinAnsi string as a PDF literal (backslash, parens). */
function pdfLiteral(s: string): string {
  let out = "";
  for (const ch of s) {
    if (ch === "\\" || ch === "(" || ch === ")") out += "\\";
    out += ch;
  }
  return out;
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

/** Greedy word wrap; pathological long words get hard-split. */
export function wrapLine(text: string, width = CHARS_PER_LINE): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur) {
      cur = w;
    } else if (cur.length + 1 + w.length <= width) {
      cur += ` ${w}`;
    } else {
      lines.push(cur);
      cur = w;
    }
    while (cur.length > width) {
      lines.push(cur.slice(0, width));
      cur = cur.slice(width);
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Build the uncompressed page content stream (one Tj per visual line). */
export function makeContentStream(doc: PdfDoc): string {
  const ops: string[] = ["BT", "/F1 11 Tf", `${LINE_HEIGHT} TL`, `1 0 0 1 ${LEFT} ${TOP_Y} Tm`];
  let rows = 0;
  let full = false;
  const show = (line: string): void => {
    if (full) return;
    if (rows >= MAX_ROWS - 1) {
      full = true;
      return;
    }
    ops.push(`(${pdfLiteral(toWinAnsi(line))}) Tj`, "T*");
    rows++;
  };

  for (const line of wrapLine(doc.title?.trim() || "YouTube video")) show(line);
  show("");
  const subtitle = [doc.author?.trim(), fmtDuration(doc.durationSeconds)]
    .filter(Boolean)
    .join("  |  ");
  if (subtitle) {
    for (const line of wrapLine(subtitle)) show(line);
    show("");
  }
  if (doc.tldr.trim()) {
    for (const line of wrapLine(`TLDR: ${doc.tldr.trim()}`)) show(line);
    show("");
  }
  for (const b of doc.bullets) {
    const lines = wrapLine(b.trim());
    lines.forEach((l, i) => show(i === 0 ? `- ${l}` : `  ${l}`));
    show("");
  }
  if (full) {
    ops.push(`(${pdfLiteral(toWinAnsi("(resumo truncado: limite de pagina atingido)"))}) Tj`, "T*");
  }
  ops.push("ET");
  return `${ops.join("\n")}\n`;
}

/** Deflate via native CompressionStream; null when the runtime lacks it.
 *  Input MUST be latin-1 bytes (not a JS string): Blob would otherwise encode
 *  accented chars as UTF-8 and corrupt the WinAnsi byte mapping. */
async function deflateStream(data: Uint8Array): Promise<Uint8Array | null> {
  try {
    const cs = new CompressionStream("deflate");
    const buf = await new Response(
      new Blob([data]).stream().pipeThrough(cs),
    ).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
}

/**
 * Render the complete PDF bytes for a summary document.
 * Objects: 1 Catalog, 2 Pages, 3 Page, 4 Contents, 5 Font.
 */
export async function renderPdf(doc: PdfDoc): Promise<Uint8Array> {
  const content = makeContentStream(doc);
  const contentBytes = new Uint8Array(byteLength(content));
  for (let i = 0; i < contentBytes.length; i++) contentBytes[i] = content.charCodeAt(i) & 0xff;
  const deflated = await deflateStream(contentBytes);

  /* Binary-safe assembly: parts are latin-1 strings or raw byte arrays; the
     running position tracks REAL bytes so the xref table is exact. */
  const parts: Array<string | Uint8Array> = [];
  let pos = 0;
  const push = (p: string | Uint8Array): void => {
    parts.push(p);
    pos += typeof p === "string" ? byteLength(p) : p.length;
  };
  const offsets: number[] = [];
  const obj = (body: string): void => {
    offsets.push(pos);
    push(body);
  };

  push("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
  obj("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  obj("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  obj(
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] " +
      "/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n",
  );
  if (deflated) {
    obj(`4 0 obj\n<< /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n`);
    push(deflated);
    push("\nendstream\nendobj\n");
  } else {
    obj(`4 0 obj\n<< /Length ${byteLength(content)} >>\nstream\n${content}\nendstream\nendobj\n`);
  }
  obj(
    "5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica " +
      "/Encoding /WinAnsiEncoding >>\nendobj\n",
  );

  const xrefPos = pos;
  let xref = `xref\n0 ${offsets.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n\n`;
  xref += `trailer\n<< /Size ${offsets.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  push(xref);

  const out = new Uint8Array(pos);
  let cursor = 0;
  for (const p of parts) {
    if (typeof p === "string") {
      for (let i = 0; i < p.length; i++) out[cursor++] = p.charCodeAt(i) & 0xff;
    } else {
      out.set(p, cursor);
      cursor += p.length;
    }
  }
  return out;
}
