import { describe, expect, it } from "vitest";
import { FREE_DAILY_LIMIT, resolveMode, runSummaryPipeline, SUMMARIZETUBE_CATALOG } from "./index";

const VIDEO_ID = "dQw4w9WgXcQ";

const WATCH_HTML = `<html><script>
var ytInitialPlayerResponse = {
  videoDetails: { title: "Aula completa", author: "@prof", lengthSeconds: "3725" },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        { baseUrl: "https://www.youtube.com/api/timedtext?lang=pt-BR&v=${VIDEO_ID}", languageCode: "pt-BR" }
      ]
    }
  }
};
</script></html>`;

const SENTENCE = "Nesta aula voce vai aprender conceitos fundamentais passo a passo.";

function makeCues(): string {
  const events = Array.from({ length: 30 }, (_, i) => ({
    tStartMs: i * 2000,
    dDurationMs: 1900,
    segs: [{ utf8: `${SENTENCE} [${i}]` }],
  }));
  return JSON.stringify({ events });
}

/** Full happy-path fetch fake: watch page + timedtext json3. */
function makeFetcher(opts: { noCaptionsTrack?: boolean; captionsFail?: boolean; pageFail?: boolean; watchHtml?: string } = {}) {
  const html =
    opts.watchHtml ??
    (opts.noCaptionsTrack
    ? `var ytInitialPlayerResponse = {"videoDetails":{"title":"x"},"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[]}}};`
    : WATCH_HTML);
  return ((input: unknown) => {
    const url = String(input);
    if (url.includes("/watch?v=")) {
      if (opts.pageFail) return Promise.resolve(new Response("consent wall", { status: 429 }));
      return Promise.resolve(new Response(html, { status: 200 }));
    }
    if (url.includes("/api/timedtext")) {
      if (opts.captionsFail) return Promise.reject(new Error("conn reset"));
      return Promise.resolve(new Response(makeCues(), { status: 200 }));
    }
    return Promise.resolve(new Response("nf", { status: 404 }));
  }) as typeof fetch;
}

function makeAi(responses: string[]) {
  let call = 0;
  return {
    run: async (_model: string, _input: unknown): Promise<unknown> => ({
      response: responses[Math.min(call++, responses.length - 1)] ?? "",
    }),
  } as unknown as Ai;
}

describe("SUMMARIZETUBE_CATALOG", () => {
  it("sells Pro subscription and credit pack for Stars only", () => {
    expect(SUMMARIZETUBE_CATALOG).toHaveLength(2);
    const sub = SUMMARIZETUBE_CATALOG.find((p) => p.kind === "subscription");
    const pack = SUMMARIZETUBE_CATALOG.find((p) => p.kind === "credits");
    expect(sub?.priceInStars).toBe(200);
    expect(sub?.proDays).toBe(30);
    expect(pack?.priceInStars).toBe(150);
    expect(pack?.creditsAmount).toBe(100);
    // roadmap pricing anchor
    expect(FREE_DAILY_LIMIT).toBe(3);
  });
});

describe("resolveMode", () => {
  it("deep mode is Pro-only, triggered by keyword in any language", () => {
    expect(resolveMode(true, "https://youtu.be/x deep").deep).toBe(true);
    expect(resolveMode(true, "/summarize https://youtu.be/x PROFUNDO").deep).toBe(true);
    expect(resolveMode(false, "https://youtu.be/x deep").deep).toBe(false); // free user
    expect(resolveMode(true, "https://youtu.be/x").deep).toBe(false); // no keyword
  });
});

describe("runSummaryPipeline", () => {
  it("happy path with AI: TLDR + bullets + meta header", async () => {
    const result = await runSummaryPipeline(
      { videoId: VIDEO_ID, deep: false },
      { fetchImpl: makeFetcher(), ai: makeAi(["TLDR: Aula sobre fundamentos.\n- ponto com [00:12]"]) },
    );
    expect(result.ok).toBe(true);
    expect(result.reply).toContain("📹 Aula completa");
    expect(result.reply).toContain("@prof");
    expect(result.reply).toContain("1:02:05"); // 3725s
    expect(result.reply).toContain("💡 Aula sobre fundamentos.");
    expect(result.reply).toContain("• ponto com [00:12]");
  });

  it("multi-chunk transcripts trigger the reduce pass in deep mode", async () => {
    // 12000-char budget -> the repeated sentence list must exceed one chunk
    const longSentence = `${SENTENCE} `.repeat(80);
    const events = Array.from({ length: 400 }, (_, i) => ({
      tStartMs: i * 3000,
      dDurationMs: 2900,
      segs: [{ utf8: `${longSentence} Fim do bloco ${i}.` }],
    }));
    const bigFetcher = ((input: unknown) => {
      const url = String(input);
      if (url.includes("/api/timedtext")) {
        return Promise.resolve(new Response(JSON.stringify({ events }), { status: 200 }));
      }
      return Promise.resolve(new Response(WATCH_HTML, { status: 200 }));
    }) as typeof fetch;

    let reduceSeen = false;
    const ai = {
      run: async (_m: string, input: unknown): Promise<unknown> => {
        const content = JSON.stringify(input);
        if (content.includes("Merge them into a final summary")) reduceSeen = true;
        return {
          response:
            content.includes("Merge them into a final summary")
              ? "TLDR: fundido.\n- x [00:10]"
              : "- parcial [00:01]",
        };
      },
    } as unknown as Ai;

    const result = await runSummaryPipeline(
      { videoId: VIDEO_ID, deep: true },
      { fetchImpl: bigFetcher, ai },
    );
    expect(result.ok).toBe(true);
    expect(reduceSeen).toBe(true);
    expect(result.reply).toContain("modo profundo");
  });

  it("degrades to extractive fallback when AI is absent or empty", async () => {
    const noAi = await runSummaryPipeline(
      { videoId: VIDEO_ID, deep: true }, // deep ignored without AI
      { fetchImpl: makeFetcher() },
    );
    expect(noAi.ok).toBe(true);
    expect(noAi.reply).toContain("[00:0"); // timestamped block openers

    const deadAi = await runSummaryPipeline(
      { videoId: VIDEO_ID, deep: false },
      { fetchImpl: makeFetcher(), ai: makeAi([""]) },
    );
    expect(deadAi.ok).toBe(true);
    expect(deadAi.reply).toContain("[00:0");
  });

  it("reports no_captions distinctly from hard failures", async () => {
    const none = await runSummaryPipeline(
      { videoId: VIDEO_ID, deep: false },
      { fetchImpl: makeFetcher({ noCaptionsTrack: true }) },
    );
    expect(none.ok).toBe(false);
    expect(none.reason).toBe("no_captions");

    const broken = await runSummaryPipeline(
      { videoId: VIDEO_ID, deep: false },
      { fetchImpl: makeFetcher({ pageFail: true }) },
    );
    expect(broken.ok).toBe(false);
    expect(broken.reason).toBe("failed");

    const connReset = await runSummaryPipeline(
      { videoId: VIDEO_ID, deep: false },
      { fetchImpl: makeFetcher({ captionsFail: true }) },
    );
    expect(connReset.reason).toBe("failed");
  });
});

describe("chapters/topics in the pipeline", () => {
  const CHAPTER_HTML = `<html><script>
var ytInitialPlayerResponse = {
  videoDetails: { title: "Aula completa", author: "@prof", lengthSeconds: "3725",
    shortDescription: "Links na descricao\\n0:00 Intro\\n1:23 Ambiente\\n10:45 Deploy final" },
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        { baseUrl: "https://www.youtube.com/api/timedtext?lang=pt-BR&v=${VIDEO_ID}", languageCode: "pt-BR" }
      ]
    }
  }
};
</script></html>`;

  function makeLongCues(): string {
    // ~4 min of speech across 120 cues (~14k chars) so chunkTranscript
    // yields more than one map pass and deep mode actually engages.
    const events = Array.from({ length: 120 }, (_, i) => ({
      tStartMs: i * 2000,
      dDurationMs: 1900,
      segs: [{ utf8: `${SENTENCE} numero ${i} sobre topicos distintos da aula. [${i}]` }],
    }));
    return JSON.stringify({ events });
  }

  function makeCuedFetcher(): typeof fetch {
    return ((input: unknown) => {
      const url = String(input);
      if (url.includes("/watch?v=")) return Promise.resolve(new Response(WATCH_HTML, { status: 200 }));
      if (url.includes("/api/timedtext")) return Promise.resolve(new Response(makeLongCues(), { status: 200 }));
      return Promise.resolve(new Response("nf", { status: 404 }));
    }) as typeof fetch;
  }

  it("free summary shows creator chapters from the description with zero extra AI calls", async () => {
    let aiCalls = 0;
    const ai = {
      run: async (): Promise<unknown> => {
        aiCalls++;
        return { response: "TLDR: Aula sobre fundamentos.\n- ponto com [00:12]" };
      },
    } as unknown as Ai;
    const out = await runSummaryPipeline(
      { videoId: VIDEO_ID, deep: false },
      { fetchImpl: makeFetcher({ watchHtml: CHAPTER_HTML }), ai },
    );
    expect(out.ok).toBe(true);
    expect(out.reply).toContain("📚 Topicos:");
    expect(out.reply).toContain("\n  0:00 Intro");
    expect(out.reply).toContain("\n  10:45 Deploy final");
    expect(out.reply).not.toContain("(modo profundo)");
    // Chapters are deterministic — free tier pays exactly one map pass.
    expect(aiCalls).toBe(1);
  });

  it("deep mode without chapters runs the extra AI topics pass", async () => {
    let call = 0;
    const prompts: string[] = [];
    const ai = {
      run: async (_model: string, input: unknown): Promise<unknown> => {
        const msgs = (input as { messages?: { content: string }[] }).messages ?? [];
        prompts.push(msgs[msgs.length - 1]?.content ?? "");
        call++;
        if (call <= 2) return { response: `Parcial ${call}: conteudo suficiente com [00:${call}0].` };
        if (call === 3)
          return { response: "TLDR: Aula completa.\n- ponto A [00:30]\n- ponto B [01:10]\n- ponto C [02:00]" };
        return {
          response: "- [00:00] Introducao\n- [01:00] Metodologia\n- [02:30] Encerramento",
        };
      },
    } as unknown as Ai;
    const out = await runSummaryPipeline(
      { videoId: VIDEO_ID, deep: true },
      { fetchImpl: makeCuedFetcher(), ai },
    );
    expect(out.ok).toBe(true);
    // 2 map passes + 1 reduce + 1 topics pass.
    expect(call).toBe(4);
    expect(prompts[3]).toContain("table of contents");
    expect(prompts[3]).toContain("- [mm:ss] Short topic name");
    expect(out.reply).toContain("(modo profundo)");
    expect(out.reply).toContain("💡 Aula completa.");
    expect(out.reply).toContain("📚 Topicos:");
    expect(out.reply).toContain("\n  1:00 Metodologia");
    expect(out.reply).toContain("\n  2:30 Encerramento");
  });
});
