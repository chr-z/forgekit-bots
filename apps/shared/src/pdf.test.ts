import { describe, expect, it } from "vitest";
import { makeContentStream, renderPdf } from "./pdf";

const DOC = {
  title: "Contrato social",
  author: "DocuMind",
  tldr: "Pergunta sobre garantia?",
  tldrLabel: "Pergunta",
  bullets: ["[1] O prazo de garantia é de doze meses."],
};

function latin1(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

describe("shared pdf writer", () => {
  it("honors tldrLabel override for non-summary domains", () => {
    const s = makeContentStream(DOC);
    expect(s).toContain("(Pergunta: Pergunta sobre garantia?) Tj");
    expect(s).not.toContain("(TLDR:");
  });

  it("falls back to the TLDR label when none is given", () => {
    const s = makeContentStream({ ...DOC, tldrLabel: undefined });
    expect(s).toContain("(TLDR:");
  });

  it("uses a neutral default title instead of YouTube wording", () => {
    const s = makeContentStream({ ...DOC, title: undefined });
    expect(s.startsWith("BT\n/F1 11 Tf")).toBe(true);
    expect(s).toContain("(Documento) Tj");
    expect(s).not.toContain("YouTube");
  });

  it("renders a structurally valid PDF 1.4", async () => {
    const bytes = await renderPdf(DOC);
    const raw = latin1(bytes);
    expect(raw.startsWith("%PDF-1.4")).toBe(true);
    expect(raw.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(raw).toContain("/Filter /FlateDecode");
  });
});
