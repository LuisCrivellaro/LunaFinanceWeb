/**
 * Operações de escrita pelo WhatsApp (OpenBot). Toda escrita vira um RASCUNHO
 * persistente, versionado e com validade (o mesmo mecanismo do Telegram, no
 * canal "whatsapp"). A gravação só acontece na confirmação atômica.
 *
 * O OpenBot entrega a intenção estruturada; o backend valida, completa com o
 * parser determinístico (sem IA) a partir do texto original e NUNCA inventa:
 * sem valor explícito, não há lançamento.
 */
import { z } from "zod";
import type { Db, Queryable } from "../../db/index.js";
import { addDays, now, today } from "../../lib/clock.js";
import { badRequest, conflict, forbidden, HttpError, notFound } from "../../lib/errors.js";
import { MAX_CENTS, parseMoneyToCents } from "../../lib/money.js";
import { parse, zCents, zDate, zId } from "../../lib/validate.js";
import type { AuthUser } from "../../services/access.js";
import { listAccounts } from "../../services/accounts.js";
import { getCardSettings, invoiceCycle, invoiceMonthFor, invoiceSummary, memberCard } from "../../services/cards.js";
import { listCategories } from "../../services/categories.js";
import { getTransactions, PAYMENT_LABELS, PAYMENT_METHODS, splitInstallments, TX_SELECT, type TransactionRow } from "../../services/transactions.js";
import { executePending, type ExecResult } from "../../channels/execute.js";
import { findPossibleDuplicate } from "../../telegram/data.js";
import { matchCategory, normalize, parseEntry, type CategoryLite, type Draft } from "../../telegram/parser.js";
import {
  cancelPending, confirmPending, createPending, findPendingByRef, getPending, pendingProblem, PENDING_TTL_MIN, type Pending, type PendingPayload,
} from "../../telegram/state.js";
import { addMonths } from "../../lib/clock.js";
import { formatBRL } from "../../lib/money.js";
import type { IntegrationSettings } from "./identity.js";

const CHANNEL = "whatsapp" as const;

/** Remove caracteres de controle; textos vindos do chat são DADOS, nunca instruções. */
const cleanText = (max: number) =>
  z
    .string()
    .transform((s) => s.replace(/[\u0000-\u001f\u007f​-‏‪-‮]/g, " ").replace(/\s+/g, " ").trim())
    .pipe(z.string().max(max));

const zAmount = z.union([z.number().positive().max(MAX_CENTS / 100), z.string().max(40)]);

export const TxDraftInput = z
  .object({
    kind: z.enum(["expense", "income"]),
    amountCents: zCents.optional(),
    /** valor em reais como o usuário escreveu ("3.600", "85,50") ou número */
    amount: zAmount.optional(),
    description: cleanText(160).optional(),
    categoryId: zId.optional(),
    categoryName: cleanText(60).optional(),
    date: zDate.optional(),
    status: z.enum(["paid", "pending"]).optional(),
    paymentMethod: z.enum(PAYMENT_METHODS).optional(),
    accountId: zId.optional(),
    installments: z.number().int().min(2).max(72).optional(),
    amountIsPerInstallment: z.boolean().optional(),
    recurrence: z.object({ endDate: zDate.nullable().optional(), autoPaid: z.boolean().default(false) }).optional(),
    notes: cleanText(500).optional(),
    /** texto original da mensagem — usado só pelo parser determinístico para conferir/completar */
    originalText: cleanText(500).optional(),
  })
  .strict()
  .refine((v) => !(v.installments && v.recurrence), "Escolha parcelamento OU recorrência, não os dois.")
  .refine((v) => !(v.installments && v.kind === "income"), "Parcelamento vale só para despesas.");

export type Warning = { code: string; message: string; details?: unknown };

export interface DraftView {
  id: string;
  version: number;
  kind: Pending["kind"];
  status: Pending["status"];
  expiresAt: Date;
  summary: string;
  data: unknown;
  warnings: Warning[];
  confirmationReasons: string[];
}

function amountFrom(input: { amountCents?: number; amount?: number | string }): number | null {
  if (input.amountCents) return input.amountCents;
  if (typeof input.amount === "number") return Math.round(input.amount * 100);
  if (typeof input.amount === "string") return parseMoneyToCents(input.amount);
  return null;
}

function resolveCategory(categories: CategoryLite[], kind: "income" | "expense", id?: number, name?: string): CategoryLite | null {
  if (id) {
    const c = categories.find((x) => x.id === id);
    if (!c || c.kind !== kind) throw badRequest("Categoria inválida para este tipo de lançamento.", { field: "categoryId" });
    return c;
  }
  if (name) {
    const n = normalize(name);
    return categories.find((c) => c.kind === kind && normalize(c.name) === n) ?? matchCategory(n, kind, categories);
  }
  return null;
}

async function accountName(q: Queryable, user: AuthUser, id: number | null) {
  const accounts = await listAccounts(q, user, [user.id]);
  return (id ? accounts.find((a) => a.id === id) : accounts.find((a) => a.isDefault))?.name ?? null;
}

/** Visão de um rascunho para o agente: dados + resumo pronto para mostrar. */
export async function draftView(q: Queryable, user: AuthUser, p: Pending, extra: { warnings?: Warning[]; reasons?: string[] } = {}): Promise<DraftView> {
  const pl = p.payload;
  let summary = "";
  let data: unknown = pl;
  if (pl.kind === "transaction") {
    const d = pl.draft;
    const cats = await listCategories(q);
    const cat = cats.find((c) => c.id === d.categoryId)?.name ?? "Sem categoria";
    const acc = await accountName(q, user, d.accountId);
    const label = d.kind === "income" ? "Receita" : "Despesa";
    const pm = d.paymentMethod ? ` · ${PAYMENT_LABELS[d.paymentMethod]}` : "";
    if (d.installments) {
      const parts = splitInstallments(d.amountCents, d.installments);
      summary = `${label} parcelada: ${d.description} — ${formatBRL(d.amountCents)} em ${d.installments}x de ${formatBRL(parts[1] ?? parts[0])}` +
        `${parts[0] !== parts[1] ? ` (1ª de ${formatBRL(parts[0])})` : ""} · ${cat}${pm} · 1ª parcela em ${d.date}`;
      const day = Number(d.date.slice(8, 10));
      const settings = await getCardSettings(q);
      data = {
        ...d,
        categoryName: cat,
        accountName: acc,
        plan: parts.map((cents, i) => {
          const date = addMonths(d.date, i, day);
          return {
            number: i + 1,
            date,
            amountCents: cents,
            invoiceMonth: d.paymentMethod === "credit_card" && settings.cycleConfigured ? invoiceMonthFor(date, settings.closingDay!) : null,
          };
        }),
      };
    } else {
      summary = `${label}: ${d.description} — ${formatBRL(d.amountCents)} · ${cat}${pm} · ${d.date} · ${d.status === "paid" ? (d.kind === "income" ? "recebida" : "paga") : "pendente"}` +
        `${d.recurrence ? " · repete todo mês" : ""}`;
      data = { ...d, categoryName: cat, accountName: acc };
    }
  } else if (pl.kind === "tx_update") {
    summary = `Alterar "${pl.update.description}": ${pl.update.fromLabel} → ${pl.update.toLabel}`;
  } else if (pl.kind === "tx_delete") {
    summary = `Excluir "${pl.del.description}" — ${formatBRL(pl.del.amountCents)} (${pl.del.date})`;
  } else if (pl.kind === "transfer") {
    const accounts = await listAccounts(q, user, [user.id]);
    const from = accounts.find((a) => a.id === pl.transfer.fromAccountId)?.name ?? "?";
    const to = accounts.find((a) => a.id === pl.transfer.toAccountId)?.name ?? "?";
    summary = `Transferência entre suas contas: ${from} → ${to} — ${formatBRL(pl.transfer.amountCents)} (${pl.transfer.date}). Não conta como receita nem despesa.`;
  } else if (pl.kind === "invoice_payment") {
    summary = `Marcar a fatura ${pl.invoice.invoiceMonth} como paga — ${formatBRL(pl.invoice.amountCents)} em ${pl.invoice.paidAt}. Não cria despesa nova.`;
  }
  return {
    id: p.id,
    version: p.version,
    kind: p.kind,
    status: p.status === "pending" && p.expiresAt < now() ? "expired" : p.status,
    expiresAt: p.expiresAt,
    summary,
    data,
    warnings: extra.warnings ?? [],
    confirmationReasons: extra.reasons ?? [],
  };
}

export type WriteOutcome =
  | { status: "pending_confirmation"; draft: DraftView }
  | { status: "committed"; draft: DraftView; result: unknown }
  | { status: "needs_info"; missing: string[]; message: string; partial?: unknown };

/** Rascunho idempotente: a mesma mensagem externa não gera dois rascunhos. */
async function newDraft(db: Db, user: AuthUser, payload: PendingPayload, externalRef: string | null) {
  if (externalRef) {
    const existing = await findPendingByRef(db, CHANNEL, user.id, externalRef);
    if (existing) return { pending: existing, replay: true };
  }
  try {
    return { pending: await createPending(db, user.id, 0, payload, { channel: CHANNEL, externalRef }), replay: false };
  } catch (err) {
    // corrida entre duas entregas da mesma mensagem: devolve o que venceu
    if ((err as { code?: string }).code === "23505" && externalRef) {
      const existing = await findPendingByRef(db, CHANNEL, user.id, externalRef);
      if (existing) return { pending: existing, replay: true };
    }
    throw err;
  }
}

/** Dados efetivamente gravados, para o agente confirmar ao usuário. */
export function persistedView(r: ExecResult) {
  switch (r.kind) {
    case "transaction":
      return { kind: "transaction", transactions: r.transactions.map(publicTx) };
    case "tx_update":
      return { kind: "transaction_updated", transaction: publicTx(r.transaction) };
    case "tx_delete":
      return { kind: "transaction_deleted", transactionId: r.deleted.txId, description: r.deleted.description, amountCents: r.deleted.amountCents };
    case "transfer":
      return { kind: "transfer", transfer: r.transfer };
    case "invoice_payment":
      return { kind: "invoice_payment", payment: r.payment };
    case "goal":
      return { kind: "goal", goal: r.goal };
    case "contribution":
      return { kind: "contribution", contributionId: r.contributionId, goal: r.goal };
  }
}

export function publicTx(t: TransactionRow) {
  return {
    id: t.id,
    kind: t.kind,
    amountCents: t.amountCents,
    description: t.description,
    categoryId: t.categoryId,
    categoryName: t.categoryName,
    date: t.date,
    status: t.status,
    paidAt: t.paidAt,
    accountId: t.accountId,
    accountName: t.accountName,
    paymentMethod: t.paymentMethod,
    installmentNumber: t.installmentNumber,
    installmentTotal: t.installmentTotal,
    recurrenceId: t.recurrenceId,
    source: t.source,
    overdue: t.overdue,
  };
}

async function finish(db: Db, user: AuthUser, pending: Pending, settings: IntegrationSettings, warnings: Warning[], reasons: string[], replay: boolean): Promise<WriteOutcome> {
  if (replay) {
    const view = await draftView(db, user, pending, { warnings, reasons });
    if (pending.status === "confirmed") return { status: "committed", draft: view, result: await resultOf(db, pending) };
    return { status: "pending_confirmation", draft: view };
  }
  if (settings.autoConfirm && reasons.length === 0) {
    const out = await confirmDraft(db, user, pending.id, pending.version);
    return { status: "committed", draft: await draftView(db, user, (await getPending(db, pending.id))!, { warnings }), result: out.result };
  }
  if (!settings.autoConfirm) reasons.unshift("confirmation_required");
  return { status: "pending_confirmation", draft: await draftView(db, user, pending, { warnings, reasons }) };
}

async function resultOf(q: Queryable, p: Pending) {
  if (p.kind === "transaction" && p.resultId) {
    const { rows } = await q.query<{ id: number }>(
      `SELECT t2.id FROM transactions t1 JOIN transactions t2 ON t2.id = t1.id OR (t1.installment_group IS NOT NULL AND t2.installment_group = t1.installment_group)
        WHERE t1.id = $1 ORDER BY t2.date, t2.id`,
      [p.resultId],
    );
    return { kind: "transaction", transactions: (await getTransactions(q, rows.map((r) => r.id))).map(publicTx) };
  }
  return { kind: p.kind, resultId: p.resultId };
}

// ------------------------------ lançamentos ------------------------------

export async function draftTransaction(db: Db, user: AuthUser, body: unknown, settings: IntegrationSettings, externalRef: string | null): Promise<WriteOutcome> {
  const input = parse(TxDraftInput, body);
  const t = today();
  const categories = await listCategories(db);
  const accounts = await listAccounts(db, user, [user.id]);
  const warnings: Warning[] = [];
  const reasons: string[] = [];

  // o parser determinístico confere (e completa) o que veio do agente
  const parsed = input.originalText ? parseEntry(input.originalText, categories, t, accounts) : null;
  const fromText = parsed?.type === "entry" ? parsed.draft : parsed?.type === "incomplete" ? parsed.partial : null;

  let amount = amountFrom(input);
  if (!amount && fromText?.amountCents) amount = fromText.amountCents;
  if (!amount) {
    return { status: "needs_info", missing: ["amount"], message: "Qual foi o valor? Não registro nada sem o valor informado pela pessoa." };
  }
  if (amount > MAX_CENTS) throw badRequest("Valor alto demais.");
  if (fromText?.amountCents && fromText.amountCents !== amount && !input.installments) {
    warnings.push({ code: "amount_mismatch", message: `O texto diz ${formatBRL(fromText.amountCents)}, mas a intenção trouxe ${formatBRL(amount)}. Confirme o valor.` });
    reasons.push("amount_mismatch");
  }
  if (fromText?.kind && fromText.kind !== input.kind) {
    warnings.push({ code: "kind_mismatch", message: `O texto parece ${fromText.kind === "income" ? "uma receita" : "uma despesa"}. Confirme o tipo.` });
    reasons.push("kind_mismatch");
  }

  const category = resolveCategory(categories, input.kind, input.categoryId, input.categoryName) ??
    (fromText?.categoryId ? categories.find((c) => c.id === fromText.categoryId) ?? null : null);
  if (!category) {
    warnings.push({ code: "no_category", message: "Sem categoria identificada — será salvo como 'Sem categoria' se confirmado." });
    reasons.push("no_category");
  }
  const description = input.description || fromText?.description || category?.name;
  if (!description) return { status: "needs_info", missing: ["description"], message: "Com o que foi esse lançamento?" };

  const date = input.date ?? fromText?.date ?? t;
  if (date > addDays(t, 366) || date < addDays(t, -366 * 2)) throw badRequest("Data fora do intervalo aceito.", { field: "date" });
  if (date !== t) reasons.push("date_not_today");
  const status = input.status ?? (input.recurrence || date > t ? "pending" : (fromText?.status ?? "paid"));
  const paymentMethod = input.paymentMethod ?? fromText?.paymentMethod ?? null;
  const accountId = input.accountId ?? fromText?.accountId ?? null;
  if (accountId && !accounts.some((a) => a.id === accountId)) throw badRequest("Conta não encontrada entre as suas.", { field: "accountId" });
  const installments = input.installments ?? (input.kind === "expense" ? (fromText?.installments ?? null) : null);
  const totalCents = installments && input.amountIsPerInstallment ? amount * installments : amount;

  if (paymentMethod === "credit_card" && input.kind === "expense") {
    const card = await memberCard(db, user.id);
    if (!card.registered) {
      warnings.push({ code: "card_not_registered", message: "Seu cartão ainda não está cadastrado no Luna (final do cartão). A compra entra como 'cartão de crédito' assim mesmo." });
      reasons.push("card_not_registered");
    }
    const cs = await getCardSettings(db);
    if (cs.cycleConfigured) {
      const m = invoiceMonthFor(date, cs.closingDay!);
      const cyc = invoiceCycle(m, cs.closingDay!, cs.dueDay!);
      warnings.push({ code: "invoice_info", message: `Entra na fatura de ${m} (vence em ${cyc.dueDate}).`, details: { invoiceMonth: m, dueDate: cyc.dueDate, last4: card.last4 } });
    }
  }
  if (installments) reasons.push("installments");
  if (input.recurrence) reasons.push("recurrence");

  const dup = await findPossibleDuplicate(db, user.id, input.kind, installments ? splitInstallments(totalCents, installments)[0] : totalCents, date);
  if (dup) {
    warnings.push({ code: "possible_duplicate", message: `Já existe "${dup.description}" com o mesmo valor em ${dup.date}.`, details: { transactionId: dup.id, date: dup.date, source: dup.source } });
    reasons.push("possible_duplicate");
  }

  const draft: Draft = {
    kind: input.kind,
    amountCents: totalCents,
    description: description.slice(0, 160),
    categoryId: category?.id ?? null,
    date,
    status,
    installments,
    paymentMethod,
    accountId,
    amountText: fromText?.amountText ?? String(input.amount ?? (amount / 100).toFixed(2)),
    recurrence: input.recurrence ? { endDate: input.recurrence.endDate ?? null, autoPaid: input.recurrence.autoPaid } : null,
    notes: input.notes ?? null,
    externalRef,
  };
  const settingsNow = settings;
  const { pending, replay } = await newDraft(db, user, { kind: "transaction", draft }, externalRef);
  return finish(db, user, pending, settingsNow, warnings, reasons, replay);
}

// ------------------------------ correção e exclusão ------------------------------

const Target = z.union([
  z.object({ transactionId: zId }).strict(),
  z.object({ last: z.enum(["expense", "income", "any"]) }).strict(),
]);

async function resolveTarget(q: Queryable, user: AuthUser, target: z.infer<typeof Target>) {
  let id: number | null = null;
  if ("transactionId" in target) id = target.transactionId;
  else {
    const { rows } = await q.query<{ id: number }>(
      `SELECT id FROM transactions WHERE deleted_at IS NULL AND user_id = $1 AND ($2 = 'any' OR kind = $2)
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [user.id, target.last],
    );
    id = rows[0]?.id ?? null;
  }
  if (!id) throw notFound("Não encontrei esse lançamento.");
  const [tx] = await getTransactions(q, [id]);
  // só a própria pessoa corrige/exclui o que é dela (mesma regra do site)
  if (!tx || tx.userId !== user.id) throw notFound("Não encontrei esse lançamento entre os seus.");
  return tx;
}

const CorrectionInput = z
  .object({
    target: Target,
    changes: z
      .object({
        amountCents: zCents.optional(),
        amount: zAmount.optional(),
        description: cleanText(160).optional(),
        date: zDate.optional(),
        categoryId: zId.optional(),
        categoryName: cleanText(60).optional(),
        paymentMethod: z.enum(PAYMENT_METHODS).optional(),
        status: z.enum(["paid", "pending"]).optional(),
      })
      .strict(),
  })
  .strict();

export async function draftCorrection(db: Db, user: AuthUser, body: unknown, settings: IntegrationSettings, externalRef: string | null): Promise<WriteOutcome> {
  const input = parse(CorrectionInput, body);
  const tx = await resolveTarget(db, user, input.target);
  const c = input.changes;
  const patch: Record<string, unknown> = {};
  const from: string[] = [];
  const to: string[] = [];
  const amount = amountFrom(c);
  if (amount) {
    patch.amountCents = amount;
    from.push(formatBRL(tx.amountCents));
    to.push(formatBRL(amount));
  }
  if (c.description) {
    patch.description = c.description;
    from.push(tx.description);
    to.push(c.description);
  }
  if (c.date) {
    patch.date = c.date;
    from.push(tx.date);
    to.push(c.date);
  }
  if (c.categoryId || c.categoryName) {
    const cat = resolveCategory(await listCategories(db), tx.kind, c.categoryId, c.categoryName);
    if (!cat) return { status: "needs_info", missing: ["category"], message: "Não encontrei essa categoria. Qual delas?" };
    patch.categoryId = cat.id;
    from.push(tx.categoryName ?? "Sem categoria");
    to.push(cat.name);
  }
  if (c.paymentMethod) {
    patch.paymentMethod = c.paymentMethod;
    from.push(tx.paymentMethod ? PAYMENT_LABELS[tx.paymentMethod] : "sem forma de pagamento");
    to.push(PAYMENT_LABELS[c.paymentMethod]);
  }
  if (c.status) {
    patch.status = c.status;
    from.push(tx.status === "paid" ? "pago" : "pendente");
    to.push(c.status === "paid" ? "pago" : "pendente");
  }
  if (!Object.keys(patch).length) return { status: "needs_info", missing: ["changes"], message: "O que você quer corrigir?" };
  const field = patch.amountCents ? "amount" : patch.description ? "description" : patch.date ? "date" : "category";
  const { pending, replay } = await newDraft(
    db,
    user,
    { kind: "tx_update", update: { txId: tx.id, description: tx.description, field, fromLabel: from.join(", "), toLabel: to.join(", "), patch } },
    externalRef,
  );
  // correção SEMPRE pede confirmação, mesmo com confirmação automática ligada
  return finish(db, user, pending, { ...settings, autoConfirm: false }, [], ["correction"], replay);
}

const DeletionInput = z.object({ target: Target }).strict();

export async function draftDeletion(db: Db, user: AuthUser, body: unknown, settings: IntegrationSettings, externalRef: string | null): Promise<WriteOutcome> {
  const input = parse(DeletionInput, body);
  const tx = await resolveTarget(db, user, input.target);
  const warnings: Warning[] = tx.installmentGroup
    ? [{ code: "installment", message: `É a parcela ${tx.installmentNumber}/${tx.installmentTotal}; só esta parcela será excluída.` }]
    : [];
  const { pending, replay } = await newDraft(
    db,
    user,
    { kind: "tx_delete", del: { txId: tx.id, description: tx.description, amountCents: tx.amountCents, date: tx.date, kind: tx.kind } },
    externalRef,
  );
  return finish(db, user, pending, { ...settings, autoConfirm: false }, warnings, ["deletion"], replay);
}

// ------------------------------ transferência ------------------------------

const TransferDraftInput = z
  .object({
    amountCents: zCents.optional(),
    amount: zAmount.optional(),
    fromAccountId: zId.optional(),
    fromAccountName: cleanText(60).optional(),
    toAccountId: zId.optional(),
    toAccountName: cleanText(60).optional(),
    date: zDate.optional(),
  })
  .strict();

export async function draftTransfer(db: Db, user: AuthUser, body: unknown, settings: IntegrationSettings, externalRef: string | null): Promise<WriteOutcome> {
  const input = parse(TransferDraftInput, body);
  const accounts = await listAccounts(db, user, [user.id]);
  const find = (id?: number, name?: string) =>
    id ? (accounts.find((a) => a.id === id) ?? null) : name ? (accounts.find((a) => normalize(a.name) === normalize(name)) ?? accounts.find((a) => normalize(a.name).includes(normalize(name))) ?? null) : null;
  const from = find(input.fromAccountId, input.fromAccountName);
  const to = find(input.toAccountId, input.toAccountName);
  const amount = amountFrom(input);
  const missing = [...(!amount ? ["amount"] : []), ...(!from ? ["fromAccount"] : []), ...(!to ? ["toAccount"] : [])];
  if (missing.length) {
    return { status: "needs_info", missing, message: "Preciso do valor e das duas contas (origem e destino).", partial: { accounts: accounts.map((a) => ({ id: a.id, name: a.name })) } };
  }
  if (from!.id === to!.id) throw badRequest("Origem e destino precisam ser contas diferentes.");
  const { pending, replay } = await newDraft(
    db,
    user,
    { kind: "transfer", transfer: { amountCents: amount!, fromAccountId: from!.id, toAccountId: to!.id, date: input.date ?? today() } },
    externalRef,
  );
  return finish(db, user, pending, settings, [], ["transfer"], replay);
}

// ------------------------------ pagamento da fatura ------------------------------

const InvoicePayDraft = z
  .object({ invoiceMonth: z.string().regex(/^\d{4}-\d{2}$/).optional(), amountCents: zCents.optional(), amount: zAmount.optional(), paidAt: zDate.optional() })
  .strict();

export async function draftInvoicePayment(db: Db, user: AuthUser, body: unknown, settings: IntegrationSettings, externalRef: string | null): Promise<WriteOutcome> {
  const input = parse(InvoicePayDraft, body);
  const cs = await getCardSettings(db);
  if (cs.holderUserId !== user.id) throw forbidden("Somente o titular da fatura pode marcá-la como paga.");
  if (!cs.cycleConfigured) return { status: "needs_info", missing: ["cardSettings"], message: "Cadastre o dia de fechamento e de vencimento da fatura no site antes." };
  const month = input.invoiceMonth ?? invoiceMonthFor(addDays(today(), -1), cs.closingDay!);
  const inv = await invoiceSummary(db, user, month);
  const amount = amountFrom(input) ?? (inv.cycleConfigured ? inv.totalCents : null);
  if (!amount) return { status: "needs_info", missing: ["amount"], message: "Qual valor foi pago?" };
  const { pending, replay } = await newDraft(db, user, { kind: "invoice_payment", invoice: { invoiceMonth: month, amountCents: amount, paidAt: input.paidAt ?? today() } }, externalRef);
  const warnings: Warning[] = [{ code: "no_double_count", message: "Pagar a fatura não cria despesa: as compras já foram contadas uma vez." }];
  return finish(db, user, pending, { ...settings, autoConfirm: false }, warnings, ["invoice_payment"], replay);
}

// ------------------------------ confirmar / cancelar ------------------------------

/**
 * Confirmação atômica (trava + gravação na mesma transação). Duas confirmações
 * simultâneas: só uma grava; a outra recebe 409. Repetir a confirmação de um
 * rascunho já confirmado devolve o resultado gravado (retentativa segura).
 */
export async function confirmDraft(db: Db, user: AuthUser, id: string, version: number) {
  const before = await getPending(db, id);
  if (before && before.userId === user.id && before.channel === CHANNEL && before.status === "confirmed" && before.version === version) {
    return { status: "committed" as const, replayed: true, result: await resultOf(db, before) };
  }
  const out = await confirmPending(
    db,
    id,
    user.id,
    version,
    async (q, locked) => {
      const { resultId, result } = await executePending(q, user, locked.payload, "whatsapp");
      return { resultId, value: persistedView(result) };
    },
    CHANNEL,
  );
  if (!out.ok) {
    const p = await getPending(db, id);
    const code = !p || p.userId !== user.id || p.channel !== CHANNEL ? "draft_not_found" : p.status === "confirmed" ? "already_confirmed" : p.status === "cancelled" ? "draft_cancelled" : p.expiresAt < now() || p.status === "expired" ? "draft_expired" : "version_mismatch";
    throw new HttpError(code === "draft_not_found" ? 404 : 409, out.reason, code, p && p.userId === user.id ? { currentVersion: p.version } : undefined);
  }
  return { status: "committed" as const, replayed: false, result: out.value };
}

export async function cancelDraft(db: Db, user: AuthUser, id: string) {
  const ok = await cancelPending(db, id, user.id, CHANNEL);
  if (!ok) {
    const p = await getPending(db, id);
    throw new HttpError(p && p.userId === user.id && p.channel === CHANNEL ? 409 : 404, pendingProblem(p, user.id, undefined, CHANNEL) ?? "Rascunho não disponível.", "draft_not_pending");
  }
  return { status: "cancelled" as const };
}

export async function getDraft(db: Db, user: AuthUser, id: string) {
  const p = await getPending(db, id);
  if (!p || p.userId !== user.id || p.channel !== CHANNEL) throw notFound("Rascunho não encontrado.");
  return draftView(db, user, p);
}

export const DRAFT_TTL_MIN = PENDING_TTL_MIN;
export { conflict, TX_SELECT };
