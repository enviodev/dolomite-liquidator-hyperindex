import { indexer } from "envio";
import {
  asyncKey,
  tokenId,
  convertTokenToDecimal,
  getOrCreateMarginAccount,
} from "./helpers";

const lc = (s: string) => s.toLowerCase();

// Status enums (ported from event-emitter-registry-helpers.ts)
const AsyncDepositStatus = {
  CREATED: "CREATED",
  DEPOSIT_EXECUTED: "DEPOSIT_EXECUTED",
  DEPOSIT_FAILED: "DEPOSIT_FAILED",
  DEPOSIT_CANCELLED: "DEPOSIT_CANCELLED",
  DEPOSIT_CANCELLED_FAILED: "DEPOSIT_CANCELLED_FAILED",
} as const;

const AsyncWithdrawalStatus = {
  CREATED: "CREATED",
  WITHDRAWAL_EXECUTED: "WITHDRAWAL_EXECUTED",
  WITHDRAWAL_EXECUTION_FAILED: "WITHDRAWAL_EXECUTION_FAILED",
  WITHDRAWAL_CANCELLED: "WITHDRAWAL_CANCELLED",
} as const;

// ---------------------------------------------------------------------------
// Async deposits
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "EventEmitterRegistry", event: "AsyncDepositCreated" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const id = asyncKey(chainId, lc(event.params.token), lc(event.params.key));

    // For deposits the indexed `token` is the OUTPUT token.
    const inputToken = await context.Token.getOrThrow(
      tokenId(chainId, lc(event.params.deposit.inputToken))
    );
    const outputToken = await context.Token.getOrThrow(tokenId(chainId, lc(event.params.token)));

    const marginAccount = await getOrCreateMarginAccount(
      context,
      chainId,
      lc(event.params.deposit.vault),
      event.params.deposit.accountNumber,
      BigInt(event.block.number),
      BigInt(event.block.timestamp)
    );

    context.AsyncDeposit.set({
      id,
      key: event.params.key,
      marginAccount_id: marginAccount.id,
      effectiveUser_id: marginAccount.user_id,
      status: AsyncDepositStatus.CREATED,
      inputToken_id: inputToken.id,
      inputAmount: convertTokenToDecimal(event.params.deposit.inputAmount, inputToken.decimals),
      outputToken_id: outputToken.id,
      minOutputAmount: convertTokenToDecimal(event.params.deposit.outputAmount, outputToken.decimals),
      outputAmount: convertTokenToDecimal(event.params.deposit.outputAmount, outputToken.decimals),
      isRetryable: event.params.deposit.isRetryable,
    });
  }
);

indexer.onEvent(
  { contract: "EventEmitterRegistry", event: "AsyncDepositOutputAmountUpdated" },
  async ({ event, context }) => {
    const id = asyncKey(event.chainId, lc(event.params.token), lc(event.params.key));
    const deposit = await context.AsyncDeposit.getOrThrow(id);
    const outputToken = await context.Token.getOrThrow(deposit.outputToken_id);
    context.AsyncDeposit.set({
      ...deposit,
      outputAmount: convertTokenToDecimal(event.params.outputAmount, outputToken.decimals),
    });
  }
);

indexer.onEvent(
  { contract: "EventEmitterRegistry", event: "AsyncDepositExecuted" },
  async ({ event, context }) => {
    const id = asyncKey(event.chainId, lc(event.params.token), lc(event.params.key));
    const deposit = await context.AsyncDeposit.getOrThrow(id);
    context.AsyncDeposit.set({ ...deposit, status: AsyncDepositStatus.DEPOSIT_EXECUTED });
  }
);

indexer.onEvent(
  { contract: "EventEmitterRegistry", event: "AsyncDepositFailed" },
  async ({ event, context }) => {
    const id = asyncKey(event.chainId, lc(event.params.token), lc(event.params.key));
    const deposit = await context.AsyncDeposit.getOrThrow(id);
    context.AsyncDeposit.set({ ...deposit, status: AsyncDepositStatus.DEPOSIT_FAILED });
  }
);

indexer.onEvent(
  { contract: "EventEmitterRegistry", event: "AsyncDepositCancelled" },
  async ({ event, context }) => {
    const id = asyncKey(event.chainId, lc(event.params.token), lc(event.params.key));
    const deposit = await context.AsyncDeposit.getOrThrow(id);
    context.AsyncDeposit.set({
      ...deposit,
      status: AsyncDepositStatus.DEPOSIT_CANCELLED,
      isRetryable: false,
    });
  }
);

indexer.onEvent(
  { contract: "EventEmitterRegistry", event: "AsyncDepositCancelledFailed" },
  async ({ event, context }) => {
    const id = asyncKey(event.chainId, lc(event.params.token), lc(event.params.key));
    const deposit = await context.AsyncDeposit.getOrThrow(id);
    context.AsyncDeposit.set({
      ...deposit,
      status: AsyncDepositStatus.DEPOSIT_CANCELLED_FAILED,
      isRetryable: true,
    });
  }
);

// ---------------------------------------------------------------------------
// Async withdrawals
// ---------------------------------------------------------------------------

indexer.onEvent(
  { contract: "EventEmitterRegistry", event: "AsyncWithdrawalCreated" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const id = asyncKey(chainId, lc(event.params.token), lc(event.params.key));

    // For withdrawals the indexed `token` is the INPUT token.
    const inputToken = await context.Token.getOrThrow(tokenId(chainId, lc(event.params.token)));
    const outputToken = await context.Token.getOrThrow(
      tokenId(chainId, lc(event.params.withdrawal.outputToken))
    );

    const marginAccount = await getOrCreateMarginAccount(
      context,
      chainId,
      lc(event.params.withdrawal.vault),
      event.params.withdrawal.accountNumber,
      BigInt(event.block.number),
      BigInt(event.block.timestamp)
    );

    context.AsyncWithdrawal.set({
      id,
      key: event.params.key,
      marginAccount_id: marginAccount.id,
      effectiveUser_id: marginAccount.user_id,
      status: AsyncWithdrawalStatus.CREATED,
      inputToken_id: inputToken.id,
      inputAmount: convertTokenToDecimal(event.params.withdrawal.inputAmount, inputToken.decimals),
      outputToken_id: outputToken.id,
      minOutputAmount: convertTokenToDecimal(
        event.params.withdrawal.outputAmount,
        outputToken.decimals
      ),
      outputAmount: convertTokenToDecimal(event.params.withdrawal.outputAmount, outputToken.decimals),
      isRetryable: event.params.withdrawal.isRetryable,
      isLiquidation: event.params.withdrawal.isLiquidation,
      extraData: event.params.withdrawal.extraData,
    });
  }
);

indexer.onEvent(
  { contract: "EventEmitterRegistry", event: "AsyncWithdrawalOutputAmountUpdated" },
  async ({ event, context }) => {
    const id = asyncKey(event.chainId, lc(event.params.token), lc(event.params.key));
    const withdrawal = await context.AsyncWithdrawal.getOrThrow(id);
    const outputToken = await context.Token.getOrThrow(withdrawal.outputToken_id);
    context.AsyncWithdrawal.set({
      ...withdrawal,
      outputAmount: convertTokenToDecimal(event.params.outputAmount, outputToken.decimals),
    });
  }
);

indexer.onEvent(
  { contract: "EventEmitterRegistry", event: "AsyncWithdrawalExecuted" },
  async ({ event, context }) => {
    const id = asyncKey(event.chainId, lc(event.params.token), lc(event.params.key));
    const withdrawal = await context.AsyncWithdrawal.getOrThrow(id);
    context.AsyncWithdrawal.set({
      ...withdrawal,
      status: AsyncWithdrawalStatus.WITHDRAWAL_EXECUTED,
      isRetryable: false,
    });
  }
);

indexer.onEvent(
  { contract: "EventEmitterRegistry", event: "AsyncWithdrawalFailed" },
  async ({ event, context }) => {
    const id = asyncKey(event.chainId, lc(event.params.token), lc(event.params.key));
    const withdrawal = await context.AsyncWithdrawal.getOrThrow(id);
    context.AsyncWithdrawal.set({
      ...withdrawal,
      status: AsyncWithdrawalStatus.WITHDRAWAL_EXECUTION_FAILED,
      isRetryable: true,
    });
  }
);

indexer.onEvent(
  { contract: "EventEmitterRegistry", event: "AsyncWithdrawalCancelled" },
  async ({ event, context }) => {
    const id = asyncKey(event.chainId, lc(event.params.token), lc(event.params.key));
    const withdrawal = await context.AsyncWithdrawal.getOrThrow(id);
    context.AsyncWithdrawal.set({
      ...withdrawal,
      status: AsyncWithdrawalStatus.WITHDRAWAL_CANCELLED,
      isRetryable: false,
    });
  }
);
