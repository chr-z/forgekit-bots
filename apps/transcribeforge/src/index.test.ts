import { describe, expect, it } from "vitest";
import { pickAudioTarget, renderOutputs } from "./index";
import type { TgUpdate } from "@forgekit/app-shared/botapi";

function updateWith(media: Record<string, unknown>): TgUpdate {
  return {
    update_id: 1,
    message: { message_id: 5, chat: { id: 42, type: "private" }, ...media },
  } as unknown as TgUpdate;
}

describe("pickAudioTarget", () => {
  it("accepts voice, audio, video_note and video", () => {
    for (const kind of ["voice", "audio", "video_note", "video"]) {
      const t = pickAudioTarget(updateWith({ [kind]: { file_id: "f1", duration: 91 } }));
      expect(t).toMatchObject({ fileId: "f1", durationSeconds: 91 });
    }
  });

  it("accepts documents only with a/v mime types", () => {
    expect(pickAudioTarget(updateWith({ document: { file_id: "d1", mime_type: "audio/ogg" } })))
      .toMatchObject({ fileId: "d1" });
    expect(pickAudioTarget(updateWith({ document: { file_id: "d2", mime_type: "application/pdf" } }))).toBeNull();
  });

  it("rejects plain text messages and empty updates", () => {
    expect(pickAudioTarget(updateWith({ text: "/start" }))).toBeNull();
    expect(pickAudioTarget({ update_id: 9 } as TgUpdate)).toBeNull();
  });
});

describe("renderOutputs", () => {
  it("builds srt/vtt/txt from word timings", () => {
    const out = renderOutputs({
      text: "Olá mundo. Outra frase.",
      words: [
        { word: "Olá", start: 0, end: 0.4 },
        { word: "mundo.", start: 0.5, end: 1 },
        { word: "Outra", start: 2, end: 2.3 },
        { word: "frase.", start: 2.4, end: 3 },
      ],
    });
    expect(out.txt).toContain("Olá mundo.");
    expect(out.srt).toContain("-->");
    expect(out.vtt.startsWith("WEBVTT")).toBe(true);
  });

  it("falls back to a single segment when only text exists", () => {
    const out = renderOutputs({ text: "Só texto." });
    expect(out.txt).toBe("Só texto.\n");
    expect(out.srt).toContain("Só texto.");
  });
});
