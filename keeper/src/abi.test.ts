/**
 * Regression tests for the keeper ABIs (abi.ts):
 *   pnpm exec tsx --test src/abi.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ContractFunctionRevertedError, encodeErrorResult, toFunctionSelector } from "viem";
import { marketAbi } from "./abi.js";
import { errMsg, revertName } from "./util.js";

const here = dirname(fileURLToPath(import.meta.url));
const revert = (data: `0x${string}`) => new ContractFunctionRevertedError({ abi: marketAbi, functionName: "settleAt", data });

test("settleAt, series and vault reverts decode by name", () => {
  for (const name of ["BadRoundHint", "UnknownSeries", "BadStrike", "BadSettle", "OnlyMarket", "UtilizationTooHigh", "SettleWalkTooLong"]) {
    assert.equal(revertName(revert(toFunctionSelector(`${name}()`))), name);
  }
  const data = encodeErrorResult({ abi: marketAbi, errorName: "InsufficientFreeLiquidity", args: [7n, 3n] });
  assert.equal(errMsg(revert(data)), "reverted InsufficientFreeLiquidity(7, 3)");
});

test("every keeper error matches the generated contract ABIs", (t) => {
  const generated = new Map<string, string>();
  for (const name of ["AfterHoursMarket", "ProtectionVault", "FeedMirror"]) {
    const p = join(here, "..", "..", "contracts", "out", `${name}.sol`, `${name}.json`);
    if (!existsSync(p)) return t.skip(`${p} not built`);
    const abi = JSON.parse(readFileSync(p, "utf8")).abi as { type: string; name: string; inputs: { type: string }[] }[];
    for (const e of abi) if (e.type === "error") generated.set(e.name, e.inputs.map((i) => i.type).join(","));
  }
  for (const e of marketAbi) {
    if (e.type !== "error") continue;
    assert.equal(generated.get(e.name), e.inputs.map((i) => i.type).join(","), `${e.name} differs from the generated ABI`);
  }
});
