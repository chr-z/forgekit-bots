import { describe, expect, it } from "vitest";
import {
  DOCUMIND_MODEL,
  answerQuestion,
  buildIndex,
  chunkText,
  extractiveAnswer,
  qaMessages,
  retrieve,
  splitSentences,
} from "./rag";

const PASSAGES = [
  "O prazo de garantia é de 12 meses contados da compra.",
  "A multa por rescisão antecipada corresponde a 40% das parcelas restantes.",
  "O suporte técnico funciona apenas em dias úteis, das 9h às 18h.",
];

function makeChunks(): { n: number; text: string }[] {
  return buildIndex(PASSAGES);
}

function makeAi(reply: string | Error) {
  return {
    run: async () => {
      if (reply instanceof Error) throw reply;
      return { response: reply };
    },
  } as never as Ai;
}

describe("chunkText / splitSentences", () => {
  it("packs sentences up to the budget without splitting them mid-chunk", () => {
    const long = Array.from({ length: 6 }, (_, i) => `Sentença número ${i} com conteúdo suficiente aqui.`).join(" ");
    const chunks = chunkText(long, 80);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(80);

    const huge = `Palavra ${"muito ".repeat(200)}longa.`;
    const [only] = chunkText(huge, 100);
    expect(only!.length).toBeLessThanOrEqual(100);
    expect(only).toContain("…");
  });

  it("returns no chunks for empty input", () => {
    expect(chunkText("   \n ")).toEqual([]);
  });

  it("buildIndex numbers chunks sequentially across pages", () => {
    const index = buildIndex(["Um. Dois. Três.", "Quatro."], 10);
    expect(index.map((c) => c.n)).toEqual([1, 2, 3]);
  });
});

describe("retrieve", () => {
  it("ranks by keyword coverage and caps results at k", async () => {
    // Enough filler so the packed index keeps the three statements apart.
    const filler = "Texto neutro de preenchimento para inflar o trecho. ";
    const doc = [
      `${filler}${filler}${PASSAGES[0]}`,
      `${filler.repeat(3)}${filler}${PASSAGES[1]}`,
      `${filler.repeat(5)}${filler}${PASSAGES[2]}`,
    ];
    const index = buildIndex(doc, 120);
    const hits = retrieve(index, "Qual é o percentual da multa rescisória?", 2);
    expect(hits.length).toBeLessThanOrEqual(2);
    expect(hits[0]!.text).toContain(PASSAGES[1]);

    const none = retrieve(makeChunks(), "futebol carnaval praia", 4);
    expect(none).toHaveLength(0); // zero matches -> caller must not charge
  });

  it("scores repeated query terms higher than single mentions", () => {
    const index = buildIndex([
      "Garantia mencionada de passagem neste parágrafo genérico sobre prazos e contratos variados.",
      "Garantia cobre peças; garantia estendida dobra o período de garantia original.",
    ]);
    const hits = retrieve(index, "garantia", 2);
    expect(hits[0]!.text).toContain("estendida");
  });
});

describe("qaMessages", () => {
  it("embeds numbered passages and instructs citation + same-language replies", () => {
    const scored = retrieve(makeChunks(), "garantia");
    const msgs = qaMessages("Qual o prazo de garantia?", scored);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).toContain("[1]");
    expect(msgs[1]!.content).toContain("Question: Qual o prazo de garantia?");
    expect(DOCUMIND_MODEL).toMatch(/llama/);
  });
});

describe("answerQuestion", () => {
  const q = "Qual o prazo de garantia?";
  const scored = retrieve(makeChunks(), "prazo de garantia");

  it("happy path: AI reply with citations passes through", async () => {
    const ai = makeAi("A garantia dura 12 meses da compra [1].");
    const out = await answerQuestion(ai, DOCUMIND_MODEL, q, scored);
    expect(out.answer).toContain("[1]");
    expect(out.cited).toBe(true);
  });

  it("uncited model output degrades to the extractive passage answer", async () => {
    const ai = makeAi("A garantia dura 12 meses, confia.");
    const out = await answerQuestion(ai, DOCUMIND_MODEL, q, scored);
    expect(out.answer).toMatch(/^\[\d+\]/); // deterministic fallback
    expect(extractiveAnswer(scored)).toContain("[1]");
  });

  it("NOT_IN_DOCUMENT and AI failures fall back to passages, never invention", async () => {
    const honest = await answerQuestion(makeAi("NOT_IN_DOCUMENT."), DOCUMIND_MODEL, q, scored);
    expect(honest.answer).toMatch(/^\[\d+\]/);

    const broken = await answerQuestion(makeAi(new Error("neurons down")), DOCUMIND_MODEL, q, scored);
    expect(broken.answer).toContain("12 meses");

    const noAi = await answerQuestion(undefined, DOCUMIND_MODEL, q, scored);
    expect(noAi.answer).toContain("[1]");
  });

  it("no retrieval hits short-circuits before any AI call", async () => {
    let called = false;
    const ai = {
      run: async () => {
        called = true;
        return { response: "x [1]" };
      },
    } as never as Ai;
    const out = await answerQuestion(ai, DOCUMIND_MODEL, q, []);
    expect(out.answer).toBe("");
    expect(called).toBe(false);
  });
});

describe("splitSentences sanity", () => {
  it("splits on terminal punctuation followed by capitals", () => {
    const parts = splitSentences("Primeira frase. Segunda frase! Terceira? Fim.");
    expect(parts).toHaveLength(4);
  });
});
