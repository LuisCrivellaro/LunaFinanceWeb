/**
 * Execução de um rascunho confirmado — comum a todos os canais de mensagem
 * (Telegram, WhatsApp via OpenBot). Recebe a transação de banco JÁ ABERTA por
 * `confirmPending`, então trava + gravação acontecem juntas (tudo ou nada).
 * Cada canal só formata a resposta; a regra de negócio fica nos serviços.
 */
import type { Queryable } from "../db/index.js";
import type { AuthUser } from "../services/access.js";
import type { Source } from "../services/audit.js";
import { recordInvoicePaymentWith } from "../services/cards.js";
import { contributeWith, createGoalWith, type GoalRow } from "../services/goals.js";
import { createTransactionWith, deleteTransactionWith, updateTransactionWith, type TransactionRow } from "../services/transactions.js";
import { createTransferWith, type TransferRow } from "../services/transfers.js";
import type { Draft } from "../telegram/parser.js";
import type { PendingPayload, TxDeletePayload } from "../telegram/state.js";

export type ExecResult =
  | { kind: "transaction"; transactions: TransactionRow[]; draft: Draft }
  | { kind: "goal"; goal: GoalRow }
  | { kind: "contribution"; contributionId: number; amountCents: number; goal: GoalRow }
  | { kind: "transfer"; transfer: TransferRow }
  | { kind: "tx_update"; transaction: TransactionRow }
  | { kind: "tx_delete"; deleted: TxDeletePayload }
  | { kind: "invoice_payment"; payment: Awaited<ReturnType<typeof recordInvoicePaymentWith>> };

/** Converte o rascunho no corpo aceito por `createTransactionWith` (mesma validação do site). */
export function draftToInput(d: Draft) {
  return {
    kind: d.kind,
    amountCents: d.amountCents,
    description: d.description,
    date: d.date,
    status: d.status,
    categoryId: d.categoryId,
    installments: d.installments,
    paymentMethod: d.paymentMethod,
    accountId: d.accountId,
    recurrence: d.recurrence ?? null,
    notes: d.notes ?? null,
    externalRef: d.externalRef ?? null,
  };
}

export async function executePending(q: Queryable, user: AuthUser, pl: PendingPayload, source: Source): Promise<{ resultId: number; result: ExecResult }> {
  switch (pl.kind) {
    case "transaction": {
      const created = await createTransactionWith(q, user, draftToInput(pl.draft), source);
      return { resultId: created[0].id, result: { kind: "transaction", transactions: created, draft: pl.draft } };
    }
    case "goal": {
      const g = await createGoalWith(q, user, { name: pl.goal.name, targetCents: pl.goal.targetCents, deadline: pl.goal.deadline, scope: pl.goal.scope }, source);
      return { resultId: g.id, result: { kind: "goal", goal: g } };
    }
    case "contribution": {
      const r = await contributeWith(q, user, pl.contribution.goalId, { amountCents: pl.contribution.amountCents }, source);
      return { resultId: r.id, result: { kind: "contribution", contributionId: r.id, amountCents: pl.contribution.amountCents, goal: r.goal } };
    }
    case "transfer": {
      const t = pl.transfer;
      const tr = await createTransferWith(q, user, { fromAccountId: t.fromAccountId, toAccountId: t.toAccountId, amountCents: t.amountCents, date: t.date }, source);
      return { resultId: tr.id, result: { kind: "transfer", transfer: tr } };
    }
    case "tx_update": {
      const updated = await updateTransactionWith(q, user, pl.update.txId, pl.update.patch, source);
      return { resultId: updated.id, result: { kind: "tx_update", transaction: updated } };
    }
    case "tx_delete": {
      await deleteTransactionWith(q, user, pl.del.txId, "one", source);
      return { resultId: pl.del.txId, result: { kind: "tx_delete", deleted: pl.del } };
    }
    case "invoice_payment": {
      const payment = await recordInvoicePaymentWith(q, user, pl.invoice, source);
      return { resultId: payment.id, result: { kind: "invoice_payment", payment } };
    }
  }
}
