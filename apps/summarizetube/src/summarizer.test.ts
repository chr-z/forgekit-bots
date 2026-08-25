import { describe, expect, it } from "vitest";
import {
  aiSummarize,
  chat,
  extractiveFallback,
  mapMessages,
  parseModelSummary,
  reduceMessages,
  renderSummary,
  type ChatMessage,
} from "./summarizer";

function fakeAi(responses: string[]) {
  let call = 0;
  return {
    ai: {
      run: async (_model: string, _input: unknown): Promise<unknown> => ({
        response: responses[Math.min(call++, responses.length - 1)] ?? "",
      }),
    } as unknown as Ai,
    calls: () => call,
  };
}

describe("parseModelSummary", () => {
  it("parses the canonical TLDR + bullets shape", () => {
    const parsed = parseModelSummary(
      "TLDR: Um tutorial completo de Workers.\n- Intro com [00:12]\n- Deploy no final [08:40]\n\n",
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.tldr).toBe("Um tutorial completo de Workers.");
    expect(parsed?.bullets).toEqual(["Intro com [00:12]", "Deploy no final [08:40]"]);
  });

  it("survives models that ignore the format", () => {
    // bullets only -> first bullet becomes tldr
    const bulletsOnly = parseModelSummary("- ponto um\n- ponto dois");
    expect(bulletsOnly?.bullets).toHaveLength(2);
    expect(bulletsOnly?.tldr).toBe("ponto um");

    // prose only -> short line becomes tldr
    const proseOnly = parseModelSummary("Aqui vai um resumo em prosa do vídeo inteiro, mas curto.");
    expect(proseOnly?.tldr).toContain("resumo em prosa");
    expect(proseOnly?.bullets).toHaveLength(0);

    // garbage -> null
    expect(parseModelSummary("")).toBeNull();
    expect(parseModelSummary("...")).toBeNull();
  });

  it("keeps bullets that are shorter than the minimum when they carry content", () => {
    const parsed = parseModelSummary("- ok\n- ponto válido aqui");
    // "- ok" is under 4 chars of body -> not captured as a bullet
    expect(parsed?.bullets).toEqual(["ponto válido aqui"]);
  });
});

describe("prompt builders", () => {
  it("map messages carry the chunk and part numbering", () => {
    const msgs: ChatMessage[] = mapMessages("CONTEUDO_AQUI", 2, 3);
    expect(msgs[0]?.role).toBe("system");
    expect(msgs[1]?.role).toBe("user");
    expect(msgs[1]?.content).toContain("part 2/3");
    expect(msgs[1]?.content).toContain("CONTEUDO_AQUI");
    expect(msgs[1]?.content).toContain("[mm:ss]");
  });

  it("reduce messages ask for deeper bullet ranges in deep mode", () => {
    const shallow = reduceMessages(["a", "b"], false);
    const deep = reduceMessages(["a", "b"], true);
    expect(shallow[1]?.content).toContain("5 and 8");
    expect(deep[1]?.content).toContain("8 and 14");
  });
});

describe("chat + aiSummarize", () => {
  it("extracts the string response from the AI binding", async () => {
    const { ai } = fakeAi(["ok"]);
    expect(await chat(ai, "m", [{ role: "user", content: "hi" }])).toBe("ok");
  });

  it("map-reduces chunks; single chunk skips the reduce pass", async () => {
    const one = fakeAi(["TLDR: direto.\n- ponto [00:10]"]);
    const r1 = await aiSummarize(one.ai, "m", ["unico chunk"], false);
    expect(one.calls()).toBe(1);
    expect(r1?.summary.tldr).toBe("direto.");
    expect(r1?.topics).toEqual([]); // topics are deep-only

    const multi = fakeAi([
      "- parte A [00:05]",
      "- parte B [01:00]",
      "TLDR: video sobre A e B.\n- A detalhado [00:05]\n- B detalhado [01:00]",
    ]);
    const r2 = await aiSummarize(multi.ai, "m", ["chunk1", "chunk2"], true);
    expect(multi.calls()).toBe(3); // 2 maps + 1 reduce; no indexText => no topics pass
    expect(r2?.summary.tldr).toBe("video sobre A e B.");
    expect(r2?.summary.bullets).toHaveLength(2);
  });

  it("returns null when the AI produces nothing usable", async () => {
    const empty = fakeAi([]);
    await expect(aiSummarize(empty.ai, "m", ["chunk"], false)).resolves.toBeNull();
  });
});

describe("extractiveFallback (no-AI path)", () => {
  it("pulls timestamped block openers, capped at maxBullets", () => {
    const index = [
      "[00:00] Primeira fala do bloco inicial aqui.",
      "[00:45] Segundo bloco com mais conteudo relevante.",
      "[01:30] Terceiro bloco fechando a discussao.",
    ].join("\n");
    const out = extractiveFallback(index, 2);
    expect(out.bullets).toHaveLength(2);
    expect(out.bullets[0]).toMatch(/^\[00:00\]/);
    expect(out.tldr).toBe("");
  });
});

describe("renderSummary", () => {
  it("composes meta header, tldr and bullets", () => {
    const text = renderSummary(
      { title: "T", author: "@canal", durationSeconds: 7315 },
      { tldr: "Resumo.", bullets: ["um [00:10]", "dois"] },
      false,
    );
    expect(text).toContain("📹 T");
    expect(text).toContain("@canal");
    expect(text).toContain("2:01:55");
    expect(text).toContain("💡 Resumo.");
    expect(text).toContain("• um [00:10]");
    expect(text).not.toContain("(modo profundo)");
  });

  it("marks deep mode and tolerates missing meta", () => {
    const text = renderSummary({}, { tldr: "x", bullets: [] }, true);
    expect(text).toContain("modo profundo");
    expect(text).toContain("YouTube video");
  });
});
