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
    name: "setPaused",
    stateMutability: "nonpayable",
    inputs: [{ name: "paused", type: "bool" }],
    outputs: [],
  },
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
  { type: "error", name: "NotRelayer", inputs: [] },
  { type: "error", name: "BadRound", inputs: [] },
  { type: "error", name: "NoData", inputs: [] },
] as const;

/// Robinhood Stock Token (mainnet). The keeper only needs the corporate-action pause flag.
export const stockTokenAbi = [
  { type: "function", name: "oraclePaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
] as const;

/// The subset of AfterHoursMarket the keeper uses. Errors are listed so reverts decode by name.
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
          { name: "grace", type: "uint64" },
          { name: "settled", type: "bool" },
          { name: "strike", type: "uint256" },
          { name: "openUnits", type: "uint256" },
          { name: "locked", type: "uint256" },
          { name: "premium", type: "uint256" },
          { name: "settlePrice", type: "uint256" },
          { name: "owed", type: "uint256" },
        ],
      },
    ],
  },
  { type: "function", name: "settle", stateMutability: "nonpayable", inputs: [{ name: "id", type: "uint256" }], outputs: [] },
  {
    type: "function",
    name: "settleAt",
    stateMutability: "nonpayable",
    inputs: [
      { name: "id", type: "uint256" },
      { name: "roundId", type: "uint80" },
    ],
    outputs: [],
  },
  { type: "error", name: "SettleWalkTooLong", inputs: [] },
  {
    type: "error",
    name: "AwaitingPostExpiryPrint",
    inputs: [
      { name: "expiry", type: "uint64" },
      { name: "lastUpdate", type: "uint256" },
    ],
  },
  { type: "error", name: "FeedPaused", inputs: [] },
  { type: "error", name: "NotExpired", inputs: [] },
  { type: "error", name: "AlreadySettled", inputs: [] },
  { type: "error", name: "NotSettled", inputs: [] },
  { type: "error", name: "InvalidAnswer", inputs: [] },
] as const;
