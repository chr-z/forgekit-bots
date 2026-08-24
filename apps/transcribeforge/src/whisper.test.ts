import { describe, expect, it } from "vitest";
import { wordsToSegments, type WhisperWord } from "./whisper";

function w(word: string, start: number, end: number): WhisperWord {
  return { word, start, end };
}

describe("wordsToSegments", () => {
  it("splits on sentence endings", () => {
    const segs = wordsToSegments([
      w("Olá", 0, 0.5),
      w("mundo.", 0.6, 1.0),
      w("Segunda", 2.0, 2.4),
      w("frase.", 2.5, 3.0),
    ]);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ start: 0, end: 1.0, text: "Olá mundo." });
    expect(segs[1]).toMatchObject({ start: 2.0, text: "Segunda frase." });
  });

  it("breaks long runs by character budget", () => {
    const segs = wordsToSegments(
      [w("palavra", 0, 0.3), w("mais", 0.4, 0.6), w("uma", 0.7, 0.9), w("vez", 1.0, 1.2), w("aqui", 1.3, 1.5)],
      20,
    );
    expect(segs.length).toBeGreaterThan(1);
  });

  it("breaks on large gaps even without punctuation", () => {
    const segs = wordsToSegments([
      w("antes", 0, 0.4),
      w("do", 0.5, 0.7),
      w("silêncio", 10, 10.5), // 9.3s gap
    ]);
    expect(segs).toHaveLength(2);
    expect(segs[1]!.start).toBe(10);
  });

  it("skips empty tokens and empty arrays", () => {
    expect(wordsToSegments([])).toEqual([]);
    expect(wordsToSegments([w("", 0, 1), w("ok", 1, 2)])).toHaveLength(1);
  });
});
