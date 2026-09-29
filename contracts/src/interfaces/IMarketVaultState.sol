// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice What a ProtectionVault needs from its market to price shares and gate entries / exits.
interface IMarketVaultState {
    /// @param underlyingId The vault's underlying.
    /// @return open      False while the vault must not take deposits or pay exits: the feed is dark
    ///                   (closed window, paused, stale or invalid) while the vault has open exposure, or an
    ///                   expired series is still waiting to be settled. Always true with no active series.
    /// @return liability Mark-to-market value of the vault's open puts at the latest feed spot that is not
    ///                   already covered by those series' own unearned premium, in asset units.
    function vaultState(uint32 underlyingId) external view returns (bool open, uint256 liability);
}
