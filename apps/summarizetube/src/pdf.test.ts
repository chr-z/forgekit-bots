import { describe, expect, it } from "vitest";
import { makeContentStream, renderPdf, wrapLine } from "./pdf";

/** Inflate raw deflate bytes back to text (mirrors what a PDF reader does with FlateDecode). */
async function inflate(data: Uint8Array): Promise<string> {
  const ds = new DecompressionStream("deflate");
  return await new Response(new Blob([data as BlobPart]).stream().pipeThrough(ds)).text();
}

const DOC = {
  title: "Aula completa de fundamentos",
  author: "@prof",
  durationSeconds: 3725,
  tldr: "Resumo com acentuação: informação, código e ação.",
  bullets: ["Primeiro ponto (com parênteses)", "Segundo ponto"],
};

function latin1(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

describe("wrapLine", () => {
  it("wraps long text and hard-splits pathological words", () => {
    const words = Array.from({ length: 30 }, (_, i) => `palavra${i}`).join(" ");
    const lines = wrapLine(words, 40);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(40);

    const [hard] = wrapLine("x".repeat(95), 90);
    expect(hard!.length).toBe(90);
    expect(wrapLine("")).toEqual([]);
  });
});

describe("makeContentStream", () => {
  it("emits header, TLDR, wrapped bullets and escapes PDF literals", () => {
    const s = makeContentStream(DOC);
    expect(s.startsWith("BT\n/F1 11 Tf")).toBe(true);
    expect(s.endsWith("\nET\n")).toBe(true);
    expect(s).toContain("(TLDR: Resumo com acentuação:");
    expect(s).toContain("(- Primeiro ponto \\(com parênteses\\)) Tj");
    // every Tj is preceded by exactly one T* except the first line
    expect(s.split("T*").length - 1).toBe(s.split(") Tj").length - 1);
  });

  it("truncates gracefully at the page limit instead of overflowing A4", () => {
    const big = {
      title: "t",
      tldr: "",
      bullets: Array.from({ length: 120 }, (_, i) => `bullet ${i} ${"texto ".repeat(20)}`),
    };
    const s = makeContentStream(big);
    expect(s).toContain("(resumo truncado");
    const tjCount = s.split(") Tj").length - 1;
    expect(tjCount).toBeLessThanOrEqual(Math.floor((792 - 56) / 14));
  });
});

describe("renderPdf", () => {
  it("produces a structurally valid single-page PDF 1.4 with exact xref offsets", async () => {
    const bytes = await renderPdf(DOC);
    const raw = latin1(bytes);

    expect(raw.startsWith("%PDF-1.4")).toBe(true);
    expect(raw.trimEnd().endsWith("%%EOF")).toBe(true);

    // xref offsets must point exactly at each "N 0 obj"
    const xrefStart = raw.lastIndexOf("startxref");
    const xrefPos = Number(raw.slice(xrefStart + "startxref".length).trim().split(/\s+/)[0]);
    expect(raw.slice(xrefPos, xrefPos + 4)).toBe("xref");

    const entries = [...raw.matchAll(/^(\d{10}) 00000 n$/gm)].map((m) => Number(m[1]));
    expect(entries).toHaveLength(5); // Catalog, Pages, Page, Contents, Font
    entries.forEach((off, i) => {
      expect(raw.slice(off, off + 8)).toBe(`${i + 1} 0 obj\n`);
    });

    expect(raw).toContain("/Filter /FlateDecode");
    expect(raw).toContain("/WinAnsiEncoding");
    expect(raw).not.toContain("/DecodeParms"); // legacy artifact of the broken writer
  });

  it("content stream inflates back to the original page commands (binary-safe)", async () => {
    const bytes = await renderPdf(DOC);
    const raw = latin1(bytes);
    const m = raw.match(/4 0 obj\n<< \/Length (\d+) \/Filter \/FlateDecode >>\nstream\n/);
    expect(m).toBeTruthy();
    const len = Number(m![1]);
    const streamStart = raw.indexOf("stream\n", raw.indexOf("4 0 obj")) + "stream\n".length;
    const streamBytes = bytes.subarray(streamStart, streamStart + len);
    expect(streamBytes.length).toBe(len);
    // the compressed stream is NOT stored base64
    expect(latin1(streamBytes.slice(0, 2))).not.toBe("BT");

    const content = await inflate(streamBytes);
    expect(content.startsWith("BT")).toBe(true);
    expect(content).toContain("Aula completa de fundamentos");
    expect(content).toContain("1:02:05");
  });

  it("renders accented PT-BR through WinAnsi without mojibake or data loss", async () => {
    const bytes = await renderPdf({
      title: "Ação & reação — coração",
      tldr: "Não é informação? É!",
      bullets: [],
    });
    const raw1 = latin1(bytes);
    const len = Number(raw1.match(/\/Length (\d+) \/Filter \/FlateDecode/)![1]);
    const s0 = raw1.indexOf("stream\n") + "stream\n".length;
    // inflate WITHOUT UTF-8 decoding: WinAnsi bytes must survive 1:1
    const ds = new DecompressionStream("deflate");
    const buf = await new Response(
      new Blob([bytes.subarray(s0, s0 + len)] as BlobPart[]).stream().pipeThrough(ds),
    ).arrayBuffer();
    const content = latin1(new Uint8Array(buf));
    expect(content).toContain("Ação & reação \x97 coração");
    expect(content).toContain("Não é informação? É!");
  });

  it("falls back to an uncompressed stream when CompressionStream is missing", async () => {
    const Original = globalThis.CompressionStream;
    // @ts-expect-error simulate runtimes without the native API
    delete globalThis.CompressionStream;
    try {
      const bytes = await renderPdf({ title: "t", tldr: "d", bullets: [] });
      const raw = latin1(bytes);
      expect(raw).not.toContain("/FlateDecode");
      expect(raw).toMatch(/\/Length \d+ >>\nstream\nBT\n/);
      expect(raw).toContain("(TLDR: d) Tj");
    } finally {
      globalThis.CompressionStream = Original;
    }
  });

  it("degrades non-encodable characters instead of emitting invalid bytes", async () => {
    const content = makeContentStream({ title: "emoji 🎬 fim", tldr: "", bullets: [] });
    expect(content).toContain("emoji ? fim");
    for (let i = 0; i < content.length; i++) {
      expect(content.charCodeAt(i)).toBeLessThanOrEqual(0xff);
    }
  });
});
