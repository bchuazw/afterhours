// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice What a ProtectionVault needs from its market to price shares and gate entries / exits.
interface IMarketVaultState {
    /// @param underlyingId The vault's underlying.
    /// @return open      False while the vault must not take deposits or pay exits: the feed is dark
    ///                   (closed window, paused, stale or invalid) while the vault has open exposure, or an
    ///                   expired series is still waiting to be settled. Always true with no active series.
    /// @return liability Sum over the vault's open series of the premium time value writers have not yet
    ///                   earned (released linearly from each sale to its expiry) plus the intrinsic value of
    ///                   the puts at the latest feed spot (capped at their locked collateral), in asset
    ///                   units. Never exceeds lockedCollateral + unearnedPremium of the vault.
    function vaultState(uint32 underlyingId) external view returns (bool open, uint256 liability);
}
