/**
 * Consultas para o agente — reaproveitam as mesmas funções do painel e do bot
 * do Telegram, sempre no escopo da pessoa da sessão e das permissões dela
 * (family_access). Nenhum SQL livre, nenhum dado de quem não pode ser visto.
 */
import { z } from "zod";
import type { Queryable } from "../../db/index.js";
import { addDays, currentMonth, isYearMonth, monthRange, shiftMonth, today } from "../../lib/clock.js";
import { badRequest } from "../../lib/errors.js";
import { parse, zDate } from "../../lib/validate.js";
import { resolveScope, type AuthUser, type ViewRequest } from "../../services/access.js";
import { listAccounts, totalBalance } from "../../services/accounts.js";
import { budgetStatus } from "../../services/budgets.js";
import { getCardSettings, invoiceSummary, limitStatus, listCards, memberCard } from "../../services/cards.js";
import { listCategories } from "../../services/categories.js";
import { report } from "../../services/insights.js";
import { listMembers } from "../../services/members.js";
import { listTransactions, PAYMENT_LABELS, PAYMENT_METHODS } from "../../services/transactions.js";
import { wallet } from "../../services/wallet.js";
import { getCategoryBreakdown, getGoals, getPendingBills, getPeriodTotals, getSpendable } from "../../telegram/data.js";
import { interpret, type NluContext } from "../../telegram/nlu.js";
import { publicTx } from "./operations.js";

const RELATION: Record<string, string> = { luis: "Pai", luciana: "Mãe", lipe: "Filho 1", joao: "Filho 2" };
const first = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase().split(/\s+/)[0] ?? "";

/** Escopo pedido pelo agente: "me", "family" ou o id de outra pessoa (sujeito às permissões). */
export const zScope = z.union([z.literal("me"), z.literal("family"), z.coerce.number().int().positive()]).default("me");

export function periodFrom(input: { period?: string; from?: string; to?: string; month?: string }) {
  const t = today();
  if (input.from || input.to) {
    if (!input.from || !input.to || input.from > input.to) throw badRequest("Período inválido (from/to).");
    return { from: input.from, to: input.to, label: `${input.from} a ${input.to}` };
  }
  const month = input.month ?? (input.period && isYearMonth(input.period) ? input.period : undefined);
  if (month) {
    const r = monthRange(month);
    return { from: r.start, to: r.end, label: month };
  }
  switch (input.period ?? "this_month") {
    case "today":
      return { from: t, to: t, label: "hoje" };
    case "this_week": {
      const d = new Date(`${t}T12:00:00Z`);
      const monday = addDays(t, -((d.getUTCDay() + 6) % 7));
      return { from: monday, to: t, label: "esta semana" };
    }
    case "last_month": {
      const r = monthRange(shiftMonth(currentMonth(), -1));
      return { from: r.start, to: r.end, label: "mês passado" };
    }
    case "last_30_days":
      return { from: addDays(t, -29), to: t, label: "últimos 30 dias" };
    case "this_year":
      return { from: `${t.slice(0, 4)}-01-01`, to: t, label: "este ano" };
    case "this_month": {
      const r = monthRange(currentMonth());
      return { from: r.start, to: r.end, label: "este mês" };
    }
    default:
      throw badRequest("Período inválido. Use today, this_week, this_month, last_month, last_30_days, this_year, AAAA-MM ou from/to.");
  }
}

const PeriodQuery = z.object({
  scope: zScope,
  period: z.string().max(20).optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  from: zDate.optional(),
  to: zDate.optional(),
});

export async function me(q: Queryable, user: AuthUser) {
  const card = await memberCard(q, user.id);
  const settings = await getCardSettings(q);
  return {
    userId: user.id,
    name: user.name,
    relation: RELATION[first(user.name)] ?? null,
    familyAccess: user.family_access,
    card: { ...card, isInvoiceHolder: settings.holderUserId === user.id },
    timezone: "America/Sao_Paulo",
    today: today(),
  };
}

export async function catalog(q: Queryable, user: AuthUser) {
  const categories = await listCategories(q);
  const accounts = await listAccounts(q, user, [user.id]);
  const members = user.family_access === "none" ? [] : (await listMembers(q)).map((m) => ({ userId: m.id, name: m.name, relation: RELATION[first(m.name)] ?? null }));
  return {
    categories: categories.map((c) => ({ id: c.id, name: c.name, kind: c.kind })),
    accounts: accounts.map((a) => ({ id: a.id, name: a.name, type: a.type, isDefault: a.isDefault })),
    paymentMethods: PAYMENT_METHODS.map((m) => ({ id: m, label: PAYMENT_LABELS[m] })),
    members,
  };
}

export async function balance(q: Queryable, user: AuthUser, query: unknown) {
  const { scope } = parse(z.object({ scope: zScope }), query);
  const s = await resolveScope(q, user, scope as ViewRequest);
  const own = s.userIds.length === 1 && s.userIds[0] === user.id;
  const accounts = s.detail ? await listAccounts(q, user, s.userIds) : [];
  return {
    scope: s.isFamily ? "family" : own ? "me" : s.userIds[0],
    totalCents: await totalBalance(q, s.userIds),
    accounts: own || s.detail ? accounts.map((a) => ({ name: a.name, ownerId: a.ownerId, balanceCents: a.balanceCents })) : [],
    note: "Saldo registrado: considera só lançamentos conhecidos pelo Luna.",
  };
}

export async function summary(q: Queryable, user: AuthUser, query: unknown) {
  const input = parse(PeriodQuery, query);
  const s = await resolveScope(q, user, input.scope as ViewRequest);
  const p = periodFrom(input);
  const totals = await getPeriodTotals(q, s.userIds, p.from, p.to);
  const expenseByCategory = (await getCategoryBreakdown(q, s.userIds, p.from, p.to, "expense")).slice(0, 10);
  const incomeByCategory = (await getCategoryBreakdown(q, s.userIds, p.from, p.to, "income")).slice(0, 10);
  return { scope: s.isFamily ? "family" : s.userIds[0] === user.id ? "me" : s.userIds[0], period: p, ...totals, expenseByCategory, incomeByCategory };
}

const ListQuery = PeriodQuery.extend({
  kind: z.enum(["income", "expense"]).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  q: z.string().max(80).optional(),
});

export async function transactions(q: Queryable, user: AuthUser, query: unknown) {
  const input = parse(ListQuery, query);
  const p = periodFrom(input);
  const r = await listTransactions(q, user, input.scope as ViewRequest, {
    from: p.from, to: p.to, kind: input.kind, q: input.q, page: 1, pageSize: input.limit, sort: "date_desc",
  });
  return { period: p, total: r.total, items: r.items.map((t) => ({ ...publicTx(t), userId: t.userId })) };
}

export async function spendable(q: Queryable, user: AuthUser) {
  const s = await getSpendable(q, user);
  const budgets = (await budgetStatus(q, user)).filter((b) => b.scope === "family" || b.ownerId === user.id);
  const limit = await limitStatus(q, user);
  return {
    ...s,
    budgets: budgets.map((b) => ({ id: b.id, scope: b.scope, categoryName: b.categoryName, amountCents: b.amountCents, spentCents: b.spentCents, remainingCents: b.remainingCents, percent: b.percent, level: b.level })),
    cardLimit: limit,
    explanation: "Disponível = saldo registrado − contas pendentes até o fim do mês + receitas pendentes até o fim do mês. Orçamentos mostram quanto ainda cabe em cada limite mensal.",
  };
}

export async function cards(q: Queryable, user: AuthUser) {
  return {
    ...(await listCards(q, user)),
    currentInvoice: await invoiceSummary(q, user),
    limit: await limitStatus(q, user),
    monthByMember: (await wallet(q, user)).cards.map((c) => ({ userId: c.userId, name: c.name, relation: c.relation, last4: c.last4, monthExpenseCents: c.expenseCents, monthCardCents: c.cardCents })),
  };
}

export async function invoice(q: Queryable, user: AuthUser, query: unknown) {
  const { month } = parse(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() }), query);
  return invoiceSummary(q, user, month);
}

export async function budgets(q: Queryable, user: AuthUser, query: unknown) {
  const { month } = parse(z.object({ month: z.string().regex(/^\d{4}-\d{2}$/).optional() }), query);
  return { month: month ?? currentMonth(), items: await budgetStatus(q, user, month) };
}

export async function goals(q: Queryable, user: AuthUser) {
  return { items: await getGoals(q, user) };
}

export async function bills(q: Queryable, user: AuthUser, query: unknown) {
  const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(60).default(15) }), query);
  return getPendingBills(q, user.id, days);
}

export async function reports(q: Queryable, user: AuthUser, query: unknown) {
  const input = parse(z.object({ scope: zScope, month: z.string().regex(/^\d{4}-\d{2}$/).optional(), year: z.string().regex(/^\d{4}$/).optional() }), query);
  return report(q, user, input.scope as ViewRequest, { month: input.month, year: input.year });
}

/**
 * Interpretação determinística (sem IA) de uma frase — opcional para o agente
 * conferir o que entendeu. NÃO grava nada.
 */
export async function interpretText(q: Queryable, user: AuthUser, body: unknown) {
  const { text } = parse(z.object({ text: z.string().min(1).max(500) }).strict(), body);
  const ctx: NluContext = {
    categories: await listCategories(q),
    accounts: (await listAccounts(q, user, [user.id])).map((a) => ({ id: a.id, name: a.name })),
    goals: (await getGoals(q, user)).map((g) => ({ id: g.id, name: g.name })),
    today: today(),
  };
  const intent = interpret(text, ctx);
  switch (intent.type) {
    case "entry":
      return {
        type: "transaction",
        suggested: {
          kind: intent.draft.kind, amountCents: intent.draft.amountCents, description: intent.draft.description, categoryId: intent.draft.categoryId,
          date: intent.draft.date, status: intent.draft.status, paymentMethod: intent.draft.paymentMethod, installments: intent.draft.installments,
          accountId: intent.draft.accountId, originalText: text,
        },
        nextStep: "POST /drafts/transactions com estes campos",
      };
    case "incomplete":
      return { type: "incomplete", missing: intent.missing, partial: intent.partial };
    case "query":
      return { type: "query", query: intent.query };
    case "manage_last":
      return { type: intent.action === "edit" ? "correction" : "deletion", target: { last: intent.kind ?? "any" } };
    case "transfer":
      return { type: "transfer", suggested: { amountCents: intent.amountCents, fromAccountId: intent.fromAccountId, toAccountId: intent.toAccountId, date: intent.date } };
    default:
      return { type: intent.type };
  }
}
