import { describe, expect, it } from "vitest";
import { RateLimiter } from "./index";

type Store = Map<string, unknown>;

/** Minimal KVNamespace stub matching the surface we use. */
function fakeKv(store: Store = new Map()) {
  return {
    async get<T>(key: string, type: "json"): Promise<T | null> {
      return (store.get(key) as T) ?? null;
    },
    async put(key: string, value: string): Promise<void> {
      store.set(key, JSON.parse(value));
    },
  } as unknown as KVNamespace;
}

const DAY = 86400;

describe("RateLimiter", () => {
  it("allows up to the configured free limit then blocks", async () => {
    const rl = new RateLimiter(fakeKv(), { freeLimit: 3, windowSeconds: DAY });
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await rl.consume("clipgrab", "user:42", false));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results[3]).toMatchObject({ used: 4, limit: 3 });
  });

  it("exempts pro users without touching counters", async () => {
    const rl = new RateLimiter(fakeKv(), { freeLimit: 1, windowSeconds: DAY });
    for (let i = 0; i < 5; i++) {
      const r = await rl.consume("clipgrab", "user:7", true);
      expect(r.allowed).toBe(true);
      expect(r.limit).toBe(Infinity);
    }
  });

  it("isolates subjects and bots", async () => {
    const rl = new RateLimiter(fakeKv(), { freeLimit: 1, windowSeconds: DAY });
    expect((await rl.consume("clipgrab", "user:1", false)).allowed).toBe(true);
    expect((await rl.consume("clipgrab", "user:2", false)).allowed).toBe(true);
    expect((await rl.consume("instatoolkit", "user:1", false)).allowed).toBe(true);
    expect((await rl.consume("clipgrab", "user:1", false)).allowed).toBe(false);
  });
});
