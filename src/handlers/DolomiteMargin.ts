import { indexer, BigDecimal } from "envio";
import type { Token } from "envio";
import { getTokenMetadata, getNumMarkets } from "../effects";
import {
  ZERO_BD,
  ONE_BD,
  BD_ONE_ETH,
  bd,
  convertTokenToDecimal,
  tokenId,
  reverseMapId,
  marketRiskId,
  getOrCreateTransaction,
  getOrCreateMarginAccount,
  getOrCreateTokenValue,
  getOrCreateDolomiteMargin,
  type Ctx,
} from "./helpers";

const lc = (s: string) => s.toLowerCase();

type BalanceUpdate = {
  accountOwner: string;
  accountNumber: bigint;
  market: bigint;
  valuePar: BigDecimal;
};

// Ported from dolomite-margin-types.ts BalanceUpdate: `sign` false => negate.
function makeBalanceUpdate(
  accountOwner: string,
  accountNumber: bigint,
  token: Token,
  value: bigint,
  sign: boolean
): BalanceUpdate {
  return {
    accountOwner: lc(accountOwner),
    accountNumber,
    market: token.marketId,
    valuePar: convertTokenToDecimal(sign ? value : -value, token.decimals),
  };
}

async function tokenByMarket(context: Ctx, chainId: number, market: bigint): Promise<Token> {
  const reverse = await context.TokenMarketIdReverseMap.getOrThrow(reverseMapId(chainId, market));
  return await context.Token.getOrThrow(reverse.token_id);
}

// Ported from handleDolomiteMarginBalanceUpdateForAccount.
async function handleBalanceUpdate(
  context: Ctx,
  chainId: number,
  blockNumber: bigint,
  timestamp: bigint,
  txHash: string,
  bu: BalanceUpdate
): Promise<void> {
  const marginAccount = await getOrCreateMarginAccount(
    context,
    chainId,
    bu.accountOwner,
    bu.accountNumber,
    blockNumber,
    timestamp
  );

  const token = await tokenByMarket(context, chainId, bu.market);
  const transaction = await getOrCreateTransaction(context, chainId, txHash, blockNumber, timestamp);
  const tokenValue = await getOrCreateTokenValue(context, marginAccount, token, transaction.id);
  const oldPar = tokenValue.valuePar;

  if (oldPar.lt(ZERO_BD) && bu.valuePar.gte(ZERO_BD)) {
    // negative -> non-negative: remove from borrowTokens
    const idx = marginAccount.borrowTokens.indexOf(token.id);
    if (idx !== -1) {
      const copy = [...marginAccount.borrowTokens];
      copy.splice(idx, 1);
      marginAccount.borrowTokens = copy;
    }
  } else if (oldPar.gte(ZERO_BD) && bu.valuePar.lt(ZERO_BD)) {
    // non-negative -> negative: add to borrowTokens
    marginAccount.borrowTokens = [...marginAccount.borrowTokens, token.id];
  }
  marginAccount.hasBorrowValue = marginAccount.borrowTokens.length > 0;

  if (oldPar.lte(ZERO_BD) && bu.valuePar.gt(ZERO_BD)) {
    // zero/negative -> positive: add to supplyTokens
    marginAccount.supplyTokens = [...marginAccount.supplyTokens, token.id];
  } else if (oldPar.gt(ZERO_BD) && bu.valuePar.lte(ZERO_BD)) {
    // positive -> zero/negative: remove from supplyTokens
    const idx = marginAccount.supplyTokens.indexOf(token.id);
    if (idx !== -1) {
      const copy = [...marginAccount.supplyTokens];
      copy.splice(idx, 1);
      marginAccount.supplyTokens = copy;
    }
  }
  marginAccount.hasSupplyValue = marginAccount.supplyTokens.length > 0;

  tokenValue.valuePar = bu.valuePar;

  context.MarginAccount.set(marginAccount);
  context.MarginAccountTokenValue.set(tokenValue);
}

// ---------------------------------------------------------------------------
// Market configuration
// ---------------------------------------------------------------------------

indexer.onEvent({ contract: "DolomiteMargin", event: "LogAddMarket" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const marginAddress = lc(event.srcAddress);

  const dolomiteMargin = await getOrCreateDolomiteMargin(context, chainId, marginAddress);
  dolomiteMargin.numberOfMarkets = await context.effect(getNumMarkets, { chainId, marginAddress });
  context.DolomiteMargin.set(dolomiteMargin);

  const tokenAddress = lc(event.params.token);
  const tid = tokenId(chainId, tokenAddress);
  const existingToken = await context.Token.get(tid);
  if (existingToken === undefined) {
    const meta = await context.effect(getTokenMetadata, { chainId, address: tokenAddress });
    context.Token.set({
      id: tid,
      marketId: event.params.marketId,
      name: meta.name,
      symbol: meta.symbol,
      decimals: BigInt(meta.decimals),
    });
    context.TokenMarketIdReverseMap.set({
      id: reverseMapId(chainId, event.params.marketId),
      token_id: tid,
    });
  }

  context.MarketRiskInfo.set({
    id: marketRiskId(chainId, tokenAddress),
    token_id: tid,
    marginPremium: ZERO_BD,
    liquidationRewardPremium: ZERO_BD,
    isBorrowingDisabled: false,
  });
});

indexer.onEvent({ contract: "DolomiteMargin", event: "LogRemoveMarket" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const marginAddress = lc(event.srcAddress);

  const dolomiteMargin = await getOrCreateDolomiteMargin(context, chainId, marginAddress);
  // NOTE: matches the subgraph exactly (it increments here rather than decrements).
  dolomiteMargin.numberOfMarkets = dolomiteMargin.numberOfMarkets + 1;
  context.DolomiteMargin.set(dolomiteMargin);

  const reverse = await context.TokenMarketIdReverseMap.getOrThrow(
    reverseMapId(chainId, event.params.marketId)
  );
  // Subgraph removes both entities using the *token* id. MarketRiskInfo is keyed by
  // token id so it is removed; the reverse map is keyed by marketId so this is a
  // no-op there (mirroring the subgraph's behaviour).
  context.TokenMarketIdReverseMap.deleteUnsafe(reverse.token_id);
  context.MarketRiskInfo.deleteUnsafe(reverse.token_id);
});

indexer.onEvent({ contract: "DolomiteMargin", event: "LogSetIsClosing" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const reverse = await context.TokenMarketIdReverseMap.getOrThrow(
    reverseMapId(chainId, event.params.marketId)
  );
  const marketInfo = await context.MarketRiskInfo.getOrThrow(reverse.token_id);
  context.MarketRiskInfo.set({ ...marketInfo, isBorrowingDisabled: event.params.isClosing });
});

// ---------------------------------------------------------------------------
// Risk parameters
// ---------------------------------------------------------------------------

indexer.onEvent({ contract: "DolomiteMargin", event: "LogSetEarningsRate" }, async ({ event, context }) => {
  const dm = await getOrCreateDolomiteMargin(context, event.chainId, lc(event.srcAddress));
  dm.earningsRate = bd(event.params.earningsRate.value).div(BD_ONE_ETH);
  context.DolomiteMargin.set(dm);
});

indexer.onEvent({ contract: "DolomiteMargin", event: "LogSetLiquidationSpread" }, async ({ event, context }) => {
  const dm = await getOrCreateDolomiteMargin(context, event.chainId, lc(event.srcAddress));
  dm.liquidationReward = bd(event.params.liquidationSpread.value).div(BD_ONE_ETH).plus(ONE_BD);
  context.DolomiteMargin.set(dm);
});

indexer.onEvent({ contract: "DolomiteMargin", event: "LogSetMarginRatio" }, async ({ event, context }) => {
  const dm = await getOrCreateDolomiteMargin(context, event.chainId, lc(event.srcAddress));
  dm.liquidationRatio = bd(event.params.marginRatio.value).div(BD_ONE_ETH).plus(ONE_BD);
  context.DolomiteMargin.set(dm);
});

indexer.onEvent({ contract: "DolomiteMargin", event: "LogSetMinBorrowedValue" }, async ({ event, context }) => {
  const dm = await getOrCreateDolomiteMargin(context, event.chainId, lc(event.srcAddress));
  dm.minBorrowedValue = bd(event.params.minBorrowedValue.value).div(BD_ONE_ETH).div(BD_ONE_ETH);
  context.DolomiteMargin.set(dm);
});

indexer.onEvent({ contract: "DolomiteMargin", event: "LogSetMarginPremium" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const reverse = await context.TokenMarketIdReverseMap.getOrThrow(
    reverseMapId(chainId, event.params.marketId)
  );
  const marketInfo = await context.MarketRiskInfo.getOrThrow(reverse.token_id);
  context.MarketRiskInfo.set({
    ...marketInfo,
    marginPremium: bd(event.params.marginPremium.value).div(BD_ONE_ETH),
  });
});

indexer.onEvent({ contract: "DolomiteMargin", event: "LogSetSpreadPremium" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const reverse = await context.TokenMarketIdReverseMap.getOrThrow(
    reverseMapId(chainId, event.params.marketId)
  );
  const marketInfo = await context.MarketRiskInfo.getOrThrow(reverse.token_id);
  context.MarketRiskInfo.set({
    ...marketInfo,
    liquidationRewardPremium: bd(event.params.spreadPremium.value).div(BD_ONE_ETH),
  });
});

indexer.onEvent(
  { contract: "DolomiteMargin", event: "LogSetLiquidationSpreadPremium" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const reverse = await context.TokenMarketIdReverseMap.getOrThrow(
      reverseMapId(chainId, event.params.marketId)
    );
    const marketInfo = await context.MarketRiskInfo.getOrThrow(reverse.token_id);
    context.MarketRiskInfo.set({
      ...marketInfo,
      liquidationRewardPremium: bd(event.params.liquidationSpreadPremium.value).div(BD_ONE_ETH),
    });
  }
);

// ---------------------------------------------------------------------------
// Balance updates
// ---------------------------------------------------------------------------

indexer.onEvent({ contract: "DolomiteMargin", event: "LogDeposit" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const bn = BigInt(event.block.number);
  const ts = BigInt(event.block.timestamp);
  const token = await tokenByMarket(context, chainId, event.params.market);
  await handleBalanceUpdate(
    context,
    chainId,
    bn,
    ts,
    event.transaction.hash,
    makeBalanceUpdate(
      event.params.accountOwner,
      event.params.accountNumber,
      token,
      event.params.update.newPar.value,
      event.params.update.newPar.sign
    )
  );
});

indexer.onEvent({ contract: "DolomiteMargin", event: "LogWithdraw" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const bn = BigInt(event.block.number);
  const ts = BigInt(event.block.timestamp);
  const token = await tokenByMarket(context, chainId, event.params.market);
  await handleBalanceUpdate(
    context,
    chainId,
    bn,
    ts,
    event.transaction.hash,
    makeBalanceUpdate(
      event.params.accountOwner,
      event.params.accountNumber,
      token,
      event.params.update.newPar.value,
      event.params.update.newPar.sign
    )
  );
});

indexer.onEvent({ contract: "DolomiteMargin", event: "LogTransfer" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const bn = BigInt(event.block.number);
  const ts = BigInt(event.block.timestamp);
  const token = await tokenByMarket(context, chainId, event.params.market);
  await handleBalanceUpdate(
    context, chainId, bn, ts, event.transaction.hash,
    makeBalanceUpdate(
      event.params.accountOneOwner, event.params.accountOneNumber, token,
      event.params.updateOne.newPar.value, event.params.updateOne.newPar.sign
    )
  );
  await handleBalanceUpdate(
    context, chainId, bn, ts, event.transaction.hash,
    makeBalanceUpdate(
      event.params.accountTwoOwner, event.params.accountTwoNumber, token,
      event.params.updateTwo.newPar.value, event.params.updateTwo.newPar.sign
    )
  );
});

indexer.onEvent({ contract: "DolomiteMargin", event: "LogBuy" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const bn = BigInt(event.block.number);
  const ts = BigInt(event.block.timestamp);
  const makerToken = await tokenByMarket(context, chainId, event.params.makerMarket);
  const takerToken = await tokenByMarket(context, chainId, event.params.takerMarket);
  await handleBalanceUpdate(
    context, chainId, bn, ts, event.transaction.hash,
    makeBalanceUpdate(
      event.params.accountOwner, event.params.accountNumber, makerToken,
      event.params.makerUpdate.newPar.value, event.params.makerUpdate.newPar.sign
    )
  );
  await handleBalanceUpdate(
    context, chainId, bn, ts, event.transaction.hash,
    makeBalanceUpdate(
      event.params.accountOwner, event.params.accountNumber, takerToken,
      event.params.takerUpdate.newPar.value, event.params.takerUpdate.newPar.sign
    )
  );
});

indexer.onEvent({ contract: "DolomiteMargin", event: "LogSell" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const bn = BigInt(event.block.number);
  const ts = BigInt(event.block.timestamp);
  const makerToken = await tokenByMarket(context, chainId, event.params.makerMarket);
  const takerToken = await tokenByMarket(context, chainId, event.params.takerMarket);
  await handleBalanceUpdate(
    context, chainId, bn, ts, event.transaction.hash,
    makeBalanceUpdate(
      event.params.accountOwner, event.params.accountNumber, makerToken,
      event.params.makerUpdate.newPar.value, event.params.makerUpdate.newPar.sign
    )
  );
  await handleBalanceUpdate(
    context, chainId, bn, ts, event.transaction.hash,
    makeBalanceUpdate(
      event.params.accountOwner, event.params.accountNumber, takerToken,
      event.params.takerUpdate.newPar.value, event.params.takerUpdate.newPar.sign
    )
  );
});

indexer.onEvent({ contract: "DolomiteMargin", event: "LogTrade" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const bn = BigInt(event.block.number);
  const ts = BigInt(event.block.timestamp);
  const inputToken = await tokenByMarket(context, chainId, event.params.inputMarket);
  const outputToken = await tokenByMarket(context, chainId, event.params.outputMarket);
  await handleBalanceUpdate(
    context, chainId, bn, ts, event.transaction.hash,
    makeBalanceUpdate(
      event.params.makerAccountOwner, event.params.makerAccountNumber, inputToken,
      event.params.makerInputUpdate.newPar.value, event.params.makerInputUpdate.newPar.sign
    )
  );
  await handleBalanceUpdate(
    context, chainId, bn, ts, event.transaction.hash,
    makeBalanceUpdate(
      event.params.makerAccountOwner, event.params.makerAccountNumber, outputToken,
      event.params.makerOutputUpdate.newPar.value, event.params.makerOutputUpdate.newPar.sign
    )
  );
  await handleBalanceUpdate(
    context, chainId, bn, ts, event.transaction.hash,
    makeBalanceUpdate(
      event.params.takerAccountOwner, event.params.takerAccountNumber, inputToken,
      event.params.takerInputUpdate.newPar.value, event.params.takerInputUpdate.newPar.sign
    )
  );
  await handleBalanceUpdate(
    context, chainId, bn, ts, event.transaction.hash,
    makeBalanceUpdate(
      event.params.takerAccountOwner, event.params.takerAccountNumber, outputToken,
      event.params.takerOutputUpdate.newPar.value, event.params.takerOutputUpdate.newPar.sign
    )
  );
});

indexer.onEvent({ contract: "DolomiteMargin", event: "LogLiquidate" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const bn = BigInt(event.block.number);
  const ts = BigInt(event.block.timestamp);
  const heldToken = await tokenByMarket(context, chainId, event.params.heldMarket);
  const owedToken = await tokenByMarket(context, chainId, event.params.owedMarket);
  await handleBalanceUpdate(
    context, chainId, bn, ts, event.transaction.hash,
    makeBalanceUpdate(
      event.params.liquidAccountOwner, event.params.liquidAccountNumber, heldToken,
      event.params.liquidHeldUpdate.newPar.value, event.params.liquidHeldUpdate.newPar.sign
    )
  );
  await handleBalanceUpdate(
    context, chainId, bn, ts, event.transaction.hash,
    makeBalanceUpdate(
      event.params.liquidAccountOwner, event.params.liquidAccountNumber, owedToken,
      event.params.liquidOwedUpdate.newPar.value, event.params.liquidOwedUpdate.newPar.sign
    )
  );
  await handleBalanceUpdate(
    context, chainId, bn, ts, event.transaction.hash,
    makeBalanceUpdate(
      event.params.solidAccountOwner, event.params.solidAccountNumber, heldToken,
      event.params.solidHeldUpdate.newPar.value, event.params.solidHeldUpdate.newPar.sign
    )
  );
  await handleBalanceUpdate(
    context, chainId, bn, ts, event.transaction.hash,
    makeBalanceUpdate(
      event.params.solidAccountOwner, event.params.solidAccountNumber, owedToken,
      event.params.solidOwedUpdate.newPar.value, event.params.solidOwedUpdate.newPar.sign
    )
  );
});

indexer.onEvent({ contract: "DolomiteMargin", event: "LogVaporize" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const bn = BigInt(event.block.number);
  const ts = BigInt(event.block.timestamp);
  const heldToken = await tokenByMarket(context, chainId, event.params.heldMarket);
  const owedToken = await tokenByMarket(context, chainId, event.params.owedMarket);
  await handleBalanceUpdate(
    context, chainId, bn, ts, event.transaction.hash,
    makeBalanceUpdate(
      event.params.vaporAccountOwner, event.params.vaporAccountNumber, owedToken,
      event.params.vaporOwedUpdate.newPar.value, event.params.vaporOwedUpdate.newPar.sign
    )
  );
  await handleBalanceUpdate(
    context, chainId, bn, ts, event.transaction.hash,
    makeBalanceUpdate(
      event.params.solidAccountOwner, event.params.solidAccountNumber, heldToken,
      event.params.solidHeldUpdate.newPar.value, event.params.solidHeldUpdate.newPar.sign
    )
  );
  await handleBalanceUpdate(
    context, chainId, bn, ts, event.transaction.hash,
    makeBalanceUpdate(
      event.params.solidAccountOwner, event.params.solidAccountNumber, owedToken,
      event.params.solidOwedUpdate.newPar.value, event.params.solidOwedUpdate.newPar.sign
    )
  );
});
