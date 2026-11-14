import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Db, Queryable } from "../db/index.js";
import { addDays, addMonths, currentMonth, monthRange, shiftMonth, today } from "../lib/clock.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { parse, zCents, zDate, zId, zKind } from "../lib/validate.js";
import { assertOwner, resolveScope, type AuthUser, type ViewRequest } from "./access.js";
import { getOwnAccount } from "./accounts.js";
import { audit, type Source } from "./audit.js";
import { assertCategory } from "./categories.js";

export interface TransactionRow {
  id: number;
  userId: number;
  accountId: number;
  accountName: string;
  categoryId: number | null;
  categoryName: string | null;
  categoryColor: string | null;
  categoryIcon: string | null;
  kind: "income" | "expense";
  amountCents: number;
  description: string;
  date: string;
  status: "paid" | "pending";
  paidAt: string | null;
  nature: "fixed" | "variable";
  notes: string | null;
  recurrenceId: number | null;
  installmentGroup: string | null;
  installmentNumber: number | null;
  installmentTotal: number | null;
  source: string;
  createdAt: string;
  overdue: boolean;
}

export const TX_SELECT = `
  SELECT t.id, t.user_id AS "userId", t.account_id AS "accountId", a.name AS "accountName",
         t.category_id AS "categoryId", c.name AS "categoryName", c.color AS "categoryColor", c.icon AS "categoryIcon",
         t.kind, t.amount_cents AS "amountCents", t.description, t.date, t.status, t.paid_at AS "paidAt",
         t.nature, t.notes, t.recurrence_id AS "recurrenceId", t.installment_group AS "installmentGroup",
         t.installment_number AS "installmentNumber", t.installment_total AS "installmentTotal",
         t.source, t.created_at AS "createdAt",
         (t.status = 'pending' AND t.date < $TODAY) AS overdue
    FROM transactions t
    JOIN accounts a ON a.id = t.account_id
    LEFT JOIN categories c ON c.id = t.category_id`;

function selectSql(todayParamIndex: number) {
  return TX_SELECT.replace("$TODAY", `$${todayParamIndex}::date`);
}

export const TxInput = z
  .object({
    kind: zKind,
    amountCents: zCents,
    description: z.string().trim().min(1, "Informe uma descrição.").max(160, "Descrição muito longa."),
    date: zDate,
    status: z.enum(["paid", "pending"]).default("paid"),
    paidAt: zDate.optional().nullable(),
    accountId: zId.optional().nullable(),
    categoryId: zId.optional().nullable(),
    nature: z.enum(["fixed", "variable"]).default("variable"),
    notes: z.string().trim().max(500).optional().nullable(),
    installments: z.number().int().min(2, "Parcelamento a partir de 2x.").max(72, "Máximo de 72 parcelas.").optional().nullable(),
    /** Se verdadeiro, `amountCents` é o valor de CADA parcela; senão, é o total a dividir. */
    amountIsPerInstallment: z.boolean().optional(),
    recurrence: z
      .object({
        endDate: zDate.optional().nullable(),
        autoPaid: z.boolean().default(false),
      })
      .optional()
      .nullable(),
  })
  .refine((v) => !(v.installments && v.recurrence), "Escolha parcelamento OU recorrência, não os dois.");

export type TxInputT = z.infer<typeof TxInput>;

export async function createTransaction(db: Db, user: AuthUser, body: unknown, source: Source = "web", ip?: string) {
  const input = parse(TxInput, body);
  return db.tx(async (q) => {
    const accountId = await getOwnAccount(q, user, input.accountId);
    const categoryId = await assertCategory(q, input.categoryId, input.kind);
    const src = source === "telegram" ? "telegram" : "web";
    const base = { accountId, categoryId };
    let ids: number[] = [];

    if (input.installments) {
      ids = await insertInstallments(q, user, input, base, src);
    } else if (input.recurrence) {
      const day = Number(input.date.slice(8, 10));
      const { rows } = await q.query<{ id: number }>(
        `INSERT INTO recurrences (user_id, account_id, category_id, kind, amount_cents, description, nature,
            day_of_month, start_date, end_date, auto_paid, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$1) RETURNING id`,
        [user.id, accountId, categoryId, input.kind, input.amountCents, input.description, input.nature,
         day, input.date, input.recurrence.endDate ?? null, input.recurrence.autoPaid],
      );
      const recurrenceId = rows[0].id;
      // primeira ocorrência com o status escolhido
      const first = await insertOne(q, user, input, base, src, { recurrenceId });
      ids = [first, ...(await generateRecurrence(q, recurrenceId))];
      await audit(q, { userId: user.id, action: "recurrence.create", entity: "recurrence", entityId: recurrenceId, source });
    } else {
      ids = [await insertOne(q, user, input, base, src)];
    }
    await audit(q, {
      userId: user.id,
      action: "transaction.create",
      entity: "transaction",
      entityId: ids[0],
      source,
      ip,
      details: { count: ids.length, kind: input.kind, amountCents: input.amountCents },
    });
    return getTransactions(q, ids);
  });
}

async function insertOne(
  q: Queryable,
  user: AuthUser,
  input: TxInputT,
  base: { accountId: number; categoryId: number | null },
  source: string,
  extra: { recurrenceId?: number; group?: string; number?: number; total?: number; date?: string; amount?: number; status?: string } = {},
) {
  const status = extra.status ?? input.status;
  const date = extra.date ?? input.date;
  const paidAt = status === "paid" ? (extra.date ? date : (input.paidAt ?? date)) : null;
  const { rows } = await q.query<{ id: number }>(
    `INSERT INTO transactions (user_id, account_id, category_id, kind, amount_cents, description, date, status, paid_at,
        nature, notes, recurrence_id, installment_group, installment_number, installment_total, source, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$1) RETURNING id`,
    [user.id, base.accountId, base.categoryId, input.kind, extra.amount ?? input.amountCents, input.description, date, status, paidAt,
     input.nature, input.notes ?? null, extra.recurrenceId ?? null, extra.group ?? null, extra.number ?? null, extra.total ?? null, source],
  );
  return rows[0].id;
}

/** Divide o total em N parcelas mensais; centavos restantes vão para a 1ª parcela. */
export function splitInstallments(totalCents: number, n: number): number[] {
  const base = Math.floor(totalCents / n);
  const rest = totalCents - base * n;
  return Array.from({ length: n }, (_, i) => base + (i === 0 ? rest : 0));
}

async function insertInstallments(q: Queryable, user: AuthUser, input: TxInputT, base: { accountId: number; categoryId: number | null }, source: string) {
  const n = input.installments!;
  const amounts = input.amountIsPerInstallment ? Array(n).fill(input.amountCents) : splitInstallments(input.amountCents, n);
  if (amounts.some((a) => a <= 0)) throw badRequest("Valor muito baixo para esse número de parcelas.");
  const group = randomUUID();
  const day = Number(input.date.slice(8, 10));
  const ids: number[] = [];
  const t = today();
  for (let i = 0; i < n; i++) {
    const date = addMonths(input.date, i, day);
    // 1ª parcela segue o status escolhido; as futuras ficam pendentes (as passadas, pagas)
    const status = i === 0 ? input.status : date <= t && input.status === "paid" ? "paid" : "pending";
    ids.push(await insertOne(q, user, input, base, source, { group, number: i + 1, total: n, date, amount: amounts[i], status }));
  }
  return ids;
}

/**
 * Gera as ocorrências de uma recorrência até o mês seguinte ao atual.
 * Idempotente: o índice único (recurrence_id, date) impede duplicatas.
 */
export async function generateRecurrence(q: Queryable, recurrenceId: number): Promise<number[]> {
  const { rows } = await q.query<{
    id: number; user_id: number; account_id: number; category_id: number | null; kind: string; amount_cents: number;
    description: string; nature: string; day_of_month: number; start_date: string; end_date: string | null; auto_paid: boolean; active: boolean;
    last: string | null;
  }>(
    `SELECT r.*, (SELECT max(date) FROM transactions t WHERE t.recurrence_id = r.id) AS last
       FROM recurrences r WHERE r.id = $1`,
    [recurrenceId],
  );
  const r = rows[0];
  if (!r || !r.active) return [];
  const horizon = monthRange(shiftMonth(currentMonth(), 1)).end;
  const limit = r.end_date && r.end_date < horizon ? r.end_date : horizon;
  const t = today();
  const created: number[] = [];
  let date = r.last ? addMonths(r.last, 1, r.day_of_month) : addMonths(r.start_date, 0, r.day_of_month);
  if (date < r.start_date) date = addMonths(date, 1, r.day_of_month);
  let guard = 0;
  while (date <= limit && guard++ < 600) {
    const paid = r.auto_paid && date <= t;
    const ins = await q.query<{ id: number }>(
      `INSERT INTO transactions (user_id, account_id, category_id, kind, amount_cents, description, date, status, paid_at,
          nature, recurrence_id, source, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'recurrence',$1)
       ON CONFLICT (recurrence_id, date) WHERE recurrence_id IS NOT NULL DO NOTHING RETURNING id`,
      [r.user_id, r.account_id, r.category_id, r.kind, r.amount_cents, r.description, date, paid ? "paid" : "pending", paid ? date : null, r.nature, r.id],
    );
    if (ins.rows[0]) created.push(ins.rows[0].id);
    date = addMonths(date, 1, r.day_of_month);
  }
  return created;
}

export async function generateAllRecurrences(db: Db): Promise<number> {
  const { rows } = await db.query<{ id: number }>("SELECT id FROM recurrences WHERE active");
  let n = 0;
  for (const r of rows) n += (await db.tx((q) => generateRecurrence(q, r.id))).length;
  return n;
}

export async function getTransactions(q: Queryable, ids: number[]): Promise<TransactionRow[]> {
  if (!ids.length) return [];
  const { rows } = await q.query<TransactionRow>(`${selectSql(2)} WHERE t.id = ANY($1::int[]) ORDER BY t.date, t.id`, [ids, today()]);
  return rows;
}

async function loadOwned(q: Queryable, user: AuthUser, id: number) {
  const { rows } = await q.query<{ id: number; user_id: number; kind: string; status: string; installment_group: string | null; date: string; recurrence_id: number | null }>(
    "SELECT id, user_id, kind, status, installment_group, date, recurrence_id FROM transactions WHERE id = $1 AND deleted_at IS NULL",
    [id],
  );
  const t = rows[0];
  if (!t) throw notFound("Movimentação não encontrada.");
  assertOwner(user, t.user_id, "esta movimentação");
  return t;
}

const TxPatch = z.object({
  kind: zKind.optional(),
  amountCents: zCents.optional(),
  description: z.string().trim().min(1).max(160).optional(),
  date: zDate.optional(),
  status: z.enum(["paid", "pending"]).optional(),
  paidAt: zDate.optional().nullable(),
  accountId: zId.optional(),
  categoryId: zId.optional().nullable(),
  nature: z.enum(["fixed", "variable"]).optional(),
  notes: z.string().trim().max(500).optional().nullable(),
});

export async function updateTransaction(db: Db, user: AuthUser, id: number, body: unknown, source: Source = "web", ip?: string) {
  const patch = parse(TxPatch, body);
  return db.tx(async (q) => {
    const current = await loadOwned(q, user, id);
    const kind = patch.kind ?? current.kind;
    if (patch.accountId) await getOwnAccount(q, user, patch.accountId);
    if (patch.categoryId !== undefined) await assertCategory(q, patch.categoryId, kind);
    else if (patch.kind && patch.kind !== current.kind) {
      // troca de tipo invalida a categoria anterior
      patch.categoryId = null;
    }
    const status = patch.status ?? current.status;
    let paidAt: string | null | undefined = undefined;
    if (status === "pending") paidAt = null;
    else if (patch.paidAt) paidAt = patch.paidAt;
    else if (patch.status === "paid" && current.status !== "paid") paidAt = today();
    const sets: string[] = [];
    const vals: unknown[] = [id];
    const put = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };
    if (patch.kind) put("kind", patch.kind);
    if (patch.amountCents) put("amount_cents", patch.amountCents);
    if (patch.description) put("description", patch.description);
    if (patch.date) put("date", patch.date);
    if (patch.status) put("status", patch.status);
    if (paidAt !== undefined) put("paid_at", paidAt);
    if (patch.accountId) put("account_id", patch.accountId);
    if (patch.categoryId !== undefined) put("category_id", patch.categoryId);
    if (patch.nature) put("nature", patch.nature);
    if (patch.notes !== undefined) put("notes", patch.notes);
    if (sets.length) await q.query(`UPDATE transactions SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, vals);
    await audit(q, { userId: user.id, action: "transaction.update", entity: "transaction", entityId: id, source, ip, details: patch });
    return (await getTransactions(q, [id]))[0];
  });
}

export async function markPaid(db: Db, user: AuthUser, id: number, paidAt?: string, source: Source = "web") {
  return updateTransaction(db, user, id, { status: "paid", paidAt: paidAt ?? today() }, source);
}

/** Exclusão lógica (preserva histórico/auditoria). `scope=group` remove parcelas pendentes do mesmo grupo. */
export async function deleteTransaction(db: Db, user: AuthUser, id: number, scope: "one" | "group" = "one", source: Source = "web", ip?: string) {
  return db.tx(async (q) => {
    const t = await loadOwned(q, user, id);
    let count = 1;
    if (scope === "group" && t.installment_group) {
      const r = await q.query(
        `UPDATE transactions SET deleted_at = now() WHERE installment_group = $1 AND user_id = $2 AND deleted_at IS NULL
           AND (id = $3 OR (status = 'pending' AND date >= $4))`,
        [t.installment_group, user.id, id, t.date],
      );
      count = r.rowCount;
    } else {
      await q.query("UPDATE transactions SET deleted_at = now() WHERE id = $1", [id]);
    }
    await audit(q, { userId: user.id, action: "transaction.delete", entity: "transaction", entityId: id, source, ip, details: { scope, count } });
    return { deleted: count };
  });
}

// ------------------------ Listagem / filtros ------------------------

export const TxFilter = z.object({
  view: z.any().optional(),
  from: zDate.optional(),
  to: zDate.optional(),
  kind: zKind.optional(),
  status: z.enum(["paid", "pending", "overdue"]).optional(),
  categoryId: z.coerce.number().int().positive().optional(),
  accountId: z.coerce.number().int().positive().optional(),
  nature: z.enum(["fixed", "variable"]).optional(),
  q: z.string().trim().max(80).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
  sort: z.enum(["date_desc", "date_asc", "amount_desc", "amount_asc"]).default("date_desc"),
});

export async function listTransactions(q: Queryable, viewer: AuthUser, view: ViewRequest, query: unknown) {
  const f = parse(TxFilter, query);
  const scope = await resolveScope(q, viewer, view);
  if (!scope.detail) throw forbidden("Sua conta só tem acesso aos totais da família, não aos lançamentos.");
  const t = today();
  const where = ["t.deleted_at IS NULL", "t.user_id = ANY($1::int[])"];
  const vals: unknown[] = [scope.userIds];
  // cada "?" vira o próximo parâmetro posicional
  const add = (cond: string, ...v: unknown[]) => {
    let out = cond;
    for (const item of v) {
      vals.push(item);
      out = out.replace("?", `$${vals.length}`);
    }
    where.push(out);
  };
  if (f.from) add("t.date >= ?", f.from);
  if (f.to) add("t.date <= ?", f.to);
  if (f.kind) add("t.kind = ?", f.kind);
  if (f.status === "overdue") add("t.status = 'pending' AND t.date < ?::date", t);
  else if (f.status) add("t.status = ?", f.status);
  if (f.categoryId) add("t.category_id = ?", f.categoryId);
  if (f.accountId) add("t.account_id = ?", f.accountId);
  if (f.nature) add("t.nature = ?", f.nature);
  if (f.q) {
    const like = `%${escapeLike(f.q)}%`;
    add("(t.description ILIKE ? OR t.notes ILIKE ? OR c.name ILIKE ?)", like, like, like);
  }
  const order = {
    date_desc: "t.date DESC, t.id DESC",
    date_asc: "t.date ASC, t.id ASC",
    amount_desc: "t.amount_cents DESC, t.id DESC",
    amount_asc: "t.amount_cents ASC, t.id ASC",
  }[f.sort];
  const whereSql = where.join(" AND ");
  const totals = await q.query<{ count: number; income: number; expense: number }>(
    `SELECT count(*)::int AS count,
            COALESCE(sum(t.amount_cents) FILTER (WHERE t.kind = 'income'), 0)::bigint AS income,
            COALESCE(sum(t.amount_cents) FILTER (WHERE t.kind = 'expense'), 0)::bigint AS expense
       FROM transactions t LEFT JOIN categories c ON c.id = t.category_id WHERE ${whereSql}`,
    vals,
  );
  const offset = (f.page - 1) * f.pageSize;
  const { rows } = await q.query<TransactionRow>(
    `${selectSql(vals.length + 1)} WHERE ${whereSql} ORDER BY ${order} LIMIT ${f.pageSize} OFFSET ${offset}`,
    [...vals, t],
  );
  return { items: rows, total: totals.rows[0].count, page: f.page, pageSize: f.pageSize, sums: { incomeCents: totals.rows[0].income, expenseCents: totals.rows[0].expense } };
}

function escapeLike(s: string) {
  return s.replace(/[\\%_]/g, (m) => "\\" + m);
}

// ------------------------ Contas a pagar ------------------------

export async function listBills(q: Queryable, viewer: AuthUser, view: ViewRequest) {
  const scope = await resolveScope(q, viewer, view);
  const ids = scope.detail ? scope.userIds : [viewer.id];
  const t = today();
  const base = `${selectSql(2)} WHERE t.deleted_at IS NULL AND t.kind = 'expense' AND t.user_id = ANY($1::int[])`;
  const [overdue, upcoming, paid] = await Promise.all([
    q.query<TransactionRow>(`${base} AND t.status = 'pending' AND t.date < $2::date ORDER BY t.date`, [ids, t]),
    q.query<TransactionRow>(`${base} AND t.status = 'pending' AND t.date >= $2::date AND t.date <= $3::date ORDER BY t.date`, [ids, t, addDays(t, 60)]),
    q.query<TransactionRow>(
      `${base} AND t.status = 'paid' AND (t.recurrence_id IS NOT NULL OR t.installment_group IS NOT NULL OR t.nature = 'fixed')
        AND t.paid_at >= $3::date ORDER BY t.paid_at DESC LIMIT 50`,
      [ids, t, addDays(t, -90)],
    ),
  ]);
  const sum = (rows: TransactionRow[]) => rows.reduce((s, r) => s + r.amountCents, 0);
  return {
    overdue: overdue.rows,
    upcoming: upcoming.rows,
    paid: paid.rows,
    totals: { overdueCents: sum(overdue.rows), upcomingCents: sum(upcoming.rows) },
    limitedToSelf: !scope.detail && scope.isFamily,
  };
}

// ------------------------ Recorrências ------------------------

export async function listRecurrences(q: Queryable, viewer: AuthUser, view: ViewRequest) {
  const scope = await resolveScope(q, viewer, view);
  if (!scope.detail) throw forbidden();
  const { rows } = await q.query(
    `SELECT r.id, r.user_id AS "userId", r.kind, r.amount_cents AS "amountCents", r.description, r.nature,
            r.day_of_month AS "dayOfMonth", r.start_date AS "startDate", r.end_date AS "endDate",
            r.auto_paid AS "autoPaid", r.active, r.category_id AS "categoryId", c.name AS "categoryName", c.color AS "categoryColor",
            r.account_id AS "accountId", a.name AS "accountName"
       FROM recurrences r JOIN accounts a ON a.id = r.account_id LEFT JOIN categories c ON c.id = r.category_id
      WHERE r.user_id = ANY($1::int[]) ORDER BY r.active DESC, r.day_of_month`,
    [scope.userIds],
  );
  return rows;
}

const RecPatch = z.object({
  amountCents: zCents.optional(),
  description: z.string().trim().min(1).max(160).optional(),
  categoryId: zId.optional().nullable(),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
  endDate: zDate.optional().nullable(),
  autoPaid: z.boolean().optional(),
  active: z.boolean().optional(),
});

/** Atualiza a regra e aplica às ocorrências FUTURAS ainda pendentes (o histórico pago não muda). */
export async function updateRecurrence(db: Db, user: AuthUser, id: number, body: unknown) {
  const p = parse(RecPatch, body);
  return db.tx(async (q) => {
    const { rows } = await q.query<{ user_id: number; kind: string; day_of_month: number }>("SELECT user_id, kind, day_of_month FROM recurrences WHERE id = $1", [id]);
    const r = rows[0];
    if (!r) throw notFound();
    assertOwner(user, r.user_id, "esta recorrência");
    if (p.categoryId !== undefined) await assertCategory(q, p.categoryId, r.kind);
    const t = today();
    await q.query(
      `UPDATE recurrences SET amount_cents = COALESCE($2, amount_cents), description = COALESCE($3, description),
          category_id = CASE WHEN $4::boolean THEN $5 ELSE category_id END, day_of_month = COALESCE($6, day_of_month),
          end_date = CASE WHEN $7::boolean THEN $8::date ELSE end_date END, auto_paid = COALESCE($9, auto_paid),
          active = COALESCE($10, active), updated_at = now()
        WHERE id = $1`,
      [id, p.amountCents ?? null, p.description ?? null, p.categoryId !== undefined, p.categoryId ?? null, p.dayOfMonth ?? null,
       p.endDate !== undefined, p.endDate ?? null, p.autoPaid ?? null, p.active ?? null],
    );
    const future = `recurrence_id = $1 AND status = 'pending' AND date >= $2 AND deleted_at IS NULL`;
    if (p.active === false) {
      await q.query(`UPDATE transactions SET deleted_at = now() WHERE ${future}`, [id, t]);
    } else {
      if (p.active === true) {
        // retomar: restaura as ocorrências futuras removidas na pausa
        await q.query(
          `UPDATE transactions SET deleted_at = NULL, updated_at = now()
            WHERE recurrence_id = $1 AND status = 'pending' AND date >= $2 AND deleted_at IS NOT NULL`,
          [id, t],
        );
      }
      if (p.amountCents) await q.query(`UPDATE transactions SET amount_cents = $3, updated_at = now() WHERE ${future}`, [id, t, p.amountCents]);
      if (p.description) await q.query(`UPDATE transactions SET description = $3, updated_at = now() WHERE ${future}`, [id, t, p.description]);
      if (p.categoryId !== undefined) await q.query(`UPDATE transactions SET category_id = $3, updated_at = now() WHERE ${future}`, [id, t, p.categoryId]);
      if (p.endDate) await q.query(`UPDATE transactions SET deleted_at = now() WHERE ${future} AND date > $3`, [id, t, p.endDate]);
      if (p.dayOfMonth && p.dayOfMonth !== r.day_of_month) {
        const { rows: fut } = await q.query<{ id: number; date: string }>(`SELECT id, date FROM transactions WHERE ${future}`, [id, t]);
        for (const f of fut) {
          const nd = addMonths(f.date, 0, p.dayOfMonth);
          await q.query("UPDATE transactions SET date = $2, updated_at = now() WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM transactions WHERE recurrence_id = $3 AND date = $2)", [f.id, nd, id]);
        }
      }
      await generateRecurrence(q, id);
    }
    await audit(q, { userId: user.id, action: "recurrence.update", entity: "recurrence", entityId: id, details: p });
  });
}
