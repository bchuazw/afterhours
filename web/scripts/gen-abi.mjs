// Copies the compiled Foundry ABIs into src/abi/*.ts as `as const` exports.
// Run: pnpm abi   (requires ../contracts/out to exist, i.e. `forge build` in ../contracts)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "..", "contracts", "out");
const dest = join(here, "..", "src", "abi");

const targets = [
  ["AfterHoursMarket", "market"],
  ["ProtectionVault", "vault"],
  ["FeedMirror", "feed"],
  ["MockERC20", "erc20"],
];

for (const [name, file] of targets) {
  const artifact = JSON.parse(readFileSync(join(out, `${name}.sol`, `${name}.json`), "utf8"));
  const abi = artifact.abi;
  const ts = `// Generated from contracts/out/${name}.sol/${name}.json — do not edit by hand.\n` +
    `export const ${file}Abi = ${JSON.stringify(abi, null, 2)} as const;\n`;
  writeFileSync(join(dest, `${file}.ts`), ts);
  console.log(`wrote src/abi/${file}.ts (${abi.length} entries)`);
}
