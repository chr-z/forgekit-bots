import { describe, expect, it } from "vitest";
import { matchTerms, normalizeText, parseChannelArg } from "./matcher";

describe("normalizeText", () => {
  it("folds accents, case and whitespace", () => {
    expect(normalizeText("  Pagamentô   PENDENTE ")).toBe("pagamento pendente");
    expect(normalizeText("AÇÃO")).toBe("acao");
    expect(normalizeText("VOCÊ")).toBe("voce");
  });
});

describe("matchTerms", () => {
  it("matches case- and accent-insensitively", () => {
    const hits = matchTerms("PAGAMENTO confirmado, obrigado!", ["pagamento"]);
    expect(hits).toEqual(["pagamento"]);
  });

  it("whole-word: CEO must not trigger on oceano", () => {
    expect(matchTerms("o mar é um oceano azul", ["ceo"])).toEqual([]);
    expect(matchTerms("a CEO anunciou hoje", ["ceo"])).toEqual(["ceo"]);
  });

  it("multi-term posts return every hit in input order, capped", () => {
    const text = "Sorteio PIX hoje e curso grátis amanhã";
    expect(matchTerms(text, ["curso", "sorteio pix", "pix"])).toEqual(["curso", "sorteio pix", "pix"]);
    // cap at 2 keeps alerts short
    expect(
      matchTerms("Sorteio PIX hoje e curso grátis amanhã", ["pix", "curso", "hoje", "amanhã"], 2).length,
    ).toBe(2);
  });

  it("ignores empty/blank terms and empty text", () => {
    expect(matchTerms("", ["x"])).toEqual([]);
    expect(matchTerms("texto", ["", "   "])).toEqual([]);
  });

  it("regex metacharacters in terms are literal", () => {
    expect(matchTerms("preço: r$ 10 (hoje)", ["r$ 10 (hoje)"])).toEqual(["r$ 10 (hoje)"]);
    expect(matchTerms("r 10 hoje", ["r$ 10 (hoje)"])).toEqual([]);
  });
});

describe("parseChannelArg", () => {
  it("accepts t.me links, @handles, bare handles and ids", () => {
    expect(parseChannelArg("https://t.me/durov")).toBe("@durov");
    expect(parseChannelArg("https://telegram.me/durov/")).toBe("@durov");
    expect(parseChannelArg("@meucanal")).toBe("@meucanal");
    expect(parseChannelArg("meucanal_2")).toBe("@meucanal_2");
    expect(parseChannelArg("-1001234567890")).toBe("-1001234567890");
  });

  it("rejects garbage", () => {
    expect(parseChannelArg("https://t.me/durov/extra")).toBeNull();
    expect(parseChannelArg("não é canal!")).toBeNull();
    expect(parseChannelArg("@ab")).toBeNull(); // <4 chars
    expect(parseChannelArg("")).toBeNull();
  });
});
