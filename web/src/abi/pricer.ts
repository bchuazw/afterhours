// Hand-written ABI for the Stylus (Rust) pricing engine. Matches the exported Solidity-style
// interface of the `afterhours-pricer` contract plus the IPricer.quotePut entrypoint the market calls.
export const pricerAbi = [
  {
    type: "function",
    name: "realizedVol",
    stateMutability: "view",
    inputs: [
      { name: "feed", type: "address" },
      { name: "lookback", type: "uint32" },
    ],
    outputs: [{ name: "vol", type: "uint256" }],
  },
  {
    type: "function",
    name: "closedSeconds",
    stateMutability: "view",
    inputs: [
      { name: "from", type: "uint256" },
      { name: "to", type: "uint256" },
    ],
    outputs: [{ name: "closed", type: "uint256" }],
  },
  {
    type: "function",
    name: "putPremium",
    stateMutability: "view",
    inputs: [
      { name: "spot", type: "uint256" },
      { name: "strike", type: "uint256" },
      { name: "vol", type: "uint256" },
      { name: "tSeconds", type: "uint256" },
      { name: "closedSecs", type: "uint256" },
      { name: "closedMult", type: "uint256" },
    ],
    outputs: [{ name: "premium", type: "uint256" }],
  },
  {
    type: "function",
    name: "quotePut",
    stateMutability: "view",
    inputs: [
      { name: "feed", type: "address" },
      { name: "strike", type: "uint256" },
      { name: "expiry", type: "uint256" },
      { name: "lookback", type: "uint32" },
      { name: "volFloor", type: "uint64" },
      { name: "volCap", type: "uint64" },
      { name: "closedVolMult", type: "uint64" },
      { name: "spreadBps", type: "uint16" },
    ],
    outputs: [
      { name: "premium", type: "uint256" },
      { name: "spot", type: "uint256" },
      { name: "vol", type: "uint256" },
      { name: "closedSeconds", type: "uint256" },
    ],
  },
] as const;
