/**
 * Regression tests for the settlement hint search (hint.ts):
 *   pnpm exec tsx --test src/hint.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findSettleRound, type FeedReader, type RoundInfo } from "./hint.js";

const FEED = "0x75d2a760C86f4F2A7924D7E27B7aAf4244669e45" as const;
const P1 = 1n << 64n;

/// A mirror holding rounds #from..#to with updatedAt = 100 * index, all valid unless `edits` say so.
function mirror(edits: Record<number, "missing" | "invalid"> = {}, from = 1, to = 10): FeedReader {
  const rounds = new Map<bigint, RoundInfo>();
  for (let i = from; i <= to; i++) rounds.set(P1 + BigInt(i), { updatedAt: 100n * BigInt(i), valid: true });
  for (const [i, e] of Object.entries(edits)) {
    const id = P1 + BigInt(i);
    if (e === "missing") rounds.delete(id);
    else rounds.set(id, { updatedAt: 100n * BigInt(i), valid: false });
  }
  return {
    async latest() {
      const id = [...rounds.keys()].reduce((a, b) => (a > b ? a : b), 0n);
      const r = rounds.get(id);
      return r === undefined ? null : { roundId: id, ...r };
    },
    async round(_feed, id) {
      return rounds.get(id) ?? null;
    },
  };
}

test("the first print at/after expiry whose predecessor is older", async () => {
  assert.deepEqual(await findSettleRound(mirror(), FEED, 550n), { roundId: P1 + 6n });
});

test("a hole right under the first post-expiry print is reported, not hidden", async () => {
  assert.deepEqual(await findSettleRound(mirror({ 5: "missing" }), FEED, 550n), { roundId: P1 + 6n, missing: P1 + 5n });
});

test("a hole above an earlier post-expiry print does not matter", async () => {
  assert.deepEqual(await findSettleRound(mirror({ 7: "missing" }), FEED, 550n), { roundId: P1 + 6n });
});

test("an invalid first post-expiry print moves the hint up to the first valid one", async () => {
  assert.deepEqual(await findSettleRound(mirror({ 6: "invalid" }), FEED, 550n), { roundId: P1 + 7n });
  assert.deepEqual(await findSettleRound(mirror({ 6: "invalid", 7: "invalid" }), FEED, 550n), { roundId: P1 + 8n });
});

test("a hole between the first post-expiry print and the first valid one is a gap", async () => {
  assert.deepEqual(await findSettleRound(mirror({ 6: "invalid", 7: "missing" }), FEED, 550n), { roundId: P1 + 8n, missing: P1 + 7n });
});

test("the first round of a phase needs no predecessor", async () => {
  assert.deepEqual(await findSettleRound(mirror(), FEED, 50n), { roundId: P1 + 1n });
});

test("a mirror whose history starts after expiry still lacks the predecessor", async () => {
  assert.deepEqual(await findSettleRound(mirror({}, 200, 210), FEED, 20_550n), { roundId: P1 + 206n });
  assert.deepEqual(await findSettleRound(mirror({}, 200, 210), FEED, 19_950n), { roundId: P1 + 200n, missing: P1 + 199n });
});

test("null when the feed has not printed since expiry or is empty", async () => {
  assert.equal(await findSettleRound(mirror(), FEED, 1_001n), null);
  assert.equal(await findSettleRound(mirror({}, 1, 0), FEED, 1n), null);
});

test("throws when every print since expiry is invalid", async () => {
  const m = mirror({ 6: "invalid", 7: "invalid", 8: "invalid", 9: "invalid", 10: "invalid" });
  await assert.rejects(findSettleRound(m, FEED, 550n), /no valid answer/);
});

test("transport errors propagate instead of passing for a missing round", async () => {
  const m = mirror();
  m.round = async () => {
    throw new Error("ECONNRESET");
  };
  await assert.rejects(findSettleRound(m, FEED, 550n), /ECONNRESET/);
});
