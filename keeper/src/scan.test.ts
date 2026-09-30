/**
 * Regression tests for the mainnet scan (scan.ts):
 *   pnpm exec tsx --test src/scan.test.ts
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { ContractFunctionExecutionError, ContractFunctionRevertedError, HttpRequestError } from "viem";
import { aggregatorAbi } from "./abi.js";
import { collect, scanDown, type RoundRead, type RoundReader, type ScanOptions } from "./scan.js";
import { INDEX_MASK } from "./util.js";

const FEED = "0x4A1166a659A55625345e9515b32adECea5547C38" as const;
const P1 = 1n << 64n; // phase 1 base (aggregator index 0, never a real round)
const P2 = 2n << 64n;
/// TSLA mainnet round #1: $396.41 reported at 16 decimals. Invalid, yet FeedMirror stores it.
const GENESIS = 3964149999900000000n;
const opts: ScanOptions = { scanLimit: 2_000n, chunk: 100n, backfill: 150 };

type Entry = { answer: bigint; updatedAt: bigint } | "revert" | "empty";

const at = (i: number) => 1_700_000_000n + BigInt(i) * 3600n;

/// `n` valid rounds #1..#n in `phase`, an hour apart, then `edits` by index.
function script(edits: Record<number, Entry> = {}, n = 10, phase = P1): Map<bigint, Entry> {
  const m = new Map<bigint, Entry>();
  for (let i = 1; i <= n; i++) m.set(phase + BigInt(i), { answer: 350_00000000n + BigInt(i), updatedAt: at(i) });
  for (const [i, e] of Object.entries(edits)) m.set(phase + BigInt(i), e);
  return m;
}

/// A revert of one getRoundData call, as viem decodes a failed Multicall3 sub-call.
const revert = (id: bigint) =>
  new ContractFunctionExecutionError(new ContractFunctionRevertedError({ abi: aggregatorAbi, functionName: "getRoundData" }), {
    abi: aggregatorAbi,
    functionName: "getRoundData",
    args: [id],
    contractAddress: FEED,
  });
/// A failed Multicall3 request (network error), which viem reports for every call in the request.
const outage = () =>
  new ContractFunctionExecutionError(new HttpRequestError({ url: "https://rpc.example", details: "socket hang up" }), {
    abi: aggregatorAbi,
    functionName: "aggregate3",
    contractAddress: FEED,
  });

/// Scripted mainnet proxy: unknown ids answer like the real one (all zeros, round id 0). Requests
/// touching `failIds` fail as a whole.
function feedOf(rounds: Map<bigint, Entry>, failIds: bigint[] = []) {
  const asked: bigint[] = [];
  const read: RoundReader = async (_feed, ids) => {
    asked.push(...ids);
    if (ids.some((id) => failIds.includes(id))) return ids.map((): RoundRead => ({ status: "failure", error: outage() }));
    return ids.map((id): RoundRead => {
      const e = rounds.get(id);
      if (e === "revert") return { status: "failure", error: revert(id) };
      if (e === undefined || e === "empty") return { status: "success", result: [0n, 0n, 0n, 0n, 0n] };
      return { status: "success", result: [id, e.answer, e.updatedAt, e.updatedAt, id] };
    });
  };
  return { read, asked };
}

const indexes = (rounds: { roundId: bigint }[]) => rounds.map((r) => r.roundId & INDEX_MASK);
function silence(t: TestContext) {
  t.mock.method(console, "warn", () => {});
  t.mock.method(console, "log", () => {});
}

test("invalid answers are mirrored verbatim so ids stay contiguous", async (t) => {
  silence(t);
  const { read } = feedOf(script({ 3: { answer: GENESIS, updatedAt: at(3) } }));
  const rounds = await collect(read, "TSLA", FEED, P1 + 10n, 0n, opts);
  assert.deepEqual(indexes(rounds), [1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n]);
  assert.equal(rounds[2].answer, GENESIS);
});

test("an answer of 0 is a hole, not the end of the scan", async (t) => {
  silence(t);
  const { read } = feedOf(script({ 4: { answer: 0n, updatedAt: at(4) } }));
  assert.deepEqual(indexes(await collect(read, "TSLA", FEED, P1 + 10n, P1 + 2n, opts)), [3n, 5n, 6n, 7n, 8n, 9n, 10n]);
});

test("a reverting id and an empty round are holes", async (t) => {
  silence(t);
  const { read } = feedOf(script({ 4: "revert", 7: "empty" }));
  assert.deepEqual(indexes(await collect(read, "TSLA", FEED, P1 + 10n, P1 + 2n, opts)), [3n, 5n, 6n, 8n, 9n, 10n]);
});

test("scanDown reports holes ascending and counts invalid answers", async () => {
  const { read } = feedOf(script({ 2: { answer: GENESIS, updatedAt: at(2) }, 4: "empty", 6: "revert" }));
  const scan = await scanDown(read, FEED, P1 + 10n, P1, Infinity, opts);
  assert.deepEqual(indexes(scan.rounds), [1n, 2n, 3n, 5n, 7n, 8n, 9n, 10n]);
  assert.deepEqual(scan.holes, [P1 + 4n, P1 + 6n]);
  assert.equal(scan.invalid, 1);
  assert.equal(scan.stop, "floor");
});

test("a failed RPC request aborts the pass instead of leaving a gap", async (t) => {
  silence(t);
  const { read } = feedOf(script(), [P1 + 4n]);
  await assert.rejects(collect(read, "TSLA", FEED, P1 + 10n, P1 + 2n, opts), ContractFunctionExecutionError);
});

test("far behind: the oldest missing window is replayed first, then the next", async (t) => {
  silence(t);
  const { read, asked } = feedOf(script());
  const small = { ...opts, scanLimit: 4n };
  assert.deepEqual(indexes(await collect(read, "TSLA", FEED, P1 + 10n, P1 + 2n, small)), [3n, 4n, 5n, 6n]);
  assert.deepEqual(indexes(await collect(read, "TSLA", FEED, P1 + 10n, P1 + 6n, small)), [7n, 8n, 9n, 10n]);
  assert.equal(asked.length, 8);
});

test("a phase change replays the new phase from its first round", async (t) => {
  silence(t);
  const { read, asked } = feedOf(script({}, 3, P2));
  const rounds = await collect(read, "TSLA", FEED, P2 + 3n, P1 + 50n, opts);
  assert.deepEqual(
    rounds.map((r) => r.roundId),
    [P2 + 1n, P2 + 2n, P2 + 3n],
  );
  assert.ok(asked.every((id) => id > P2 && id <= P2 + 3n));
});

test("backfill seeds the newest valid rounds and never reads index 0 or past the head", async (t) => {
  silence(t);
  const { read, asked } = feedOf(script({ 9: { answer: GENESIS, updatedAt: at(9) } }));
  const rounds = await collect(read, "TSLA", FEED, P1 + 10n, 0n, { ...opts, backfill: 3 });
  assert.deepEqual(indexes(rounds), [7n, 8n, 9n, 10n]); // three valid rounds plus the invalid one among them
  assert.ok(asked.every((id) => id > P1 && id <= P1 + 10n));
});

test("nothing is read when the mirror holds the mainnet head", async () => {
  const { read, asked } = feedOf(script());
  assert.deepEqual(await collect(read, "TSLA", FEED, P1 + 10n, P1 + 10n, opts), []);
  assert.equal(asked.length, 0);
});
