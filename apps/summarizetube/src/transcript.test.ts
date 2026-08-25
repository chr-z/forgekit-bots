import { describe, expect, it } from "vitest";
import {
  renderTranscriptPdf,
  renderTranscriptReply,
  toPlainTextFile,
  transcriptDocKey,
  TRANSCRIPT_INLINE_LIMIT,
  type TranscriptDoc,
} from "./transcript";

const DOC: TranscriptDoc = {
  title: "Aula completa",
  author: "@prof",
  durationSeconds: 3725,
  languageCode: "pt-BR",
  text: "Primeira frase da aula.\nSegunda frase com mais contexto.\nTerceira frase fecha o bloco.",
};

describe("transcript module", () => {
  it("caches under a namespaced per-user key", () => {
    expect(transcriptDocKey(321)).toBe("summarizetube:lasttranscript:321");
  });

  it("renders short transcripts fully inline with the meta header", () => {
    const { reply, truncated } = renderTranscriptReply(DOC);
    expect(truncated).toBe(false);
    expect(reply).toContain("📹 Aula completa");
    expect(reply).toContain("👤 @prof");
    expect(reply).toContain("1:02:05");
    expect(reply).toContain("🌐 pt-BR");
    expect(reply).toContain("Terceira frase fecha o bloco.");
    expect(reply.length).toBeLessThan(TRANSCRIPT_INLINE_LIMIT);
  });

  it("previews long transcripts at a paragraph boundary and hints the size", () => {
    const paragraphs = Array.from({ length: 200 }, (_, i) => `Bloco ${i}: frase com algumas palavras.`);
    const long: TranscriptDoc = { ...DOC, text: paragraphs.join("\n") };
    const { reply, truncated } = renderTranscriptReply(long, {
      moreHint: "(+{chars} characters total)",
    });
    expect(truncated).toBe(true);
    expect(reply).toContain("(+");
    expect(reply).toContain("characters total");
    // preview must not leak past the limit nor end mid-paragraph
    expect(reply).toContain("Bloco 0:");
    expect(reply).not.toContain("Bloco 199:");
    const previewLines = reply.split("\n").filter((l) => l.startsWith("Bloco "));
    for (const line of previewLines) {
      expect(line.endsWith(".")).toBe(true);
    }
    // every shown paragraph must be complete
    expect(previewLines.every((l) => paragraphs.includes(l))).toBe(true);
  });

  it("builds a plain-text file with a small metadata block", () => {
    const txt = toPlainTextFile(DOC);
    expect(txt).toContain("Title: Aula completa");
    expect(txt).toContain("Channel: @prof");
    expect(txt).toContain("Duration: 1:02:05");
    expect(txt).toContain("Language: pt-BR");
    expect(txt).toContain("Segunda frase com mais contexto.");
    const minimal = toPlainTextFile({ text: "so the text" });
    expect(minimal).toBe("so the text\n");
  });

  it("renders a real PDF whose paragraphs survive inflation", async () => {
    const bytes = await renderTranscriptPdf({
      ...DOC,
      title: "Açúcar & café — aula 3",
      text: "Primeiro parágrafo com acentuação: avô, coração, você.\nSegundo parágrafo.",
    });
    const raw = Buffer.from(bytes).toString("latin1");
    expect(raw.startsWith("%PDF-1.4")).toBe(true);
    expect(raw.trimEnd().endsWith("%%EOF")).toBe(true);

    // inflate the content stream and check the text made it through WinAnsi
    // (skip the EOL after "stream" — feeding it to zlib corrupts inflation)
    const lenMatch = raw.match(/\/Length (\d+) \/Filter/)!;
    const start = raw.indexOf("stream\n") + "stream\n".length;
    if (!lenMatch || start < "stream\n".length) throw new Error("no stream found");
    const ds = new DecompressionStream("deflate");
    const buf = await new Response(
      new Blob([bytes.subarray(start, start + Number(lenMatch[1]))] as BlobPart[]).stream().pipeThrough(ds),
    ).arrayBuffer();
    let inflated = "";
    for (const b of new Uint8Array(buf)) inflated += String.fromCharCode(b);
    expect(inflated.startsWith("BT")).toBe(true);
    expect(inflated).toContain("Açúcar"); // WinAnsi title survived
    expect(inflated).toContain("Primeiro parágrafo");
    expect(inflated).toContain("Segundo parágrafo");
  });
});
