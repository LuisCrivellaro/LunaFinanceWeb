/**
 * Consultas financeiras do bot — SEMPRE no banco, sempre no escopo do usuário
 * autenticado (ou da família, quando a permissão permite). Estas funções são
 * usadas tanto pelas respostas fixas quanto pelas ferramentas da IA: a IA não
 * tem outro caminho para ler dados (nada de SQL livre).
 */
import type { Queryable } from "../db/index.js";
import { addDays, currentMonth, monthRange, shiftMonth, today } from "../lib/clock.js";
import { resolveScope, type AuthUser } from "../services/access.js";
import { listAccounts, totalBalance } from "../services/accounts.js";
import { listGoals, type GoalRow } from "../services/goals.js";
import { balanceHistory, byCategory, monthlySeries } from "../services/insights.js";
import { TX_SELECT, type TransactionRow } from "../services/transactions.js";

const ACTIVE = "t.deleted_at IS NULL";

export async function getBalance(q: Queryable, user: AuthUser) {
  const accounts = await listAccounts(q, user, [user.id]);
  return {
    totalCents: accounts.reduce((s, a) => s + a.balanceCents, 0),
    accounts: accounts.map((a) => ({ name: a.name, balanceCents: a.balanceCents })),
  };
}

export async function getPeriodTotals(q: Queryable, userIds: number[], from: string, to: string) {
  const { rows } = await q.query<{ income: number; expense: number; incomePaid: number; expensePaid: number; n: number }>(
    `SELECT COALESCE(sum(amount_cents) FILTER (WHERE kind='income'),0)::bigint AS income,
            COALESCE(sum(amount_cents) FILTER (WHERE kind='expense'),0)::bigint AS expense,
            COALESCE(sum(amount_cents) FILTER (WHERE kind='income' AND status='paid'),0)::bigint AS "incomePaid",
            COALESCE(sum(amount_cents) FILTER (WHERE kind='expense' AND status='paid'),0)::bigint AS "expensePaid",
            count(*)::int AS n
       FROM transactions t WHERE ${ACTIVE} AND user_id = ANY($1::int[]) AND date BETWEEN $2 AND $3`,
    [userIds, from, to],
  );
  const r = rows[0];
  return {
    from,
    to,
    incomeCents: r.income,
    expenseCents: r.expense,
    incomePaidCents: r.incomePaid,
    expensePaidCents: r.expensePaid,
    resultCents: r.income - r.expense,
    count: r.n,
  };
}

export async function getCategoryTotal(q: Queryable, userIds: number[], categoryId: number, from: string, to: string) {
  const { rows } = await q.query<{ cents: number; n: number; name: string }>(
    `SELECT COALESCE(sum(t.amount_cents),0)::bigint AS cents, count(t.id)::int AS n, c.name
       FROM categories c LEFT JOIN transactions t ON t.category_id = c.id AND ${ACTIVE}
            AND t.user_id = ANY($1::int[]) AND t.date BETWEEN $3 AND $4
      WHERE c.id = $2 GROUP BY c.name`,
    [userIds, categoryId, from, to],
  );
  return { categoryName: rows[0]?.name ?? "", cents: rows[0]?.cents ?? 0, count: rows[0]?.n ?? 0, from, to };
}

export async function getCategoryBreakdown(q: Queryable, userIds: number[], from: string, to: string, kind: "income" | "expense" = "expense") {
  return (await byCategory(q, userIds, from, to, kind)).map((c) => ({ name: c.name, cents: c.cents, percent: c.percent, count: c.count }));
}

export async function getTransactionsList(
  q: Queryable,
  userIds: number[],
  opts: { kind?: "income" | "expense"; from?: string; to?: string; categoryId?: number | null; search?: string; limit?: number; order?: "recent" | "largest" },
) {
  const where = [ACTIVE, "t.user_id = ANY($1::int[])"];
  const vals: unknown[] = [userIds];
  const add = (sql: string, v: unknown) => {
    vals.push(v);
    where.push(sql.replace("?", `$${vals.length}`));
  };
  if (opts.kind) add("t.kind = ?", opts.kind);
  if (opts.from) add("t.date >= ?", opts.from);
  if (opts.to) add("t.date <= ?", opts.to);
  if (opts.categoryId) add("t.category_id = ?", opts.categoryId);
  if (opts.search) add("t.description ILIKE ?", `%${opts.search.replace(/[\\%_]/g, (m) => "\\" + m)}%`);
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 30);
  const order = opts.order === "largest" ? "t.amount_cents DESC, t.date DESC" : "t.date DESC, t.id DESC";
  vals.push(today());
  const { rows } = await q.query<TransactionRow>(
    `${TX_SELECT.replace("$TODAY", `$${vals.length}::date`)} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ${limit}`,
    vals,
  );
  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    date: r.date,
    kind: r.kind,
    description: r.description,
    category: r.categoryName,
    amountCents: r.amountCents,
    status: r.status,
    paymentMethod: r.paymentMethod,
    source: r.source,
  }));
}

export async function compareMonths(q: Queryable, userIds: number[], ym: string) {
  const prev = shiftMonth(ym, -1);
  const [a, b] = [monthRange(ym), monthRange(prev)];
  // mês atual até hoje × mesmo intervalo do mês anterior (comparação justa)
  const isCurrent = ym === currentMonth();
  const dayLimit = isCurrent ? Number(today().slice(8, 10)) : 31;
  const prevTo = isCurrent ? addDays(b.start, Math.min(dayLimit, Number(b.end.slice(8, 10))) - 1) : b.end;
  const curTo = isCurrent ? today() : a.end;
  const [cur, before, catCur, catPrev] = await Promise.all([
    getPeriodTotals(q, userIds, a.start, curTo),
    getPeriodTotals(q, userIds, b.start, prevTo),
    byCategory(q, userIds, a.start, curTo, "expense"),
    byCategory(q, userIds, b.start, prevTo, "expense"),
  ]);
  const names = new Set([...catCur.map((c) => c.name), ...catPrev.map((c) => c.name)]);
  const categories = [...names]
    .map((name) => {
      const now = catCur.find((c) => c.name === name)?.cents ?? 0;
      const was = catPrev.find((c) => c.name === name)?.cents ?? 0;
      return { name, currentCents: now, previousCents: was, deltaCents: now - was };
    })
    .sort((x, y) => Math.abs(y.deltaCents) - Math.abs(x.deltaCents))
    .slice(0, 5);
  return {
    current: { month: ym, from: a.start, to: curTo, expenseCents: cur.expenseCents, incomeCents: cur.incomeCents },
    previous: { month: prev, from: b.start, to: prevTo, expenseCents: before.expenseCents, incomeCents: before.incomeCents },
    expenseDeltaCents: cur.expenseCents - before.expenseCents,
    expenseDeltaPercent: before.expenseCents ? Math.round(((cur.expenseCents - before.expenseCents) / before.expenseCents) * 1000) / 10 : null,
    incomeDeltaCents: cur.incomeCents - before.incomeCents,
    sameDayRange: isCurrent,
    categories,
  };
}

export async function getFlow(q: Queryable, userIds: number[], months = 6) {
  const ym = currentMonth();
  return monthlySeries(q, userIds, shiftMonth(ym, -(months - 1)), ym);
}

export async function getEvolution(q: Queryable, userIds: number[], months = 6) {
  return balanceHistory(q, userIds, months);
}

export async function getPendingBills(q: Queryable, userId: number, days = 30) {
  const t = today();
  const { rows } = await q.query<{ id: number; description: string; amountCents: number; date: string }>(
    `SELECT id, description, amount_cents AS "amountCents", date FROM transactions t
      WHERE ${ACTIVE} AND user_id = $1 AND kind='expense' AND status='pending' AND date <= $2 ORDER BY date LIMIT 25`,
    [userId, addDays(t, days)],
  );
  return {
    overdue: rows.filter((r) => r.date < t),
    upcoming: rows.filter((r) => r.date >= t),
  };
}

export interface GoalDetail {
  id: number;
  name: string;
  scope: string;
  targetCents: number;
  savedCents: number;
  remainingCents: number;
  percent: number;
  deadline: string | null;
  monthlyNeededCents: number | null;
  /** média mensal guardada nos últimos 3 meses (null se não houver histórico) */
  avgMonthlyCents: number | null;
  /** meses estimados no ritmo atual (null se não der para estimar) */
  estimatedMonths: number | null;
  achieved: boolean;
}

export async function getGoals(q: Queryable, user: AuthUser): Promise<GoalDetail[]> {
  const goals = (await listGoals(q, user, {})).filter((g) => g.scope === "family" || g.ownerId === user.id);
  return Promise.all(goals.map((g) => goalDetail(q, g)));
}

async function goalDetail(q: Queryable, g: GoalRow): Promise<GoalDetail> {
  const remaining = Math.max(0, g.targetCents - g.savedCents);
  const { rows } = await q.query<{ cents: number; first: string | null }>(
    `SELECT COALESCE(sum(amount_cents),0)::bigint AS cents, min(date) AS first FROM goal_contributions WHERE goal_id = $1 AND date >= $2`,
    [g.id, addDays(today(), -90)],
  );
  let avg: number | null = null;
  if (rows[0].first && rows[0].cents > 0) {
    // meses efetivos de histórico dentro da janela (mínimo 1)
    const days = Math.max(30, Math.round((Date.parse(today()) - Date.parse(rows[0].first)) / 86400000) + 1);
    avg = Math.round((rows[0].cents / days) * 30);
  }
  return {
    id: g.id,
    name: g.name,
    scope: g.scope,
    targetCents: g.targetCents,
    savedCents: g.savedCents,
    remainingCents: remaining,
    percent: g.percent,
    deadline: g.deadline,
    monthlyNeededCents: g.monthlyNeededCents,
    avgMonthlyCents: avg,
    estimatedMonths: avg && remaining > 0 ? Math.ceil(remaining / avg) : remaining === 0 ? 0 : null,
    achieved: Boolean(g.achievedAt) || remaining === 0,
  };
}

export async function familyOverview(q: Queryable, user: AuthUser, from: string, to: string) {
  const scope = await resolveScope(q, user, "family");
  const [balance, totals] = await Promise.all([totalBalance(q, scope.userIds), getPeriodTotals(q, scope.userIds, from, to)]);
  let perMember: Array<{ name: string; incomeCents: number; expenseCents: number }> | null = null;
  if (scope.detail) {
    const { rows } = await q.query<{ name: string; income: number; expense: number }>(
      `SELECT u.name,
              COALESCE(sum(t.amount_cents) FILTER (WHERE t.kind='income'),0)::bigint AS income,
              COALESCE(sum(t.amount_cents) FILTER (WHERE t.kind='expense'),0)::bigint AS expense
         FROM users u LEFT JOIN transactions t ON t.user_id = u.id AND ${ACTIVE} AND t.date BETWEEN $2 AND $3
        WHERE u.id = ANY($1::int[]) GROUP BY u.name ORDER BY lower(u.name)`,
      [scope.userIds, from, to],
    );
    perMember = rows.map((r) => ({ name: r.name, incomeCents: r.income, expenseCents: r.expense }));
  }
  return { balanceCents: balance, totals, perMember, detail: scope.detail };
}

/** Possível duplicidade: mesmo tipo e valor, até 2 dias de diferença, registrado nos últimos 30 dias. */
export async function findPossibleDuplicate(q: Queryable, userId: number, kind: string, amountCents: number, date: string) {
  const { rows } = await q.query<{ id: number; description: string; date: string; source: string }>(
    `SELECT id, description, date, source FROM transactions
      WHERE deleted_at IS NULL AND user_id = $1 AND kind = $2 AND amount_cents = $3
        AND date BETWEEN $4 AND $5 AND created_at > now() - interval '30 days'
      ORDER BY abs(date - $6::date), id DESC LIMIT 1`,
    [userId, kind, amountCents, addDays(date, -2), addDays(date, 2), date],
  );
  return rows[0] ?? null;
}
