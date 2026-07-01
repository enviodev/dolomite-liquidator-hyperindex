import { BigDecimal } from "envio";
import type {
  DolomiteMargin,
  MarginAccount,
  MarginAccountTokenValue,
  Token,
  Transaction,
  EvmOnEventContext,
} from "envio";
import { getRiskParams } from "../effects";

export type Ctx = EvmOnEventContext;

// Make an entity's fields writable so we can mutate a loaded copy before .set().
export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

// ---------------------------------------------------------------------------
// BigDecimal constants & helpers (ported from subgraph src/mappings/helpers.ts)
// ---------------------------------------------------------------------------

export const ZERO_BD = new BigDecimal(0);
export const ONE_BD = new BigDecimal(1);
export const BD_ONE_ETH = new BigDecimal("1000000000000000000"); // 1e18

export function bd(value: string | bigint): BigDecimal {
  return new BigDecimal(value.toString());
}

function exponentToBigDecimal(decimals: bigint): BigDecimal {
  return new BigDecimal(10).pow(Number(decimals));
}

export function convertTokenToDecimal(tokenAmount: bigint, exchangeDecimals: bigint): BigDecimal {
  if (exchangeDecimals === 0n) {
    return bd(tokenAmount);
  }
  return bd(tokenAmount).div(exponentToBigDecimal(exchangeDecimals));
}

// ---------------------------------------------------------------------------
// Entity id builders. Every id is namespaced with the chainId because this is a
// single multichain indexer (several chains reuse the same addresses).
// Addresses arrive lowercased via `address_format: lowercase`.
// ---------------------------------------------------------------------------

export const tokenId = (chainId: number, address: string) => `${chainId}-${address}`;
export const userId = (chainId: number, address: string) => `${chainId}-${address}`;
export const marginAccountId = (chainId: number, owner: string, accountNumber: bigint) =>
  `${chainId}-${owner}-${accountNumber.toString()}`;
export const txId = (chainId: number, hash: string) => `${chainId}-${hash}`;
export const reverseMapId = (chainId: number, marketId: bigint) => `${chainId}-${marketId.toString()}`;
export const marketRiskId = (chainId: number, address: string) => `${chainId}-${address}`;
export const dolomiteMarginId = (chainId: number, address: string) => `${chainId}-${address}`;
export const asyncKey = (chainId: number, token: string, key: string) => `${chainId}-${token}-${key}`;

// ---------------------------------------------------------------------------
// getOrCreate helpers (ported). Mirroring the subgraph, these do NOT persist the
// MarginAccount / MarginAccountTokenValue themselves — the caller decides whether
// to `.set()` (matches which handlers call `.save()` in the subgraph).
// ---------------------------------------------------------------------------

export async function getOrCreateTransaction(
  context: Ctx,
  chainId: number,
  hash: string,
  blockNumber: bigint,
  timestamp: bigint
): Promise<Transaction> {
  const id = txId(chainId, hash);
  let transaction = await context.Transaction.get(id);
  if (transaction === undefined) {
    transaction = { id, blockNumber, timestamp };
    context.Transaction.set(transaction);
  }
  return transaction;
}

export async function getOrCreateMarginAccount(
  context: Ctx,
  chainId: number,
  owner: string,
  accountNumber: bigint,
  blockNumber: bigint,
  timestamp: bigint
): Promise<Mutable<MarginAccount>> {
  const uid = userId(chainId, owner);
  const user = await context.User.get(uid);
  if (user === undefined) {
    context.User.set({ id: uid });
  }

  const id = marginAccountId(chainId, owner, accountNumber);
  const existing = await context.MarginAccount.get(id);

  let marginAccount: Mutable<MarginAccount>;
  if (existing === undefined) {
    marginAccount = {
      id,
      user_id: uid,
      accountNumber,
      lastUpdatedTimestamp: timestamp,
      lastUpdatedBlockNumber: blockNumber,
      borrowTokens: [],
      supplyTokens: [],
      expirationTokens: [],
      hasBorrowValue: false,
      hasSupplyValue: false,
      hasExpiration: false,
    };
  } else {
    marginAccount = { ...existing };
  }

  marginAccount.lastUpdatedBlockNumber = blockNumber;
  marginAccount.lastUpdatedTimestamp = timestamp;

  return marginAccount;
}

export async function getOrCreateTokenValue(
  context: Ctx,
  marginAccount: MarginAccount,
  token: Token,
  transactionId: string
): Promise<Mutable<MarginAccountTokenValue>> {
  const id = `${marginAccount.user_id}-${marginAccount.accountNumber.toString()}-${token.marketId.toString()}`;
  const existing = await context.MarginAccountTokenValue.get(id);

  let tokenValue: Mutable<MarginAccountTokenValue>;
  if (existing === undefined) {
    tokenValue = {
      id,
      marginAccount_id: marginAccount.id,
      marketId: token.marketId,
      token_id: token.id,
      valuePar: ZERO_BD,
      expirationTimestamp: undefined,
      expiryAddress: undefined,
      lastUpdateTransaction_id: transactionId,
      allUpdateTransactions: [],
    };
  } else {
    tokenValue = { ...existing };
  }

  tokenValue.lastUpdateTransaction_id = transactionId;
  tokenValue.allUpdateTransactions = [...tokenValue.allUpdateTransactions, transactionId];

  return tokenValue;
}

/**
 * DolomiteMargin singleton (per chain). On first creation it reads the four risk
 * params over RPC (via the getRiskParams effect) with the same math as the
 * subgraph's getOrCreateDolomiteMarginForCall.
 */
export async function getOrCreateDolomiteMargin(
  context: Ctx,
  chainId: number,
  marginAddress: string
): Promise<Mutable<DolomiteMargin>> {
  const id = dolomiteMarginId(chainId, marginAddress);
  const existing = await context.DolomiteMargin.get(id);
  if (existing !== undefined) {
    return { ...existing };
  }

  const rp = await context.effect(getRiskParams, { chainId, marginAddress });
  return {
    id,
    numberOfMarkets: 0,
    liquidationRatio: bd(rp.marginRatio).div(BD_ONE_ETH).plus(ONE_BD),
    liquidationReward: bd(rp.liquidationSpread).div(BD_ONE_ETH).plus(ONE_BD),
    earningsRate: bd(rp.earningsRate).div(BD_ONE_ETH),
    minBorrowedValue: bd(rp.minBorrowedValue).div(BD_ONE_ETH).div(BD_ONE_ETH),
  };
}
