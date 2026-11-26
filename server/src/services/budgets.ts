/**
 * Orçamentos mensais: de uma pessoa ou da família, gerais ou por categoria.
 * O gasto é calculado das despesas do mês (competência), como no painel.
 * Avisos em 70%, 90% e 100% (níveis usados pela fila de notificações).
 */
import { z } from "zod";
import type { Db, Queryable } from "../db/index.js";
import { currentMonth, isYearMonth, monthRange } from "../lib/clock.js";
import { forbidden, notFound } from "../lib/errors.js";
import { parse, zCents, zId } from "../lib/validate.js";
import { activeUserIds, canManageFamily, type AuthUser } from "./access.js";
import { audit } from "./audit.js";
import { assertCategory } from "./categories.js";

export interface BudgetRow {
  id: number;
  scope: "individual" | "family";
  ownerId: number | null;
  categoryId: number | null;
  categoryName: string | null;
  amountCents: number;
}

const SELECT = `SELECT b.id, b.scope, b.owner_id AS "ownerId", b.category_id AS "categoryId", c.name AS "categoryName",
                       b.amount_cents AS "amountCents"
                  FROM budgets b LEFT JOIN categories c ON c.id = b.category_id`;

function visible(viewer: AuthUser, b: BudgetRow) {
  if (b.scope === "family") return viewer.family_access !== "none";
  return b.ownerId === viewer.id || viewer.family_access === "full";
}

export async function listBudgets(q: Queryable, viewer: AuthUser): Promise<BudgetRow[]> {
  const { rows } = await q.query<BudgetRow>(`${SELECT} WHERE NOT b.archived ORDER BY b.scope DESC, b.owner_id, c.name NULLS FIRST`);
  return rows.filter((b) => visible(viewer, b));
}

const BudgetInput = z.object({
  scope: z.enum(["individual", "family"]),
  categoryId: zId.nullable().optional(),
  amountCents: zCents,
});

/** Orçamento individual: sempre da própria pessoa. Da família: só quem gerencia a família. */
export async function createBudget(db: Db, user: AuthUser, body: unknown) {
  const input = parse(BudgetInput, body);
  if (input.scope === "family" && !canManageFamily(user)) throw forbidden();
  const categoryId = await assertCategory(db, input.categoryId ?? null, "expense");
  const owner = input.scope === "individual" ? user.id : null;
  const { rows } = await db.query<{ id: number }>(
    `INSERT INTO budgets (scope, owner_id, category_id, amount_cents, created_by) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (scope, COALESCE(owner_id, 0), COALESCE(category_id, 0)) WHERE NOT archived
     DO UPDATE SET amount_cents = EXCLUDED.amount_cents, updated_at = now() RETURNING id`,
    [input.scope, owner, categoryId, input.amountCents, user.id],
  );
  await audit(db, { userId: user.id, action: "budget.save", entity: "budget", entityId: rows[0].id, details: { scope: input.scope } });
  return (await db.query<BudgetRow>(`${SELECT} WHERE b.id = $1`, [rows[0].id])).rows[0];
}

export async function archiveBudget(db: Db, user: AuthUser, id: number) {
  const { rows } = await db.query<BudgetRow>(`${SELECT} WHERE b.id = $1 AND NOT b.archived`, [id]);
  const b = rows[0];
  if (!b) throw notFound();
  const allowed = b.scope === "family" ? canManageFamily(user) : b.ownerId === user.id;
  if (!allowed) throw forbidden();
  await db.query("UPDATE budgets SET archived = TRUE, updated_at = now() WHERE id = $1", [id]);
  await audit(db, { userId: user.id, action: "budget.archive", entity: "budget", entityId: id });
}

export function budgetLevel(percent: number): "ok" | "70" | "90" | "100" {
  return percent >= 100 ? "100" : percent >= 90 ? "90" : percent >= 70 ? "70" : "ok";
}

/** Situação de cada orçamento visível no mês (padrão: mês atual). */
export async function budgetStatus(q: Queryable, viewer: AuthUser, month?: string) {
  const ym = month && isYearMonth(month) ? month : currentMonth();
  const { start, end } = monthRange(ym);
  const budgets = await listBudgets(q, viewer);
  const all = await activeUserIds(q);
  const out = [];
  for (const b of budgets) {
    const ids = b.scope === "family" ? all : [b.ownerId!];
    const { rows } = await q.query<{ cents: number }>(
      `SELECT COALESCE(sum(amount_cents),0)::bigint AS cents FROM transactions
        WHERE deleted_at IS NULL AND kind = 'expense' AND user_id = ANY($1::int[]) AND date BETWEEN $2 AND $3
          AND ($4::int IS NULL OR category_id = $4)`,
      [ids, start, end, b.categoryId],
    );
    const spent = rows[0].cents;
    const percent = Math.round((spent / b.amountCents) * 1000) / 10;
    out.push({ ...b, month: ym, spentCents: spent, remainingCents: b.amountCents - spent, percent, level: budgetLevel(percent) });
  }
  return out;
}
