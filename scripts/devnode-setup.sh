#!/usr/bin/env bash
# Prepare a freshly started Arbitrum Nitro dev node for Stylus (mirrors OffchainLabs/nitro-devnode):
#   docker run -d --name nitro-dev -p 8547:8547 offchainlabs/nitro-node:v3.7.1-926f1ab \
#     --dev --http.addr 0.0.0.0 --http.api=net,web3,eth,debug --http.corsdomain='*' --http.vhosts='*'
#   RPC_URL=http://127.0.0.1:8547 scripts/devnode-setup.sh
set -euo pipefail
RPC="${RPC_URL:-http://127.0.0.1:8547}"
PK=0xb6b15c8cb491557369f3c7d2c287b053eb229daa9c22138887752191c9520659 # nitro dev node's prefunded key
echo "chain $(cast chain-id -r "$RPC"), dev balance $(cast balance -r "$RPC" --ether 0x3f1Eae7D46d88F08fc2F8ed27FCb2AB183EB2d0E) ETH"
cast send -r "$RPC" --private-key $PK 0x00000000000000000000000000000000000000FF "becomeChainOwner()" >/dev/null
cast send -r "$RPC" --private-key $PK 0x0000000000000000000000000000000000000070 'setL1PricePerUnit(uint256)' 0x0 >/dev/null
out=$(cast send -r "$RPC" --private-key $PK --create 0x60a06040523060805234801561001457600080fd5b50608051611d1c61003060003960006105260152611d1c6000f3fe)
cm=$(echo "$out" | awk '/contractAddress/ {print $2}')
cast send -r "$RPC" --private-key $PK 0x0000000000000000000000000000000000000070 "addWasmCacheManager(address)" "$cm" >/dev/null
echo "chain owner set, L1 price 0, cache manager $cm registered"
