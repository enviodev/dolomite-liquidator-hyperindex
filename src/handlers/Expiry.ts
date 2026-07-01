import { indexer } from "envio";
import {
  reverseMapId,
  getOrCreateTransaction,
  getOrCreateMarginAccount,
  getOrCreateTokenValue,
} from "./helpers";

const lc = (s: string) => s.toLowerCase();

// Ported from handleSetExpiry (dolomite-margin.ts). Emitted by the Expiry contract.
indexer.onEvent({ contract: "Expiry", event: "ExpirySet" }, async ({ event, context }) => {
  const chainId = event.chainId;
  const bn = BigInt(event.block.number);
  const ts = BigInt(event.block.timestamp);

  const reverse = await context.TokenMarketIdReverseMap.getOrThrow(
    reverseMapId(chainId, event.params.marketId)
  );
  const token = await context.Token.getOrThrow(reverse.token_id);

  const marginAccount = await getOrCreateMarginAccount(
    context,
    chainId,
    lc(event.params.owner),
    event.params.number,
    bn,
    ts
  );

  if (event.params.time === 0n) {
    const idx = marginAccount.expirationTokens.indexOf(token.id);
    if (idx !== -1) {
      const copy = [...marginAccount.expirationTokens];
      copy.splice(idx, 1);
      marginAccount.expirationTokens = copy;
    }
    marginAccount.hasExpiration = marginAccount.expirationTokens.length > 0;
  } else {
    const idx = marginAccount.expirationTokens.indexOf(token.id);
    if (idx === -1) {
      marginAccount.expirationTokens = [...marginAccount.expirationTokens, token.id];
    }
    marginAccount.hasExpiration = true;
  }
  context.MarginAccount.set(marginAccount);

  const transaction = await getOrCreateTransaction(context, chainId, event.transaction.hash, bn, ts);
  const tokenValue = await getOrCreateTokenValue(context, marginAccount, token, transaction.id);
  if (event.params.time === 0n) {
    tokenValue.expirationTimestamp = undefined;
    tokenValue.expiryAddress = undefined;
  } else {
    tokenValue.expirationTimestamp = event.params.time;
    tokenValue.expiryAddress = lc(event.srcAddress);
  }
  context.MarginAccountTokenValue.set(tokenValue);
});
