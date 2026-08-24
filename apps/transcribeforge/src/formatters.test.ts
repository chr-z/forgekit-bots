import { describe, expect, it } from "vitest";
import { formatTimestamp, toSrt, toTxt, toVtt, type Segment } from "./formatters";

const segs: Segment[] = [
  { start: 0, end: 1.5, text: "Olá mundo." },
  { start: 1.5, end: 4.02, text: " Segunda linha " },
  { start: 3671.25, end: 3675, text: "Fim na hora certa." },
];

describe("formatTimestamp", () => {
  it("formats hours, minutes and millis", () => {
    expect(formatTimestamp(0, ",")).toBe("00:00:00,000");
    expect(formatTimestamp(1.5, ",")).toBe("00:00:01,500");
    expect(formatTimestamp(3671.25, ",")).toBe("01:01:11,250");
    expect(formatTimestamp(-5, ".")).toBe("00:00:00.000"); // clamps negatives
  });
});

describe("toSrt", () => {
  it("numbers cues and uses comma timings", () => {
    const srt = toSrt(segs);
    expect(srt).toContain("1\n00:00:00,000 --> 00:00:01,500\nOlá mundo.");
    expect(srt).toContain("2\n00:00:01,500 --> 00:00:04,020\nSegunda linha");
    expect(srt.endsWith("\n")).toBe(true);
  });
});

describe("toVtt", () => {
  it("starts with WEBVTT header and dot timings", () => {
    const vtt = toVtt(segs);
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt).toContain("00:00:00.000 --> 00:00:01.500");
  });

  it("emits a bare header for empty input", () => {
    expect(toVtt([])).toBe("WEBVTT\n");
  });
});

describe("toTxt", () => {
  it("joins trimmed text with single spaces", () => {
    expect(toTxt(segs)).toBe("Olá mundo. Segunda linha Fim na hora certa.\n");
  });

  it("handles empty input", () => {
    expect(toTxt([])).toBe("\n");
  });
});
