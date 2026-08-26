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

  it("peek reads current usage without consuming or writing", async () => {
    const store: Store = new Map();
    const kv = fakeKv(store);
    const rl = new RateLimiter(kv, { freeLimit: 3, windowSeconds: DAY });
    expect(await rl.peek("clipgrab", "user:9")).toEqual({ used: 0, limit: 3 });
    await rl.consume("clipgrab", "user:9", false);
    await rl.consume("clipgrab", "user:9", false);
    expect(await rl.peek("clipgrab", "user:9")).toEqual({ used: 2, limit: 3 });
    // peek must not have advanced the counter
    const ops = store.size;
    await rl.peek("clipgrab", "user:9");
    expect(store.size).toBe(ops);
    // and the next consume still lands on used=3 (allowed), not 4
    expect(await rl.consume("clipgrab", "user:9", false)).toMatchObject({ allowed: true, used: 3 });
  });
});

describe("RateLimiter pro ceiling", () => {
  it("counts exempt usage against proLimit and allows up to it", async () => {
    const rl = new RateLimiter(fakeKv(), { freeLimit: 1, proLimit: 3, windowSeconds: DAY });
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await rl.consume("documind", "q:7", true));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results[3]).toMatchObject({ used: 4, limit: 3 });
  });

  it("keeps exempt users truly unlimited when no proLimit is set", async () => {
    const rl = new RateLimiter(fakeKv(), { freeLimit: 1, windowSeconds: DAY });
    for (let i = 0; i < 5; i++) {
      const r = await rl.consume("clipgrab", "user:7", true);
      expect(r.allowed).toBe(true);
      expect(r.limit).toBe(Infinity);
    }
  });

  it("isolates pro counters from free counters for the same subject", async () => {
    const store: Store = new Map();
    const kv = fakeKv(store);
    const rl = new RateLimiter(kv, { freeLimit: 2, proLimit: 2, windowSeconds: DAY });
    expect((await rl.consume("documind", "q:9", false)).allowed).toBe(true);
    expect((await rl.consume("documind", "q:9", true)).allowed).toBe(true);
    expect((await rl.consume("documind", "q:9", true)).allowed).toBe(true);
    // Pro hit its own ceiling of 2 even though the free counter shows 1/2.
    expect((await rl.consume("documind", "q:9", true)).allowed).toBe(false);
    // Free path unaffected by the pro counter.
    expect((await rl.consume("documind", "q:9", false)).allowed).toBe(true);
    expect((await rl.consume("documind", "q:9", false)).allowed).toBe(false);
    // Two distinct keys exist in the store.
    expect(store.size).toBe(2);
  });

  it("peek still reports the free limit and ignores exempt windows", async () => {
    const rl = new RateLimiter(fakeKv(), { freeLimit: 5, proLimit: 500, windowSeconds: DAY });
    await rl.consume("documind", "q:3", true);
    await rl.consume("documind", "q:3", true);
    expect(await rl.peek("documind", "q:3")).toEqual({ used: 0, limit: 5 });
  });
});
