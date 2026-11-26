/**
 * Cartões da família e fatura única consolidada.
 *
 * Estrutura real da família: 4 cartões individuais (Itaú Personnalité LATAM
 * Pass Visa Infinite), uma única fatura no nome do titular (Luís Carlos) e um
 * limite compartilhado. O sistema guarda só o que a família configura:
 *   - card_settings: titular, dia de fechamento, dia de vencimento, limite (opcionais)
 *   - users.card_last4: final do cartão de cada pessoa ("cartão cadastrado")
 *   - card_invoice_payments: fatura marcada como paga
 * Tudo o mais sai dos lançamentos com forma de pagamento "cartão de crédito".
 *
 * Ciclo da fatura (convenção usada aqui, documentada para a família conferir):
 *   a fatura do mês M fecha no dia de fechamento de M e inclui as compras de
 *   [fechamento de M−1, fechamento de M) — compra feita no dia do fechamento
 *   já cai na fatura seguinte. Vencimento: dia de vencimento de M se for depois
 *   do fechamento, senão no mês seguinte.
 * Pagar a fatura NÃO cria despesa: cada compra já foi contada uma vez.
 */
import { z } from "zod";
import type { Db, Queryable } from "../db/index.js";
import { addDays, currentMonth, isYearMonth, makeDate, monthRange, shiftMonth, today } from "../lib/clock.js";
import { badRequest, forbidden } from "../lib/errors.js";
import { parse, zCents, zDate, zId } from "../lib/validate.js";
import { assertCanManageFamily, canSeeDetailsOf, type AuthUser } from "./access.js";
import { audit, type Source } from "./audit.js";
import { listMembers } from "./members.js";

export interface CardSettings {
  productName: string;
  holderUserId: number | null;
  closingDay: number | null;
  dueDay: number | null;
  limitCents: number | null;
  /** Ciclo de fatura só existe com fechamento e vencimento cadastrados. */
  cycleConfigured: boolean;
}

export async function getCardSettings(q: Queryable): Promise<CardSettings> {
  const { rows } = await q.query<{ product_name: string; holder_user_id: number | null; closing_day: number | null; due_day: number | null; limit_cents: number | null }>(
    "SELECT product_name, holder_user_id, closing_day, due_day, limit_cents FROM card_settings WHERE id = 1",
  );
  const r = rows[0];
  return {
    productName: r?.product_name ?? "Itaú Personnalité LATAM Pass Visa Infinite",
    holderUserId: r?.holder_user_id ?? null,
    closingDay: r?.closing_day ?? null,
    dueDay: r?.due_day ?? null,
    limitCents: r?.limit_cents ?? null,
    cycleConfigured: Boolean(r?.closing_day && r?.due_day),
  };
}

const SettingsInput = z.object({
  holderUserId: zId.nullable().optional(),
  closingDay: z.number().int().min(1).max(28, "Use um dia de 1 a 28.").nullable().optional(),
  dueDay: z.number().int().min(1).max(28, "Use um dia de 1 a 28.").nullable().optional(),
  limitCents: zCents.nullable().optional(),
});

export async function updateCardSettings(db: Db, actor: AuthUser, body: unknown) {
  assertCanManageFamily(actor);
  const input = parse(SettingsInput, body);
  if (input.holderUserId) {
    const { rows } = await db.query("SELECT 1 FROM users WHERE id = $1 AND active", [input.holderUserId]);
    if (!rows[0]) throw badRequest("Titular inválido.");
  }
  const sets: string[] = [];
  const vals: unknown[] = [];
  const put = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (input.holderUserId !== undefined) put("holder_user_id", input.holderUserId);
  if (input.closingDay !== undefined) put("closing_day", input.closingDay);
  if (input.dueDay !== undefined) put("due_day", input.dueDay);
  if (input.limitCents !== undefined) put("limit_cents", input.limitCents);
  if (sets.length) {
    vals.push(actor.id);
    await db.query(`UPDATE card_settings SET ${sets.join(", ")}, updated_by = $${vals.length}, updated_at = now() WHERE id = 1`, vals);
    await audit(db, { userId: actor.id, action: "cards.settings", entity: "card_settings", entityId: 1, details: { fields: Object.keys(input) } });
  }
  return getCardSettings(db);
}

// ------------------------------ ciclo ------------------------------

/** Fatura (AAAA-MM) em que cai uma compra feita em `date`. */
export function invoiceMonthFor(date: string, closingDay: number): string {
  const ym = date.slice(0, 7);
  return Number(date.slice(8, 10)) >= closingDay ? shiftMonth(ym, 1) : ym;
}

export function invoiceCycle(invoiceMonth: string, closingDay: number, dueDay: number) {
  const [y, m] = invoiceMonth.split("-").map(Number);
  const prev = shiftMonth(invoiceMonth, -1).split("-").map(Number);
  const closeDate = makeDate(y, m, closingDay);
  const dueBase = dueDay > closingDay ? invoiceMonth : shiftMonth(invoiceMonth, 1);
  const [dy, dm] = dueBase.split("-").map(Number);
  return {
    invoiceMonth,
    /** primeira data de compra incluída */
    from: makeDate(prev[0], prev[1], closingDay),
    /** última data de compra incluída */
    to: addDays(closeDate, -1),
    closingDate: closeDate,
    dueDate: makeDate(dy, dm, dueDay),
  };
}

// ------------------------------ cartões ------------------------------

const familyVisible = (viewer: AuthUser) => viewer.family_access !== "none";

/** Cartões cadastrados (pessoa com final do cartão). Nenhum limite ou saldo por cartão: não existe. */
export async function listCards(q: Queryable, viewer: AuthUser) {
  const settings = await getCardSettings(q);
  const members = await listMembers(q);
  const { rows } = await q.query<{ id: number; last4: string | null }>("SELECT id, card_last4 AS last4 FROM users WHERE active");
  const last4 = new Map(rows.map((r) => [r.id, r.last4]));
  return {
    productName: settings.productName,
    holderUserId: settings.holderUserId,
    cards: members
      .filter((m) => m.id === viewer.id || familyVisible(viewer))
      .map((m) => ({ userId: m.id, name: m.name, last4: last4.get(m.id) ?? null, registered: Boolean(last4.get(m.id)), isHolder: m.id === settings.holderUserId })),
  };
}

export async function memberCard(q: Queryable, userId: number) {
  const { rows } = await q.query<{ last4: string | null }>("SELECT card_last4 AS last4 FROM users WHERE id = $1", [userId]);
  return { last4: rows[0]?.last4 ?? null, registered: Boolean(rows[0]?.last4) };
}

async function cardSpend(q: Queryable, from: string, to: string) {
  const { rows } = await q.query<{ userId: number; cents: number; n: number; inst: number }>(
    `SELECT user_id AS "userId", COALESCE(sum(amount_cents),0)::bigint AS cents, count(*)::int AS n,
            COALESCE(sum(amount_cents) FILTER (WHERE installment_group IS NOT NULL),0)::bigint AS inst
       FROM transactions
      WHERE deleted_at IS NULL AND kind = 'expense' AND payment_method = 'credit_card' AND date BETWEEN $1 AND $2
      GROUP BY user_id`,
    [from, to],
  );
  return rows;
}

async function invoicePayment(q: Queryable, invoiceMonth: string) {
  const { rows } = await q.query<{ amountCents: number; paidAt: string; paidBy: number }>(
    `SELECT amount_cents AS "amountCents", paid_at AS "paidAt", paid_by AS "paidBy" FROM card_invoice_payments WHERE invoice_month = $1`,
    [invoiceMonth],
  );
  return rows[0] ?? null;
}

/**
 * Fatura consolidada de um mês (padrão: a fatura aberta hoje). Quem não tem
 * acesso à família vê só a própria parte. Sem fechamento/vencimento
 * cadastrados, devolve `cycleConfigured: false` e os gastos do mês calendário.
 */
export async function invoiceSummary(q: Queryable, viewer: AuthUser, invoiceMonth?: string) {
  const settings = await getCardSettings(q);
  const members = await listMembers(q);
  const names = new Map(members.map((m) => [m.id, m.name]));
  const showAll = familyVisible(viewer) || viewer.id === settings.holderUserId;
  const pick = <T extends { userId: number }>(rows: T[]) => rows.filter((r) => showAll || r.userId === viewer.id);

  if (!settings.cycleConfigured) {
    const ym = invoiceMonth && isYearMonth(invoiceMonth) ? invoiceMonth : currentMonth();
    const { start, end } = monthRange(ym);
    const rows = pick(await cardSpend(q, start, end));
    return {
      cycleConfigured: false as const,
      message: "Dia de fechamento e de vencimento da fatura ainda não cadastrados. Mostrando compras no cartão do mês calendário.",
      holderUserId: settings.holderUserId,
      calendarMonth: { month: ym, from: start, to: end, totalCents: showAll ? rows.reduce((s, r) => s + r.cents, 0) : null },
      perMember: rows.map((r) => ({ userId: r.userId, name: names.get(r.userId) ?? "", cents: r.cents, count: r.n })),
    };
  }

  const closing = settings.closingDay!;
  const month = invoiceMonth && isYearMonth(invoiceMonth) ? invoiceMonth : invoiceMonthFor(today(), closing);
  const cycle = invoiceCycle(month, closing, settings.dueDay!);
  const rows = pick(await cardSpend(q, cycle.from, cycle.to));
  const cal = monthRange(month);
  const calRows = pick(await cardSpend(q, cal.start, cal.end));
  const payment = await invoicePayment(q, month);
  const t = today();
  const status = payment ? "paid" : t < cycle.closingDate ? "open" : t > cycle.dueDate ? "overdue" : "closed";
  const total = rows.reduce((s, r) => s + r.cents, 0);
  return {
    cycleConfigured: true as const,
    holderUserId: settings.holderUserId,
    holderName: settings.holderUserId ? (names.get(settings.holderUserId) ?? null) : null,
    ...cycle,
    status,
    totalCents: showAll ? total : null,
    installmentsCents: showAll ? rows.reduce((s, r) => s + r.inst, 0) : null,
    perMember: rows.map((r) => ({ userId: r.userId, name: names.get(r.userId) ?? "", cents: r.cents, count: r.n })),
    calendarMonth: { month, from: cal.start, to: cal.end, totalCents: showAll ? calRows.reduce((s, r) => s + r.cents, 0) : null },
    payment: showAll ? payment : null,
  };
}

/**
 * Limite compartilhado. Sem limite cadastrado → null (nada é estimado).
 * Comprometido = compras no cartão da fatura aberta em diante (inclui parcelas
 * futuras) + a fatura anterior, se ainda não marcada como paga.
 */
export async function limitStatus(q: Queryable, viewer: AuthUser) {
  const settings = await getCardSettings(q);
  if (!settings.limitCents || !settings.cycleConfigured) {
    return { configured: false as const, message: "Limite ou ciclo da fatura não cadastrado." };
  }
  if (!familyVisible(viewer) && viewer.id !== settings.holderUserId) {
    return { configured: true as const, visible: false as const, message: "O limite é compartilhado pela família; sua conta só vê os próprios dados." };
  }
  const open = invoiceMonthFor(today(), settings.closingDay!);
  const prev = shiftMonth(open, -1);
  const prevPaid = Boolean(await invoicePayment(q, prev));
  const start = invoiceCycle(prevPaid ? open : prev, settings.closingDay!, settings.dueDay!).from;
  const { rows } = await q.query<{ cents: number }>(
    `SELECT COALESCE(sum(amount_cents),0)::bigint AS cents FROM transactions
      WHERE deleted_at IS NULL AND kind = 'expense' AND payment_method = 'credit_card' AND date >= $1`,
    [start],
  );
  const committed = rows[0].cents;
  return {
    configured: true as const,
    visible: true as const,
    limitCents: settings.limitCents,
    committedCents: committed,
    availableCents: settings.limitCents - committed,
    percentUsed: Math.round((committed / settings.limitCents) * 1000) / 10,
    countedFrom: start,
    note: "Calculado só com os lançamentos registrados no Luna; não inclui compras que não foram lançadas.",
  };
}

// ------------------------------ pagamento da fatura ------------------------------

export const InvoicePaymentInput = z.object({
  invoiceMonth: z.string().refine((s) => isYearMonth(s), "Mês da fatura inválido (AAAA-MM)."),
  amountCents: zCents,
  paidAt: zDate,
});

/** Só o titular da fatura marca como paga. Não cria despesa (evita dupla contagem). */
export async function recordInvoicePaymentWith(q: Queryable, user: AuthUser, body: unknown, source: Source = "web") {
  const input = parse(InvoicePaymentInput, body);
  const settings = await getCardSettings(q);
  if (settings.holderUserId !== user.id) throw forbidden("Somente o titular da fatura pode marcá-la como paga.");
  if (input.paidAt > today()) throw badRequest("A data do pagamento não pode estar no futuro.");
  const { rows } = await q.query<{ id: number }>(
    `INSERT INTO card_invoice_payments (invoice_month, amount_cents, paid_at, paid_by, source) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (invoice_month) DO NOTHING RETURNING id`,
    [input.invoiceMonth, input.amountCents, input.paidAt, user.id, source === "whatsapp" ? "whatsapp" : "web"],
  );
  if (!rows[0]) throw badRequest("Esta fatura já está marcada como paga.");
  await audit(q, { userId: user.id, action: "invoice.paid", entity: "card_invoice", entityId: rows[0].id, source, details: { invoiceMonth: input.invoiceMonth } });
  return { id: rows[0].id, ...input, note: "Fatura marcada como paga. Nenhuma despesa nova foi criada: as compras já estavam lançadas." };
}

export function canSeeCardOf(viewer: AuthUser, ownerId: number) {
  return viewer.id === ownerId || familyVisible(viewer);
}
export { canSeeDetailsOf };
