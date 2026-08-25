import { describe, expect, it } from "vitest";
import {
  crc32,
  decodeXmlEntities,
  documentXmlToText,
  extractDocxText,
  parseZipDirectory,
  zipReadEntry,
} from "./docx";
import { buildDocxBytes, DOCX_DOCUMENT_XML } from "./testhelpers";

const enc = (s: string) => new TextEncoder().encode(s);

describe("crc32 & xml helpers", () => {
  it("computes standard CRC-32 check values", () => {
    expect(crc32(enc("123456789"))).toBe(0xcbf43926); // canonical CRC-32 vector
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it("decodes numeric, hex and named XML entities incl. ampersand last", () => {
    expect(decodeXmlEntities("&#225;&#x2713;&lt;a&gt;&quot;q&quot;&apos;p&apos;s&amp;n")).toBe(
      "á✓<a>\"q\"'p's&n",
    );
  });
});

describe("documentXmlToText", () => {
  it("glues runs, honors tab/br/cr and closes each paragraph with a newline", () => {
    const xml =
      "<w:body>" +
      "<w:p><w:r><w:t>ab</w:t></w:r><w:r><w:t>cd</w:t></w:r></w:p>" +
      "<w:p><w:r><w:t>x</w:t><w:tab/><w:t>y</w:t><w:br/><w:t>z</w:t><w:cr/><w:t>w</w:t></w:r></w:p>" +
      "</w:body>";
    expect(documentXmlToText(xml)).toBe("abcd\nx\ty\nz\nw\n");
  });

  it("keeps interior blank paragraphs but never trails them; ignores formatting tags", () => {
    const xml =
      "<w:body>" +
      '<w:pPr><w:spacing w:after="200"/></w:pPr>' +
      "<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>one</w:t></w:r></w:p>" +
      "<w:p></w:p>" +
      "<w:p><w:r><w:t>two</w:t></w:r></w:p>" +
      "<w:p></w:p>" +
      "</w:body>";
    expect(documentXmlToText(xml)).toBe("one\n\ntwo\n");
  });
});

describe("zip container reading", () => {
  it("parses the central directory and inflates deflated payloads with CRC verification", async () => {
    const bytes = await buildDocxBytes({ extraParts: { "word/footer1.xml": "<w:ftr><w:p><w:r><w:t>f</w:t></w:r></w:p></w:ftr>" } });
    const dir = parseZipDirectory(bytes);
    expect(dir).not.toBeNull();
    expect(dir!.has("word/document.xml")).toBe(true);
    const entry = dir!.get("word/document.xml")!;
    expect(entry.method).toBe(8);
    const data = await zipReadEntry(bytes, entry, async (b) => {
      const ds = new DecompressionStream("deflate-raw");
      return new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(ds)).arrayBuffer());
    });
    expect(data).not.toBeNull();
    expect(new TextDecoder().decode(data!)).toContain("garantia");
  });

  it("reads STORED (method 0) entries byte-exact (raw XML, entities intact)", async () => {
    const bytes = await buildDocxBytes({ deflate: false });
    const dir = parseZipDirectory(bytes)!;
    const data = await zipReadEntry(bytes, dir.get("word/document.xml")!, async () => null);
    const raw = new TextDecoder().decode(data!);
    expect(raw).toContain("Cl&#225;usula 1&amp;2"); // byte-exact: decoding happens later
    expect(raw.startsWith("<?xml")).toBe(true);
  });

  it("refuses non-zip garbage up front", () => {
    expect(parseZipDirectory(enc("%PDF-1.4 definitely not a zip"))).toBeNull();
    expect(parseZipDirectory(new Uint8Array(10))).toBeNull();
  });
});

describe("extractDocxText", () => {
  it("extracts a deflated document.xml into one page with entities decoded", async () => {
    const out = await extractDocxText(await buildDocxBytes());
    expect(out.pages).toHaveLength(1);
    expect(out.parts).toBe(1);
    expect(out.chars).toBeGreaterThan(20);
    expect(out.pages[0]).toContain("Cláusula 1&2: prazo de garantia");
    expect(out.pages[0]).toContain("multa\trescisória");
  });

  it("orders pages document-first across header/body/footer parts", async () => {
    const out = await extractDocxText(
      await buildDocxBytes({
        extraParts: {
          "word/header1.xml": "<w:hdr><w:p><w:r><w:t>CABEÇALHO</w:t></w:r></w:p></w:hdr>",
          "word/footer1.xml": "<w:ftr><w:p><w:r><w:t>rodapé</w:t></w:r></w:p></w:ftr>",
        },
      }),
    );
    expect(out.pages).toHaveLength(3);
    expect(out.pages[0]!.startsWith("Cláusula")).toBe(true);
    expect(out.pages.some((p) => p.includes("CABEÇALHO"))).toBe(true);
    expect(out.pages.at(-1)).toContain("rodapé");
  });

  it("handles bit-3 streaming entries (data descriptor footer after payload)", async () => {
    const out = await extractDocxText(await buildDocxBytes({ dataDescriptor: true }));
    expect(out.pages[0]).toContain("garantia");
  });

  it("fails honestly on corrupted payloads (CRC mismatch)", async () => {
    await expect(extractDocxText(await buildDocxBytes({ corruptPayload: true }))).rejects.toThrow("corrupt_entry");
  });

  it("fails honestly when sizes lie or method is unsupported", async () => {
    await expect(extractDocxText(await buildDocxBytes({ badSize: true }))).rejects.toThrow("corrupt_entry");
    await expect(extractDocxText(await buildDocxBytes({ badMethod: true }))).rejects.toThrow("corrupt_entry");
  });

  it("reports no_text for missing or text-empty document.xml", async () => {
    await expect(extractDocxText(enc("PK just junk, no central directory"))).rejects.toThrow("no_text");
    await expect(
      extractDocxText(await buildDocxBytes({ documentXml: "<w:document><w:body></w:body></w:document>" })),
    ).rejects.toThrow("no_text");
  });

  it("fixture sanity: every built container starts with the PK magic", async () => {
    const bytes = await buildDocxBytes();
    expect(String.fromCharCode(bytes[0]!, bytes[1]!)).toBe("PK");
    expect(DOCX_DOCUMENT_XML).toContain("garantia"); // guard against fixture drift
  });
});
