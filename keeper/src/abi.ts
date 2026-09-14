export const aggregatorAbi = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  {
    type: "function",
    name: "getRoundData",
    stateMutability: "view",
    inputs: [{ name: "roundId", type: "uint80" }],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "description", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

export const feedMirrorAbi = [
  ...aggregatorAbi,
  { type: "function", name: "latestRound", stateMutability: "view", inputs: [], outputs: [{ type: "uint80" }] },
  { type: "function", name: "oraclePaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  {
    type: "function",
    name: "pushRound",
    stateMutability: "nonpayable",
    inputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "updatedAt", type: "uint64" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "pushRounds",
    stateMutability: "nonpayable",
    inputs: [
      { name: "roundIds", type: "uint80[]" },
      { name: "answers", type: "int256[]" },
      { name: "updatedAts", type: "uint64[]" },
    ],
    outputs: [],
  },
] as const;

export const marketAbi = [
  {
    type: "event",
    name: "ProtectionBought",
    inputs: [
      { name: "seriesId", type: "uint256", indexed: true },
      { name: "buyer", type: "address", indexed: true },
      { name: "underlyingId", type: "uint32", indexed: true },
      { name: "strike", type: "uint256", indexed: false },
      { name: "expiry", type: "uint64", indexed: false },
      { name: "units", type: "uint256", indexed: false },
      { name: "premium", type: "uint256", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
      { name: "spot", type: "uint256", indexed: false },
      { name: "vol", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "SeriesSettled",
    inputs: [
      { name: "seriesId", type: "uint256", indexed: true },
      { name: "settlePrice", type: "uint256", indexed: false },
      { name: "fallbackUsed", type: "bool", indexed: false },
    ],
  },
  {
    type: "function",
    name: "getSeries",
    stateMutability: "view",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "underlyingId", type: "uint32" },
          { name: "expiry", type: "uint64" },
          { name: "strike", type: "uint256" },
          { name: "openUnits", type: "uint256" },
          { name: "settlePrice", type: "uint256" },
          { name: "settled", type: "bool" },
        ],
      },
    ],
  },
  { type: "function", name: "settle", stateMutability: "nonpayable", inputs: [{ name: "id", type: "uint256" }], outputs: [] },
  {
    type: "function",
    name: "quote",
    stateMutability: "view",
    inputs: [
      { name: "underlyingId", type: "uint32" },
      { name: "strike", type: "uint256" },
      { name: "expiry", type: "uint64" },
      { name: "units", type: "uint256" },
    ],
    outputs: [
      { name: "premium", type: "uint256" },
      { name: "collateral", type: "uint256" },
      { name: "spot", type: "uint256" },
      { name: "vol", type: "uint256" },
      { name: "closedSeconds", type: "uint256" },
    ],
  },
] as const;
