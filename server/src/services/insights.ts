/**
 * Painel e relatórios. Todos os números saem de consultas SQL agregadas no
 * banco — nada é estimado ou "inventado" (inclusive quando o bot/IA responde).
 */
import type { Queryable } from "../db/index.js";
import { addDays, currentMonth, isYearMonth, monthRange, shiftMonth, today } from "../lib/clock.js";
import { badRequest } from "../lib/errors.js";
import { canSeeDetailsOf, resolveScope, type AuthUser, type ViewRequest } from "./access.js";
import { listAccounts, totalBalance } from "./accounts.js";
import { listGoals } from "./goals.js";
import { listMembers } from "./members.js";
import { PAYMENT_LABELS, TX_SELECT, type TransactionRow } from "./transactions.js";

const ACTIVE = "t.deleted_at IS NULL";

export interface MonthTotals {
  incomePaidCents: number;
  incomeTotalCents: number;
  expensePaidCents: number;
  expenseTotalCents: number;
}

export async function monthTotals(q: Queryable, userIds: number[], ym: string): Promise<MonthTotals> {
  const { start, end } = monthRange(ym);
  const { rows } = await q.query<MonthTotals>(
    `SELECT
       COALESCE(sum(amount_cents) FILTER (WHERE kind='income' AND status='paid'),0)::bigint   AS "incomePaidCents",
       COALESCE(sum(amount_cents) FILTER (WHERE kind='income'),0)::bigint                     AS "incomeTotalCents",
       COALESCE(sum(amount_cents) FILTER (WHERE kind='expense' AND status='paid'),0)::bigint  AS "expensePaidCents",
       COALESCE(sum(amount_cents) FILTER (WHERE kind='expense'),0)::bigint                    AS "expenseTotalCents"
     FROM transactions t WHERE ${ACTIVE} AND user_id = ANY($1::int[]) AND date BETWEEN $2 AND $3`,
    [userIds, start, end],
  );
  return rows[0];
}

/** Série mensal de receitas x despesas (por competência). */
export async function monthlySeries(q: Queryable, userIds: number[], fromYm: string, toYm: string) {
  const { rows } = await q.query<{ month: string; income: number; expense: number }>(
    `SELECT to_char(date, 'YYYY-MM') AS month,
            COALESCE(sum(amount_cents) FILTER (WHERE kind='income'),0)::bigint AS income,
            COALESCE(sum(amount_cents) FILTER (WHERE kind='expense'),0)::bigint AS expense
       FROM transactions t WHERE ${ACTIVE} AND user_id = ANY($1::int[]) AND date BETWEEN $2 AND $3
      GROUP BY 1 ORDER BY 1`,
    [userIds, monthRange(fromYm).start, monthRange(toYm).end],
  );
  const map = new Map(rows.map((r) => [r.month, r]));
  const out: Array<{ month: string; incomeCents: number; expenseCents: number; resultCents: number }> = [];
  for (let m = fromYm; m <= toYm; m = shiftMonth(m, 1)) {
    const r = map.get(m);
    const income = r?.income ?? 0;
    const expense = r?.expense ?? 0;
    out.push({ month: m, incomeCents: income, expenseCents: expense, resultCents: income - expense });
  }
  return out;
}

/** Saldo ao fim de cada mês (contas não arquivadas + movimentações pagas até a data). */
export async function balanceHistory(q: Queryable, userIds: number[], months = 12) {
  const end = currentMonth();
  const start = shiftMonth(end, -(months - 1));
  const { rows: init } = await q.query<{ v: number }>(
    "SELECT COALESCE(sum(initial_balance_cents),0)::bigint AS v FROM accounts WHERE owner_id = ANY($1::int[]) AND NOT archived",
    [userIds],
  );
  const { rows: before } = await q.query<{ v: number }>(
    `SELECT COALESCE(sum(CASE WHEN kind='income' THEN amount_cents ELSE -amount_cents END),0)::bigint AS v
       FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE ${ACTIVE} AND NOT a.archived AND t.status='paid' AND t.user_id = ANY($1::int[]) AND COALESCE(t.paid_at, t.date) < $2`,
    [userIds, monthRange(start).start],
  );
  const { rows } = await q.query<{ month: string; v: number }>(
    `SELECT to_char(COALESCE(t.paid_at, t.date), 'YYYY-MM') AS month,
            sum(CASE WHEN kind='income' THEN amount_cents ELSE -amount_cents END)::bigint AS v
       FROM transactions t JOIN accounts a ON a.id = t.account_id
      WHERE ${ACTIVE} AND NOT a.archived AND t.status='paid' AND t.user_id = ANY($1::int[])
        AND COALESCE(t.paid_at, t.date) BETWEEN $2 AND $3
      GROUP BY 1`,
    [userIds, monthRange(start).start, monthRange(end).end],
  );
  const delta = new Map(rows.map((r) => [r.month, r.v]));
  let running = init[0].v + before[0].v;
  const out: Array<{ month: string; balanceCents: number }> = [];
  for (let m = start; m <= end; m = shiftMonth(m, 1)) {
    running += delta.get(m) ?? 0;
    out.push({ month: m, balanceCents: running });
  }
  return out;
}

export async function byCategory(q: Queryable, userIds: number[], from: string, to: string, kind: "income" | "expense" = "expense") {
  const { rows } = await q.query<{ categoryId: number | null; name: string; color: string; icon: string; cents: number; count: number }>(
    `SELECT c.id AS "categoryId", COALESCE(c.name, 'Sem categoria') AS name, COALESCE(c.color, '#9AA0A6') AS color,
            COALESCE(c.icon, 'tag') AS icon, sum(t.amount_cents)::bigint AS cents, count(*)::int AS count
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
      WHERE ${ACTIVE} AND t.kind = $4 AND t.user_id = ANY($1::int[]) AND t.date BETWEEN $2 AND $3
      GROUP BY c.id, c.name, c.color, c.icon ORDER BY cents DESC`,
    [userIds, from, to, kind],
  );
  const total = rows.reduce((s, r) => s + r.cents, 0);
  return rows.map((r) => ({ ...r, percent: total ? Math.round((r.cents / total) * 1000) / 10 : 0 }));
}

export async function byMember(q: Queryable, userIds: number[], from: string, to: string) {
  const { rows } = await q.query<{ userId: number; incomeCents: number; expenseCents: number }>(
    `SELECT t.user_id AS "userId",
            COALESCE(sum(amount_cents) FILTER (WHERE kind='income'),0)::bigint AS "incomeCents",
            COALESCE(sum(amount_cents) FILTER (WHERE kind='expense'),0)::bigint AS "expenseCents"
       FROM transactions t WHERE ${ACTIVE} AND t.user_id = ANY($1::int[]) AND t.date BETWEEN $2 AND $3 GROUP BY t.user_id`,
    [userIds, from, to],
  );
  return rows;
}

async function pendingList(q: Queryable, userIds: number[], kind: "overdue" | "upcoming", days = 15, limit = 8) {
  const t = today();
  const cond = kind === "overdue" ? "t.date < $2::date" : "t.date >= $2::date AND t.date <= $3::date";
  const { rows } = await q.query<TransactionRow>(
    `${TX_SELECT.replace("$TODAY", "$2::date")}
      WHERE ${ACTIVE} AND t.kind = 'expense' AND t.status = 'pending' AND t.user_id = ANY($1::int[]) AND ${cond}
      ORDER BY t.date LIMIT ${limit}`,
    kind === "overdue" ? [userIds, t] : [userIds, t, addDays(t, days)],
  );
  const { rows: agg } = await q.query<{ n: number; cents: number }>(
    `SELECT count(*)::int AS n, COALESCE(sum(amount_cents),0)::bigint AS cents FROM transactions t
      WHERE ${ACTIVE} AND t.kind = 'expense' AND t.status = 'pending' AND t.user_id = ANY($1::int[]) AND ${cond}`,
    kind === "overdue" ? [userIds, t] : [userIds, t, addDays(t, days)],
  );
  return { items: rows, count: agg[0].n, totalCents: agg[0].cents };
}

export async function dashboard(q: Queryable, viewer: AuthUser, view: ViewRequest, month?: string) {
  const ym = month && isYearMonth(month) ? month : currentMonth();
  const scope = await resolveScope(q, viewer, view);
  const ids = scope.userIds;
  const listIds = scope.detail ? ids : [viewer.id]; // listas individuais respeitam a permissão
  const { start, end } = monthRange(ym);
  const prev = shiftMonth(ym, -1);

  const [balance, totals, prevTotals, series, history, categories, upcoming, overdue, goals] = await Promise.all([
    totalBalance(q, ids),
    monthTotals(q, ids, ym),
    monthTotals(q, ids, prev),
    monthlySeries(q, ids, shiftMonth(ym, -5), ym),
    balanceHistory(q, ids, 12),
    byCategory(q, ids, start, end, "expense"),
    pendingList(q, listIds, "upcoming"),
    pendingList(q, listIds, "overdue"),
    listGoals(q, viewer, {}),
  ]);

  let members: Array<{ userId: number; name: string; color: string; balanceCents: number } & MonthTotals> | null = null;
  if (scope.isFamily && scope.detail) {
    const all = await listMembers(q);
    members = await Promise.all(
      all.map(async (m) => ({ userId: m.id, name: m.name, color: m.color, balanceCents: await totalBalance(q, [m.id]), ...(await monthTotals(q, [m.id], ym)) })),
    );
  }

  const visibleGoals = goals.filter((g) => (scope.isFamily ? g.scope === "family" || canSeeDetailsOf(viewer, g.ownerId) : g.scope === "family" || g.ownerId === viewer.id));

  return {
    month: ym,
    view: scope.isFamily ? "family" : ids[0] === viewer.id ? "me" : ids[0],
    detail: scope.detail,
    balanceCents: balance,
    totals,
    previousTotals: prevTotals,
    resultCents: totals.incomeTotalCents - totals.expenseTotalCents,
    resultPaidCents: totals.incomePaidCents - totals.expensePaidCents,
    series,
    balanceHistory: history,
    expensesByCategory: categories,
    upcoming,
    overdue,
    goals: visibleGoals.filter((g) => !g.archived).slice(0, 6),
    members,
    accounts: scope.detail ? await listAccounts(q, viewer, ids) : [],
  };
}

export async function report(q: Queryable, viewer: AuthUser, view: ViewRequest, params: { year?: string; month?: string; from?: string; to?: string }) {
  const scope = await resolveScope(q, viewer, view);
  let from: string;
  let to: string;
  let period: string;
  if (params.month) {
    if (!isYearMonth(params.month)) throw badRequest("Mês inválido.");
    ({ start: from, end: to } = monthRange(params.month));
    period = params.month;
  } else {
    const year = params.year ?? today().slice(0, 4);
    if (!/^\d{4}$/.test(year)) throw badRequest("Ano inválido.");
    from = `${year}-01-01`;
    to = `${year}-12-31`;
    period = year;
  }
  const ids = scope.userIds;
  const [series, expenseCats, incomeCats, members] = await Promise.all([
    monthlySeries(q, ids, from.slice(0, 7), to.slice(0, 7)),
    byCategory(q, ids, from, to, "expense"),
    byCategory(q, ids, from, to, "income"),
    scope.detail ? byMember(q, ids, from, to) : Promise.resolve(null),
  ]);
  const income = series.reduce((s, r) => s + r.incomeCents, 0);
  const expense = series.reduce((s, r) => s + r.expenseCents, 0);
  const nature = await q.query<{ nature: string; cents: number }>(
    `SELECT nature, sum(amount_cents)::bigint AS cents FROM transactions t
      WHERE ${ACTIVE} AND kind='expense' AND user_id = ANY($1::int[]) AND date BETWEEN $2 AND $3 GROUP BY nature`,
    [ids, from, to],
  );
  let topExpenses: TransactionRow[] = [];
  if (scope.detail) {
    const { rows } = await q.query<TransactionRow>(
      `${TX_SELECT.replace("$TODAY", "$4::date")} WHERE ${ACTIVE} AND t.kind='expense' AND t.user_id = ANY($1::int[]) AND t.date BETWEEN $2 AND $3
        ORDER BY t.amount_cents DESC LIMIT 10`,
      [ids, from, to, today()],
    );
    topExpenses = rows;
  }
  const months = series.filter((s) => s.incomeCents || s.expenseCents).length || 1;
  return {
    period,
    from,
    to,
    view: scope.isFamily ? "family" : ids[0],
    detail: scope.detail,
    totals: {
      incomeCents: income,
      expenseCents: expense,
      resultCents: income - expense,
      savingsRate: income > 0 ? Math.round(((income - expense) / income) * 1000) / 10 : null,
      avgMonthlyExpenseCents: Math.round(expense / months),
      fixedExpenseCents: nature.rows.find((r) => r.nature === "fixed")?.cents ?? 0,
      variableExpenseCents: nature.rows.find((r) => r.nature === "variable")?.cents ?? 0,
    },
    series,
    expensesByCategory: expenseCats,
    incomeByCategory: incomeCats,
    byMember: members,
    topExpenses,
  };
}

// ------------------------ Exportação CSV ------------------------

function csvCell(v: unknown): string {
  let s = v == null ? "" : String(v);
  // proteção contra injeção de fórmula em planilhas (=, +, -, @)
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function exportCsv(q: Queryable, viewer: AuthUser, view: ViewRequest, from: string, to: string) {
  const scope = await resolveScope(q, viewer, view);
  const ids = scope.detail ? scope.userIds : [viewer.id];
  const members = new Map((await listMembers(q)).map((m) => [m.id, m.name]));
  const { rows } = await q.query<TransactionRow>(
    `${TX_SELECT.replace("$TODAY", "$4::date")} WHERE ${ACTIVE} AND t.user_id = ANY($1::int[]) AND t.date BETWEEN $2 AND $3 ORDER BY t.date, t.id`,
    [ids, from, to, today()],
  );
  const header = ["Data", "Tipo", "Descrição", "Categoria", "Valor (R$)", "Situação", "Pago em", "Responsável", "Conta", "Natureza", "Parcela", "Forma de pagamento", "Origem", "Observações"];
  const lines = [header.join(";")];
  for (const r of rows) {
    lines.push(
      [
        r.date.split("-").reverse().join("/"),
        r.kind === "income" ? "Receita" : "Despesa",
        r.description,
        r.categoryName ?? "",
        ((r.kind === "income" ? 1 : -1) * r.amountCents / 100).toFixed(2).replace(".", ","),
        r.status === "paid" ? "Pago" : r.overdue ? "Atrasado" : "Pendente",
        r.paidAt ? r.paidAt.split("-").reverse().join("/") : "",
        members.get(r.userId) ?? "",
        r.accountName,
        r.nature === "fixed" ? "Fixa" : "Variável",
        r.installmentNumber ? `${r.installmentNumber}/${r.installmentTotal}` : "",
        r.paymentMethod ? PAYMENT_LABELS[r.paymentMethod] : "",
        r.source === "telegram" ? "Telegram" : r.source === "whatsapp" ? "WhatsApp" : r.source === "recurrence" ? "Recorrência" : "Site",
        r.notes ?? "",
      ].map(csvCell).join(";"),
    );
  }
  // BOM para o Excel abrir com acentuação correta
  return "﻿" + lines.join("\r\n") + "\r\n";
}
