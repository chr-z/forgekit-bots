import { describe, expect, it } from "vitest";
import { candidatesFor, generateHashtags, renderTagList } from "./hashtags";

describe("candidatesFor", () => {
  it("normalizes accents and symbols", () => {
    const tags = candidatesFor("Café & Pão!").map((c) => c.tag);
    expect(tags.every((t) => /^[a-z0-9]+$/.test(t))).toBe(true);
    expect(tags.some((t) => t.startsWith("cafe"))).toBe(true);
    expect(tags.some((t) => t.startsWith("pao"))).toBe(true);
  });

  it("produces all three tiers", () => {
    const tiers = new Set(candidatesFor("fotografia").map((c) => c.tier));
    expect(tiers).toEqual(new Set([1, 2, 3]));
  });

  it("is empty for garbage input", () => {
    expect(candidatesFor("!!!")).toEqual([]);
    expect(candidatesFor("")).toEqual([]);
  });
});

describe("generateHashtags", () => {
  it("respects the requested total and stays deterministic", () => {
    const a = generateHashtags(["cafe"], 18);
    const b = generateHashtags(["cafe"], 18);
    expect(a).toHaveLength(18);
    expect(a).toEqual(b); // deterministic
    expect(new Set(a.map((x) => x.tag)).size).toBe(18); // no dupes
  });

  it("mixes tiers roughly 40/40/20", () => {
    const set = generateHashtags(["cafe"], 20);
    const byTier = [1, 2, 3].map((tier) => set.filter((t) => t.tier === tier).length);
    expect(byTier[0]).toBe(8);
    expect(byTier[1]).toBe(8);
    expect(byTier[2]).toBe(4);
  });

  it("dedupes across seeds", () => {
    const set = generateHashtags(["cafe", "café"], 12);
    expect(new Set(set.map((x) => x.tag)).size).toBe(set.length);
  });
});

describe("renderTagList", () => {
  it("prefixes hashes", () => {
    const out = renderTagList([{ tag: "a", tier: 1 }, { tag: "b", tier: 2 }]);
    expect(out).toBe("#a #b");
  });
});
