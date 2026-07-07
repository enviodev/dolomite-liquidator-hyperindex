import { describe, it, expect } from "vitest";
import { createTestIndexer } from "envio";

// Deposit/withdraw paths need a Token + reverse map pre-seeded (no RPC in these
// handlers). LogAddMarket is intentionally not tested here because it performs
// RPC reads (token metadata + risk params) via the Effect API.

const CHAIN = 1;
const OWNER = "0x1111111111111111111111111111111111111111";
const TOKEN_ADDR = "0x2222222222222222222222222222222222222222";
const TOKEN_ID = `${CHAIN}-${TOKEN_ADDR}`;
const ONE_E18 = 10n ** 18n;

function seedToken(indexer: ReturnType<typeof createTestIndexer>) {
  indexer.Token.set({
    id: TOKEN_ID,
    symbol: "TKN",
    name: "Token",
    decimals: 18n,
    marketId: 0n,
  });
  indexer.TokenMarketIdReverseMap.set({ id: `${CHAIN}-0`, token_id: TOKEN_ID });
}

const par = (sign: boolean, value: bigint) => ({
  deltaWei: { sign, value },
  newPar: { sign, value },
});

describe("DolomiteMargin balance updates", () => {
  it("LogDeposit records a positive par and adds the token to supplyTokens", async () => {
    const indexer = createTestIndexer();
    seedToken(indexer);

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            {
              contract: "DolomiteMargin",
              event: "LogDeposit",
              transaction: { hash: "0xdead" },
              params: {
                accountOwner: OWNER,
                accountNumber: 0n,
                market: 0n,
                update: par(true, ONE_E18),
                from: OWNER,
              },
            },
          ],
        },
      },
    });

    const tv = await indexer.MarginAccountTokenValue.getOrThrow(`${CHAIN}-${OWNER}-0-0`);
    const account = await indexer.MarginAccount.getOrThrow(`${CHAIN}-${OWNER}-0`);

    expect(tv.valuePar.toString()).toEqual("1");
    expect(account.supplyTokens).toEqual([TOKEN_ID]);
    expect(account.hasSupplyValue).toBe(true);
    expect(account.borrowTokens).toEqual([]);
    expect(account.hasBorrowValue).toBe(false);
  });

  it("A withdraw into negative par moves the token into borrowTokens", async () => {
    const indexer = createTestIndexer();
    seedToken(indexer);

    // Deposit positive, then withdraw to a negative par.
    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            {
              contract: "DolomiteMargin",
              event: "LogDeposit",
              transaction: { hash: "0xaaaa" },
              params: {
                accountOwner: OWNER,
                accountNumber: 0n,
                market: 0n,
                update: par(true, ONE_E18),
                from: OWNER,
              },
            },
            {
              contract: "DolomiteMargin",
              event: "LogWithdraw",
              transaction: { hash: "0xbbbb" },
              params: {
                accountOwner: OWNER,
                accountNumber: 0n,
                market: 0n,
                update: par(false, 2n * ONE_E18), // newPar = -2
                to: OWNER,
              },
            },
          ],
        },
      },
    });

    const tv = await indexer.MarginAccountTokenValue.getOrThrow(`${CHAIN}-${OWNER}-0-0`);
    const account = await indexer.MarginAccount.getOrThrow(`${CHAIN}-${OWNER}-0`);

    expect(tv.valuePar.toString()).toEqual("-2");
    expect(account.borrowTokens).toEqual([TOKEN_ID]);
    expect(account.hasBorrowValue).toBe(true);
    expect(account.supplyTokens).toEqual([]);
    expect(account.hasSupplyValue).toBe(false);
    // Both transactions should be recorded as TokenValueUpdate rows on the token value.
    const update1 = await indexer.TokenValueUpdate.getOrThrow(`${tv.id}-${CHAIN}-0xaaaa`);
    const update2 = await indexer.TokenValueUpdate.getOrThrow(`${tv.id}-${CHAIN}-0xbbbb`);
    expect(update1.transaction_id).toEqual(`${CHAIN}-0xaaaa`);
    expect(update2.transaction_id).toEqual(`${CHAIN}-0xbbbb`);
  });
});

describe("EventEmitterRegistry async deposits", () => {
  it("AsyncDepositCreated then AsyncDepositExecuted transitions status", async () => {
    const indexer = createTestIndexer();
    seedToken(indexer);
    const KEY = "0x00000000000000000000000000000000000000000000000000000000000000ab";

    await indexer.process({
      chains: {
        [CHAIN]: {
          simulate: [
            {
              contract: "EventEmitterRegistry",
              event: "AsyncDepositCreated",
              params: {
                key: KEY,
                token: TOKEN_ADDR, // output token (indexed)
                deposit: {
                  key: KEY,
                  vault: OWNER,
                  accountNumber: 0n,
                  inputToken: TOKEN_ADDR,
                  inputAmount: ONE_E18,
                  outputAmount: 2n * ONE_E18,
                  isRetryable: true,
                },
              },
            },
            {
              contract: "EventEmitterRegistry",
              event: "AsyncDepositExecuted",
              params: { key: KEY, token: TOKEN_ADDR },
            },
          ],
        },
      },
    });

    const id = `${CHAIN}-${TOKEN_ADDR}-${KEY}`;
    const deposit = await indexer.AsyncDeposit.getOrThrow(id);
    expect(deposit.status).toEqual("DEPOSIT_EXECUTED");
    expect(deposit.inputAmount.toString()).toEqual("1");
    expect(deposit.outputAmount.toString()).toEqual("2");
    expect(deposit.isRetryable).toBe(true);
  });
});
