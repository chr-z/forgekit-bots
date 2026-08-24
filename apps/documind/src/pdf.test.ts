import { describe, expect, it } from "vitest";
import {
  bytesToLatin1,
  contentStreamToText,
  decodeHexString,
  extractPdfText,
  findStreams,
  inflateDeflate,
  latin1ToBytes,
  unescapeLiteral,
} from "./pdf";

/** Compress with the native zlib "deflate" (what FlateDecode payloads are). */
async function deflate(s: string): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate");
  const stream = new Blob([s]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Build a tiny but structurally real PDF around one FlateDecode stream. */
async function makePdf(contentStreams: string[]): Promise<Uint8Array> {
  let pdf = "%PDF-1.4\n";
  for (const content of contentStreams) {
    const z = await deflate(content);
    pdf += `<< /Length ${z.length} /Filter /FlateDecode >>\nstream\n`;
    pdf += bytesToLatin1(z);
    pdf += "\nendstream\n";
  }
  pdf += "%%EOF";
  return latin1ToBytes(pdf);
}

describe("literal/hex string decoding", () => {
  it("unescapes standard escapes, octal codes and keeps unknown escapes", () => {
    expect(unescapeLiteral("line\\nbreak")).toBe("line\nbreak");
    expect(unescapeLiteral("parens \\(x\\) and \\\\ slash")).toBe("parens (x) and \\ slash");
    expect(unescapeLiteral("octal \\101\\102\\103")).toBe("octal ABC");
    expect(unescapeLiteral("unknown \\q kept")).toBe("unknown q kept");
  });

  it("detects and decodes UTF-16BE strings via BOM", () => {
    // BOM + "Hi" in UTF-16BE, seen through latin1 eyes.
    const s = String.fromCharCode(0xfe, 0xff, 0x00, 0x48, 0x00, 0x69);
    expect(unescapeLiteral(s)).toBe("Hi");
  });

  it("decodes hex strings with whitespace and odd-length padding", () => {
    expect(decodeHexString("48 65 6C 6C 6F")).toBe("Hello");
    expect(decodeHexString("48A")).toBe(String.fromCharCode(0x48, 0xa0));
    const bom = `FEFF${(0x41).toString(16).padStart(4, "0")}`;
    expect(decodeHexString(bom)).toBe("A");
  });
});

describe("contentStreamToText", () => {
  it("joins Tj and TJ array operands with spaces", () => {
    const text = contentStreamToText("BT /F1 12 Tf (Preço médio:) Tj [(R) 3 ($) 4 (500)] TJ ET");
    expect(text).toContain("Preço médio:");
    expect(text).toContain("$ 500"); // kerning gap becomes a space
  });

  it("handles balanced nested parens and skips non-string operators", () => {
    const text = contentStreamToText("(aninhado (profundo) aqui) Tj 0 0 TD");
    expect(text).toBe("aninhado (profundo) aqui");
  });
});

describe("findStreams", () => {
  it("pairs dictionaries with their payloads and skips endstream markers", () => {
    const pdf =
      "<< /A 1 >>\nstream\nDATA1\nendstream\ntrailing endstream word\n<< /B 2 >>\nstream\nDATA2\nendstream\n";
    const streams = findStreams(pdf);
    expect(streams).toHaveLength(2);
    expect(streams[0]!.data).toBe("DATA1");
    expect(streams[0]!.dict).toContain("/A 1");
    expect(streams[1]!.data).toBe("DATA2");
  });
});

describe("inflateDeflate", () => {
  it("round-trips zlib-compressed data and returns null on garbage", async () => {
    // ASCII payload: the pipeline is byte-faithful latin1, not UTF-8.
    const z = await deflate("conteudo comprimido");
    const out = await inflateDeflate(z);
    expect(bytesToLatin1(out!)).toBe("conteudo comprimido");
    expect(await inflateDeflate(latin1ToBytes("not-deflated-at-all"))).toBeNull();
  });
});

describe("extractPdfText", () => {
  it("extracts text from a FlateDecode content stream (full pipeline)", async () => {
    const bytes = await makePdf([
      "BT /F1 12 Tf 72 720 Td (Receita total: R$ 120.000 no trimestre.) Tj ET",
      "BT (Custos fixos somam R$ 45.000.) Tj ET",
    ]);
    const result = await extractPdfText(bytes);
    expect(result.pages).toHaveLength(2);
    expect(result.totalChars).toBeGreaterThan(40);
    expect(result.pages[0]).toContain("Receita total: R$ 120.000");
    expect(result.pages[1]).toContain("Custos fixos");
  });

  it("reads uncompressed content streams too", async () => {
    const raw = latin1ToBytes(
      '%PDF-1.4\n<< /Length 30 >>\nstream\nBT (texto plano sem filtro) Tj ET\nendstream\n%%EOF',
    );
    const result = await extractPdfText(raw);
    expect(result.pages).toEqual(["texto plano sem filtro"]);
  });

  it("skips image/metadata streams and reports honestly when nothing is readable", async () => {
    // A "scanned" PDF: one big binary-looking image stream, zero text ops.
    const scanned = latin1ToBytes(
      "%PDF-1.4\n<< /Type /XObject /Subtype /Image /Filter /FlateDecode /Width 800 >>\nstream\nBINARYJUNK\nendstream\n%%EOF",
    );
    const none = await extractPdfText(scanned);
    expect(none.pages).toHaveLength(0);
    expect(none.totalChars).toBe(0);

    // Mixed: image stream + one real text stream -> only text survives.
    const mixed = await makePdf(["BT (pagina legivel) Tj ET"]);
    const withJunk = latin1ToBytes(
      bytesToLatin1(mixed).replace(
        "%%EOF",
        "<< /Subtype /Image >>\nstream\nJUNKDATA\nendstream\n%%EOF",
      ),
    );
    const some = await extractPdfText(withJunk);
    expect(some.pages).toEqual(["pagina legivel"]);
  });
});
