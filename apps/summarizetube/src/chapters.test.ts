import { describe, expect, it } from "vitest";
import {
  fmtStamp,
  MAX_CHAPTERS,
  MIN_CHAPTERS,
  parseChapters,
  renderChapters,
} from "./youtube";
import {
  parseTopics,
  renderSummary,
  renderTopics,
  topicsMessages,
} from "./summarizer";

const CANONICAL = [
  "Aula show de links:",
  "0:00 Intro",
  "1:23 Configurando o ambiente",
  "10:45 Deploy final",
].join("\n");

describe("parseChapters", () => {
  it("parses canonical creator descriptions into ascending chapters", () => {
    const chapters = parseChapters(CANONICAL);
    expect(chapters).toHaveLength(3);
    expect(chapters[0]).toEqual({ start: 0, label: "Intro" });
    expect(chapters[1]!.start).toBe(83);
    expect(chapters[1]!.label).toBe("Configurando o ambiente");
    expect(chapters[2]!.start).toBe(645);
  });

  it("needs at least MIN_CHAPTERS stamps and skips junk lines", () => {
    expect(parseChapters("0:00 um\n1:00 dois")).toHaveLength(0);
    const noisy = ["inscreva-se no canal!!", "0:00 um", "", "1:00 dois", "link: https://x.co", "2:00 tres"].join("\n");
    expect(parseChapters(noisy)).toHaveLength(3);
    expect(MIN_CHAPTERS).toBe(3);
  });

  it("requires strictly increasing stamps", () => {
    const backwards = ["5:00 primeiro", "2:00 mais cedo", "9:00 depois"].join("\n");
    expect(parseChapters(backwards)).toHaveLength(0);
  });

  it("accepts h:mm:ss, bullet prefixes and caps at MAX_CHAPTERS", () => {
    expect(parseChapters("0:00 aa\n2:00 bb\n1:02:03 cc")![2]!.start).toBe(3723);
    expect(parseChapters("- 0:00 aa\n* 1:00 bb\n- 2:00 cc")).toHaveLength(3);
    const many = Array.from({ length: 14 }, (_, i) => `${i}:00 topico ${i}`).join("\n");
    expect(parseChapters(many)).toHaveLength(MAX_CHAPTERS);
  });
});

describe("fmtStamp / renderChapters", () => {
  it("formats stamps like YouTube does", () => {
    expect(fmtStamp(0)).toBe("0:00");
    expect(fmtStamp(1025)).toBe("17:05");
    expect(fmtStamp(3725)).toBe("1:02:05");
  });

  it("renders an empty block for no chapters and an indented section otherwise", () => {
    expect(renderChapters([])).toBe("");
    const block = renderChapters(parseChapters(CANONICAL));
    expect(block).toContain("Topicos:");
    expect(block).toContain("\n  0:00 Intro");
    expect(block).toContain("\n  10:45 Deploy final");
  });
});

describe("AI topics pass", () => {
  it("asks for a timestamped table of contents over the index", () => {
    const msgs = topicsMessages("[00:00] bloco um");
    expect(msgs[1]!.content).toContain("[00:00] bloco um");
    expect(msgs[1]!.content).toContain("- [mm:ss] Short topic name");
  });

  it("parses mm:ss vs h:mm:ss unambiguously and needs >= 3 topics", () => {
    const out = parseTopics(
      ["- 12:34 Primeira parte", "- 1:02:03 Segunda parte", "* 59:59 Terceira"].join("\n"),
    );
    expect(out.map((t) => t.start)).toEqual([754, 3723, 3599]);
    expect(out[0]!.label).toBe("Primeira parte");
    expect(parseTopics("- 1:00 so isso")).toHaveLength(0);
    expect(parseTopics("bla bla sem formato nenhum")).toHaveLength(0);
  });

  it("renders topics like chapters; label-only rows stay stamp-free", () => {
    expect(renderTopics([])).toBe("");
    const block = renderTopics([{ start: 754, label: "A" }, { label: "B" }]);
    expect(block).toContain("12:34 A");
    expect(block).toContain("\n  B");
  });
});

describe("renderSummary extras slot", () => {
  it("keeps the legacy shape and appends the extras block before the deep tag", () => {
    const base = renderSummary({}, { tldr: "x", bullets: ["b"] }, false);
    expect(base).not.toContain("Topicos:");
    const withExtras = renderSummary(
      {},
      { tldr: "x", bullets: ["b"] },
      true,
      "\n📚 Topicos:\n  0:00 Intro",
    );
    expect(withExtras).toContain("• b\n\n📚 Topicos:\n  0:00 Intro\n\n(modo profundo)");
  });
});
