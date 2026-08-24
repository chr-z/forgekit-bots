import { describe, expect, it } from "vitest";
import { assertKeysAligned, parseLocale, t } from "./index";

const dict = {
  en: {
    greet: "Hello {name}!",
    quota: "You have {left} downloads left today.",
    only_en: "English only",
  },
  "pt-BR": {
    greet: "Olá {name}!",
    quota: "Você tem {left} downloads hoje.",
  },
};

describe("parseLocale", () => {
  it("maps pt variants to pt-BR", () => {
    expect(parseLocale("pt-BR")).toBe("pt-BR");
    expect(parseLocale("pt")).toBe("pt-BR");
    expect(parseLocale("PT-pt")).toBe("pt-BR");
  });

  it("maps everything else to en", () => {
    expect(parseLocale("en-US")).toBe("en");
    expect(parseLocale("es")).toBe("en");
    expect(parseLocale(null)).toBe("en");
    expect(parseLocale(undefined)).toBe("en");
  });
});

describe("t", () => {
  it("interpolates params in the requested locale", () => {
    expect(t(dict, "pt-BR", "greet", { name: "Zee" })).toBe("Olá Zee!");
    expect(t(dict, "en", "quota", { left: 3 })).toBe("You have 3 downloads left today.");
  });

  it("falls back to English then to the raw key", () => {
    expect(t(dict, "pt-BR", "only_en")).toBe("English only");
    expect(t(dict, "en", "missing.key")).toBe("missing.key");
  });

  it("leaves unknown placeholders untouched", () => {
    expect(t({ en: { x: "{a} {b}" } }, "en", "x", { a: 1 })).toBe("1 {b}");
  });
});

describe("assertKeysAligned", () => {
  it("detects keys missing from one locale", () => {
    const res = assertKeysAligned(dict, ["greet", "quota", "only_en"]);
    expect(res.ok).toBe(false);
    expect(res.missing).toEqual(["pt-BR:only_en"]);
  });

  it("passes when all locales have all keys", () => {
    expect(assertKeysAligned(dict, ["greet"]).ok).toBe(true);
  });
});
