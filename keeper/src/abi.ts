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

const feedMirrorErrors = [
  { type: "error", name: "NotRelayer", inputs: [] },
  { type: "error", name: "BadRound", inputs: [] },
  { type: "error", name: "NoData", inputs: [] },
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
  ...feedMirrorErrors,
] as const;

/// Robinhood Stock Token (mainnet). The keeper only needs the corporate-action pause flag.
export const stockTokenAbi = [
  { type: "function", name: "oraclePaused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
] as const;

/// Every custom error AfterHoursMarket declares, in contract order (abi.test.ts checks them against
/// the generated ABI).
const marketErrors = [
  { type: "error", name: "UnknownUnderlying", inputs: [] },
  { type: "error", name: "UnderlyingDisabled", inputs: [] },
  { type: "error", name: "UnknownSeries", inputs: [] },
  { type: "error", name: "MarketClosed", inputs: [] },
  { type: "error", name: "BadExpiry", inputs: [] },
  { type: "error", name: "BadStrike", inputs: [] },
  { type: "error", name: "ZeroUnits", inputs: [] },
  { type: "error", name: "StalePrice", inputs: [{ name: "updatedAt", type: "uint256" }] },
  { type: "error", name: "FeedPaused", inputs: [] },
  { type: "error", name: "InvalidAnswer", inputs: [] },
  {
    type: "error",
    name: "PricerSpotMismatch",
    inputs: [
      { name: "pricerSpot", type: "uint256" },
      { name: "feedSpot", type: "uint256" },
    ],
  },
  {
    type: "error",
    name: "PremiumTooHigh",
    inputs: [
      { name: "premium", type: "uint256" },
      { name: "maxPremium", type: "uint256" },
    ],
  },
  { type: "error", name: "TooManyActiveSeries", inputs: [] },
  { type: "error", name: "NotExpired", inputs: [] },
  { type: "error", name: "AlreadySettled", inputs: [] },
  { type: "error", name: "NotSettled", inputs: [] },
  {
    type: "error",
    name: "AwaitingPostExpiryPrint",
    inputs: [
      { name: "expiry", type: "uint64" },
      { name: "lastUpdate", type: "uint256" },
    ],
  },
  { type: "error", name: "SettleWalkTooLong", inputs: [] },
  { type: "error", name: "BadRoundHint", inputs: [] },
  { type: "error", name: "BadConfig", inputs: [] },
  { type: "error", name: "BadParams", inputs: [] },
  { type: "error", name: "BadFeed", inputs: [] },
  { type: "error", name: "BadVault", inputs: [] },
  { type: "error", name: "NotScheduled", inputs: [{ name: "id", type: "bytes32" }] },
  {
    type: "error",
    name: "Timelocked",
    inputs: [
      { name: "id", type: "bytes32" },
      { name: "eta", type: "uint64" },
    ],
  },
  {
    type: "error",
    name: "ScheduleExpired",
    inputs: [
      { name: "id", type: "bytes32" },
      { name: "eta", type: "uint64" },
    ],
  },
  {
    type: "error",
    name: "SeriesTooSmall",
    inputs: [
      { name: "premium", type: "uint256" },
      { name: "minimum", type: "uint256" },
    ],
  },
] as const;

/// ProtectionVault errors bubble up through the market's settle path (vault.settle), as do the
/// OpenZeppelin ones below (pause, reentrancy guard, the vault's asset transfer).
const vaultErrors = [
  { type: "error", name: "OnlyMarket", inputs: [] },
  {
    type: "error",
    name: "InsufficientFreeLiquidity",
    inputs: [
      { name: "requested", type: "uint256" },
      { name: "available", type: "uint256" },
    ],
  },
  { type: "error", name: "UtilizationTooHigh", inputs: [] },
  { type: "error", name: "BadSettle", inputs: [] },
] as const;

const openZeppelinErrors = [
  { type: "error", name: "EnforcedPause", inputs: [] },
  { type: "error", name: "ReentrancyGuardReentrantCall", inputs: [] },
  { type: "error", name: "SafeERC20FailedOperation", inputs: [{ name: "token", type: "address" }] },
  {
    type: "error",
    name: "ERC20InsufficientBalance",
    inputs: [
      { name: "sender", type: "address" },
      { name: "balance", type: "uint256" },
      { name: "needed", type: "uint256" },
    ],
  },
] as const;

/// The subset of AfterHoursMarket the keeper calls, plus every error a settlement can revert with
/// (the market's own, the vault's, OpenZeppelin's and an empty FeedMirror's NoData), so reverts
/// decode by name.
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
          { name: "timeValue", type: "uint256" },
          { name: "accrualRate", type: "uint256" },
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
  ...marketErrors,
  ...vaultErrors,
  ...openZeppelinErrors,
  ...feedMirrorErrors,
] as const;
