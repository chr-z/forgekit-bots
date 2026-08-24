import { describe, expect, it } from "vitest";
import {
  addTerm,
  countTerms,
  deleteChannel,
  getChannelByChat,
  listChannelsByOwner,
  listTerms,
  loadWatchlist,
  removeTerm,
  upsertChannel,
} from "./store";
import { makeVcD1 } from "./testhelpers";

type DB = Parameters<typeof upsertChannel>[0];

describe("store", () => {
  it("upserts channels and re-titles on conflict", async () => {
    const s = makeVcD1();
    const db = s.db as DB;
    await upsertChannel(db, -100111, 42, "Meu Canal");
    await upsertChannel(db, -100111, 42, "Novo Nome");
    const row = await getChannelByChat(db, -100111);
    expect(row?.title).toBe("Novo Nome");
    // a second owner cannot hijack the row: conflict is on chat_id only
    await upsertChannel(db, -100222, 43, "Outro");
    expect((await listChannelsByOwner(db, 43)).map((c) => c.chat_id)).toEqual([-100222]);
  });

  it("lists only the owner's channels, newest first", async () => {
    const s = makeVcD1();
    const db = s.db as DB;
    await upsertChannel(db, -1001, 7, "A");
    await upsertChannel(db, -1002, 7, "B");
    await upsertChannel(db, -1003, 8, "C");
    const mine = await listChannelsByOwner(db, 7);
    expect(mine.map((c) => c.title)).toEqual(["B", "A"]);
  });

  it("deletes channel with ownership check and cascades terms", async () => {
    const s = makeVcD1();
    const db = s.db as DB;
    await upsertChannel(db, -1009, 5, "X");
    await addTerm(db, -1009, "pix");
    // wrong owner -> no-op
    expect(await deleteChannel(db, 99, -1009)).toBe(false);
    expect(await getChannelByChat(db, -1009)).not.toBeNull();
    // right owner -> gone + terms gone
    expect(await deleteChannel(db, 5, -1009)).toBe(true);
    expect(await getChannelByChat(db, -1009)).toBeNull();
    expect(await loadWatchlist(db).then((m) => m.get(-1009))).toBeUndefined();
  });

  it("addTerm dedupes; removeTerm reports existence; countTerms aggregates", async () => {
    const s = makeVcD1();
    const db = s.db as DB;
    await addTerm(db, -1, "pix");
    await addTerm(db, -1, "pix"); // INSERT OR IGNORE
    await addTerm(db, -2, "ceo");
    expect(await listTerms(db, -1)).toEqual(["pix"]);
    expect(await countTerms(db, [-1, -2])).toBe(2);
    expect(await removeTerm(db, -1, "nope")).toBe(false);
    expect(await removeTerm(db, -1, "pix")).toBe(true);
    expect(await countTerms(db, [-1])).toBe(0);
  });

  it("loadWatchlist groups all terms by chat for the scan path", async () => {
    const s = makeVcD1();
    const db = s.db as DB;
    await addTerm(db, -10, "a");
    await addTerm(db, -10, "b");
    await addTerm(db, -20, "c");
    const watch = await loadWatchlist(db);
    expect(watch.get(-10)).toEqual(["a", "b"]);
    expect(watch.get(-20)).toEqual(["c"]);
  });
});
