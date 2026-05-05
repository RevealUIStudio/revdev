/**
 * React hook for querying RVUI token balance from Solana RPC.
 *
 * Reads the wallet address + network from StudioSettings (localStorage).
 * Queries the Token-2022 Associated Token Account for the RVUI mint.
 * Polls every 60 seconds via `usePollingFetch`. Returns zero gracefully
 * if the ATA doesn't exist; null when no wallet is configured.
 */

import { RVUI_MINT_ADDRESSES, RVUI_TOKEN_CONFIG } from '@revealui/contracts';
import { address, createSolanaRpc } from '@solana/kit';
import { useCallback, useMemo } from 'react';
import { usePollingFetch } from './use-polling-fetch';
import { useSettingsContext } from './use-settings';

const POLL_INTERVAL_MS = 60_000;

const CLUSTER_URLS: Record<string, string> = {
  devnet: 'https://api.devnet.solana.com',
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
};

interface BalancePayload {
  balance: string;
  uiAmount: number;
}

export interface RvuiBalanceState {
  /** Human-readable balance (e.g., "1,234.56 RVUI"). Null if not configured. */
  balance: string | null;
  /** Raw numeric balance for calculations. */
  uiAmount: number;
  /** Whether a query is in flight. */
  loading: boolean;
  /** Error message if the last query failed. */
  error: string | null;
  /** Whether a wallet address is configured. */
  configured: boolean;
  /** Trigger an immediate refresh. */
  refresh: () => Promise<void>;
}

export function useRvuiBalance(): RvuiBalanceState {
  const { settings } = useSettingsContext();
  const walletAddress = settings.solanaWalletAddress;
  const network = settings.solanaNetwork;
  const configured = walletAddress.length > 0;

  const fetchFn = useCallback(
    async (_signal: AbortSignal): Promise<BalancePayload | null> => {
      if (!walletAddress) return null;

      const mintAddress = RVUI_MINT_ADDRESSES[network];
      if (!mintAddress) {
        throw new Error(`RVUI not deployed on ${network}`);
      }

      const rpcUrl = CLUSTER_URLS[network] ?? CLUSTER_URLS.devnet;
      const rpc = createSolanaRpc(rpcUrl);
      const wallet = address(walletAddress);
      const mint = address(mintAddress);

      const response = await rpc
        .getTokenAccountsByOwner(
          wallet,
          { mint },
          { encoding: 'jsonParsed', commitment: 'confirmed' },
        )
        .send();

      if (response.value.length === 0) {
        return { balance: '0', uiAmount: 0 };
      }

      const accountData = response.value[0].account.data as {
        parsed: { info: { tokenAmount: { amount: string } } };
      };
      const raw = BigInt(accountData.parsed.info.tokenAmount.amount);
      const divisor = 10 ** RVUI_TOKEN_CONFIG.decimals;
      const amount = Number(raw) / divisor;

      return {
        balance: amount.toLocaleString(undefined, {
          minimumFractionDigits: 0,
          maximumFractionDigits: 2,
        }),
        uiAmount: amount,
      };
    },
    [walletAddress, network],
  );

  // Disable polling entirely when no wallet is configured. The fetcher
  // gates on walletAddress and would return null anyway, but skipping
  // the interval avoids a no-op fetch every minute on the unconfigured
  // path and keeps the legacy behavior of "do nothing until configured".
  const intervalMs = configured ? POLL_INTERVAL_MS : null;

  const { data, error, loading, refresh } = usePollingFetch(fetchFn, intervalMs);

  return useMemo<RvuiBalanceState>(
    () => ({
      balance: configured ? (data?.balance ?? null) : null,
      uiAmount: configured ? (data?.uiAmount ?? 0) : 0,
      loading,
      error: configured ? (error?.message ?? null) : null,
      configured,
      refresh,
    }),
    [configured, data, error, loading, refresh],
  );
}
