import { describe, expect, it } from "vitest";
import {
  buildTimestampIndex,
  chunkTranscript,
  cuesToTranscript,
  decodeEntities,
  extractPlayerResponse,
  parseCaptionsXml,
  parseJson3,
  parseVideoId,
  pickCaptionTrack,
} from "./youtube";

const WATCH_HTML = `
<html><script>
var ytInitialPlayerResponse = {responseContext:{visitorData:"x"}};
</script>
<script>
let ytcfg = {};
var ytInitialPlayerResponse = {
  videoDetails: {
    title: "Como construir um Worker",
    author: "Canal do Zee",
    lengthSeconds: "7315"
  },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        { baseUrl: "https://www.youtube.com/api/timedtext?lang=en&v=abc123XYZ_-", languageCode: "en" },
        { baseUrl: "https://www.youtube.com/api/timedtext?lang=pt-BR&v=abc123XYZ_-", languageCode: "pt-BR", kind: "asr" }
      ]
    }
  }
};
</script></html>
`;

const JSON3_BODY = JSON.stringify({
  events: [
    { tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: "Olá" }, { utf8: " mundo." }] },
    { tStartMs: 1500, dDurationMs: 1000, segs: [{ utf8: "Segunda linha" }] },
    { tStartMs: 2500, dDurationMs: 800, segs: [{ utf8: "\n" }] }, // empty -> dropped
  ],
});

const XML_BODY = `<?xml version="1.0" encoding="utf-8"?>
<transcript>
  <text start="0.5" dur="2.0">Primeira &amp; frase</text>
  <text start="12.4" dur="2.1">Segunda &lt;frase&gt; com tags</text>
  <text start="15.0" dur="1.0">   </text>
</transcript>`;

function pageFetcher(html: string): typeof fetch {
  return ((input: unknown) => {
    const url = String(input);
    if (url.includes("/watch?v=")) {
      return Promise.resolve(new Response(html, { status: 200 }));
    }
    if (url.includes("/api/timedtext")) {
      return Promise.resolve(new Response(JSON3_BODY, { status: 200 }));
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  }) as typeof fetch;
}

describe("parseVideoId", () => {
  it("accepts every common YouTube URL shape and bare ids", () => {
    expect(parseVideoId("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(parseVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(parseVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s")).toBe(
      "dQw4w9WgXcQ",
    );
    expect(parseVideoId("https://m.youtube.com/shorts/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(parseVideoId("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(parseVideoId("https://www.youtube.com/live/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(parseVideoId("https://youtube-nocookie.com/embed/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    // 11-char alphabet only
    expect(parseVideoId("short-11ch!")).toBeNull();
  });

  it("rejects non-youtube hosts and garbage", () => {
    expect(parseVideoId("https://vimeo.com/12345678901")).toBeNull();
    expect(parseVideoId("https://tiktok.com/@user/video/123")).toBeNull();
    expect(parseVideoId("https://youtu.be/tooshort")).toBeNull();
    expect(parseVideoId("not a url at all")).toBeNull();
    expect(parseVideoId("")).toBeNull();
  });
});

describe("extractPlayerResponse", () => {
  it("finds the right assignment among multiple markers", () => {
    const pr = extractPlayerResponse(WATCH_HTML);
    expect(pr).not.toBeNull();
    expect(pr?.videoDetails?.title).toBe("Como construir um Worker");
    expect(pr?.videoDetails?.author).toBe("Canal do Zee");
    expect(pr?.videoDetails?.lengthSeconds).toBe("7315");
    expect(pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks).toHaveLength(2);
  });

  it("returns null on pages without the blob or with broken JSON", () => {
    expect(extractPlayerResponse("<html>nothing here</html>")).toBeNull();
    expect(extractPlayerResponse('var ytInitialPlayerResponse = {"broken":')).toBeNull();
  });
});

describe("pickCaptionTrack", () => {
  it("prefers manual over ASR, then follows language preference", () => {
    const tracks = extractPlayerResponse(WATCH_HTML)!.captions!.playerCaptionsTracklistRenderer!
      .captionTracks!;
    // pt-BR exists but is asr; en is manual -> manual wins
    const track = pickCaptionTrack(tracks);
    expect(track?.languageCode).toBe("en");
    expect(track?.kind).toBeUndefined();

    // without the manual en track, pt-BR asr is chosen
    const asrOnly = tracks.filter((t) => t.languageCode === "pt-BR");
    expect(pickCaptionTrack(asrOnly)?.languageCode).toBe("pt-BR");
    // base-language match: "pt" preference matches "pt-BR" track
    expect(pickCaptionTrack(asrOnly, ["pt"])?.languageCode).toBe("pt-BR");
    // no matching language -> first track
    expect(pickCaptionTrack(asrOnly, ["ja"])?.languageCode).toBe("pt-BR");
    expect(pickCaptionTrack([])).toBeNull();
  });
});

describe("caption parsing", () => {
  it("parses json3 events into cues, dropping empties", () => {
    const cues = parseJson3(JSON3_BODY);
    expect(cues).toHaveLength(2);
    expect(cues?.[0]).toEqual({ start: 0, duration: 1.5, text: "Olá mundo." });
    expect(cues?.[1]?.start).toBe(1.5);
  });

  it("parses legacy XML with entity decoding and tag stripping", () => {
    const cues = parseCaptionsXml(XML_BODY);
    expect(cues).toHaveLength(2);
    expect(cues?.[0]?.text).toBe("Primeira & frase");
    expect(cues?.[1]?.text).toBe("Segunda <frase> com tags");
  });

  it("decodeEntities handles numeric refs and ampersand ordering", () => {
    expect(decodeEntities("a &amp; b &#39;c&#39;")).toBe("a & b 'c'");
    expect(decodeEntities("&amp;amp;")).toBe("&amp;");
  });
});

describe("cuesToTranscript + timestamp index", () => {
  const cues = [
    { start: 0, duration: 1, text: "Primeira sentença." },
    { start: 10, duration: 1, text: "Segunda sentença!" },
    { start: 50, duration: 1, text: "Terceira?" },
    { start: 50.2, duration: 1, text: "Terceira?" }, // rolling dup dropped
    { start: 130, duration: 2, text: "Quarta frase final." },
  ];

  it("joins cues into sentences and drops exact repeats", () => {
    const transcript = cuesToTranscript(cues);
    expect(transcript.split("\n")).toHaveLength(4);
    expect(transcript).toContain("Primeira sentença.");
    expect(transcript).toContain("Quarta frase final.");
    expect(transcript.match(/Terceira\?/g)).toHaveLength(1);
  });

  it("builds [mm:ss] blocks of ~45s", () => {
    const index = buildTimestampIndex(cues);
    expect(index).toContain("[00:00] Primeira sentença. Segunda sentença!");
    expect(index).toContain("[00:50]");
    expect(index).toContain("[02:10] Quarta");
    expect(index.split("\n").length).toBeGreaterThanOrEqual(3);
  });
});

describe("chunkTranscript", () => {
  it("never splits mid-sentence unless a single sentence exceeds the budget", () => {
    const sentences = Array.from({ length: 40 }, (_, i) => `Frase numero ${i} qualquer.`);
    const chunks = chunkTranscript(sentences.join(" "), 120);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(120);
      expect(chunk.trim()).toMatch(/qualquer\.$|[.!?…]$/);
    }
    // reassembly preserves all content words
    const joined = chunks.join(" ").replace(/\s+/g, " ");
    expect(joined).toContain("Frase numero 0");
    expect(joined).toContain("Frase numero 39");

    // monster sentence gets hard-split at exactly maxChars boundaries
    const monster = "a".repeat(300) + ".";
    const hardChunks = chunkTranscript(monster, 120);
    expect(hardChunks).toHaveLength(3);
    expect(hardChunks[0]).toHaveLength(120);
  });

  it("returns empty array for empty input", () => {
    expect(chunkTranscript("", 500)).toEqual([]);
  });
});
