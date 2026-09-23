// Stamps deployments/<chainId>.json with the real L2 deploy block.
//
// On Arbitrum chains the EVM's `block.number` is an estimate of the parent-chain block, so the
// deploy script cannot record the L2 height itself. Broadcast receipts carry the L2 block number;
// the earliest one is where event scans (web app, settlement bot) should start.
//
//   node script/finalize-deployment.mjs <chainId>
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const chainId = process.argv[2];
if (!chainId) {
  console.error("usage: node script/finalize-deployment.mjs <chainId>");
  process.exit(1);
}

const run = JSON.parse(readFileSync(join(root, "broadcast", "Deploy.s.sol", chainId, "run-latest.json"), "utf8"));
const blocks = (run.receipts ?? []).map((r) => Number(BigInt(r.blockNumber))).filter((n) => n > 0);
if (blocks.length === 0) {
  console.error("no receipts in broadcast/run-latest.json; was the script broadcast?");
  process.exit(1);
}
const deployBlock = Math.min(...blocks);

const path = join(root, "deployments", `${chainId}.json`);
const dep = JSON.parse(readFileSync(path, "utf8"));
dep.deployBlock = deployBlock;
writeFileSync(path, JSON.stringify(dep, null, 2) + "\n");
console.log(`${path}: deployBlock = ${deployBlock}`);
