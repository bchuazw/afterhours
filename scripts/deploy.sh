#!/usr/bin/env bash
# One-shot deployment: Stylus pricer -> Solidity market/vaults/feed mirrors -> deployment file.
#
#   PRIVATE_KEY=0x... scripts/deploy.sh 46630     # Robinhood Chain testnet
#   PRIVATE_KEY=0x... scripts/deploy.sh 421614    # Arbitrum Sepolia
#   PRIVATE_KEY=0x... scripts/deploy.sh 412346    # local Nitro dev node (RPC_URL overrides)
#
# Needs: Rust + cargo-stylus, Foundry, Node. Run on Linux/WSL (cargo-stylus does not build on Windows).
# Reuses an existing pricer when PRICER=0x... is set.
set -euo pipefail

CHAIN="${1:?usage: scripts/deploy.sh <chainId>}"
: "${PRIVATE_KEY:?set PRIVATE_KEY}"
case "$CHAIN" in
  46630)  DEFAULT_RPC=https://rpc.testnet.chain.robinhood.com ;;
  421614) DEFAULT_RPC=https://sepolia-rollup.arbitrum.io/rpc ;;
  412346) DEFAULT_RPC=http://127.0.0.1:8547 ;;
  *) echo "unknown chain $CHAIN"; exit 1 ;;
esac
RPC="${RPC_URL:-$DEFAULT_RPC}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

got=$(cast chain-id --rpc-url "$RPC")
[ "$got" = "$CHAIN" ] || { echo "RPC $RPC reports chain $got, expected $CHAIN"; exit 1; }
echo "deployer $(cast wallet address --private-key "$PRIVATE_KEY") balance $(cast balance --ether --rpc-url "$RPC" "$(cast wallet address --private-key "$PRIVATE_KEY")") ETH on $CHAIN"

if [ -z "${PRICER:-}" ]; then
  echo "== Stylus pricer =="
  # Build outside a Windows-mounted tree if we are on one (much faster), otherwise in place.
  SRC="$ROOT/contracts/stylus/pricer"
  WORK="$SRC"
  case "$SRC" in /mnt/*) WORK="$HOME/build/afterhours-pricer"; mkdir -p "$WORK"; rsync -a --delete --exclude target "$SRC/" "$WORK/";; esac
  out=$(cd "$WORK" && cargo stylus deploy --endpoint "$RPC" --private-key "$PRIVATE_KEY" --no-verify 2>&1 | sed 's/\x1b\[[0-9;]*m//g')
  echo "$out" | grep -E "size|fee|deployed code|activated|error|Error" || true
  PRICER=$(echo "$out" | grep -oE "deployed code at address: 0x[0-9a-fA-F]{40}" | grep -oE "0x[0-9a-fA-F]{40}" | head -1)
  [ -n "$PRICER" ] || { echo "pricer deployment failed"; echo "$out" | tail -20; exit 1; }
fi
echo "pricer $PRICER"
v=$(cast call --rpc-url "$RPC" "$PRICER" "version()(uint32)")
[ "$v" = "1" ] || { echo "pricer at $PRICER did not answer version()"; exit 1; }

echo "== Solidity =="
cd "$ROOT/contracts"
# Arbitrum charges parent-chain calldata as extra L2 gas, which Foundry's local simulation does not
# see; without headroom the node rejects deploys with "intrinsic gas too low". Unused gas is
# refunded, so a generous multiplier only raises the balance needed upfront per transaction.
PRICER="$PRICER" forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast --slow \
  --gas-estimate-multiplier "${GAS_MULT:-300}" 2>&1 | grep -vE "^\s*$" | tail -20
[ -f "deployments/$CHAIN.json" ] || { echo "deployment did not complete"; exit 1; }
node script/finalize-deployment.mjs "$CHAIN"
echo "== done: contracts/deployments/$CHAIN.json =="
cat "deployments/$CHAIN.json"
