import { z } from "zod";
import type { Db, Queryable } from "../db/index.js";
import { today } from "../lib/clock.js";
import { badRequest, forbidden, notFound } from "../lib/errors.js";
import { MAX_CENTS } from "../lib/money.js";
import { parse, zCents, zDate } from "../lib/validate.js";
import { assertOwner, type AuthUser } from "./access.js";
import { audit, type Source } from "./audit.js";

export interface GoalRow {
  id: number;
  scope: "individual" | "family";
  ownerId: number;
  name: string;
  targetCents: number;
  savedCents: number;
  deadline: string | null;
  color: string;
  icon: string;
  archived: boolean;
  achievedAt: string | null;
  percent: number;
  /** Quanto guardar por mês para bater a meta no prazo (null se sem prazo ou já atingida). */
  monthlyNeededCents: number | null;
  contributors: Array<{ userId: number; cents: number }>;
}

/** Quais metas a pessoa pode ver: as suas, as familiares e (com acesso completo) as individuais dos outros. */
function visibilityClause(viewer: AuthUser) {
  if (viewer.family_access === "none") return { sql: "(g.scope = 'individual' AND g.owner_id = $1)", params: [viewer.id] };
  if (viewer.family_access === "summary") return { sql: "(g.owner_id = $1 OR g.scope = 'family')", params: [viewer.id] };
  return { sql: "$1::int > 0", params: [viewer.id] }; // tudo visível ($1 referenciado p/ o bind)
}

export async function listGoals(q: Queryable, viewer: AuthUser, opts: { includeArchived?: boolean; scope?: "mine" | "family" | "all" } = {}): Promise<GoalRow[]> {
  const vis = visibilityClause(viewer);
  const extra: string[] = [];
  if (!opts.includeArchived) extra.push("NOT g.archived");
  if (opts.scope === "mine") extra.push("(g.scope = 'individual' AND g.owner_id = $1)");
  if (opts.scope === "family") extra.push("g.scope = 'family'");
  const { rows } = await q.query<Omit<GoalRow, "percent" | "monthlyNeededCents" | "contributors"> & { contributors: GoalRow["contributors"] | null }>(
    `SELECT g.id, g.scope, g.owner_id AS "ownerId", g.name, g.target_cents AS "targetCents",
            COALESCE((SELECT sum(amount_cents) FROM goal_contributions c WHERE c.goal_id = g.id), 0)::bigint AS "savedCents",
            g.deadline, g.color, g.icon, g.archived, g.achieved_at AS "achievedAt",
            (SELECT json_agg(json_build_object('userId', x.user_id, 'cents', x.cents) ORDER BY x.cents DESC)
               FROM (SELECT user_id, sum(amount_cents)::bigint AS cents FROM goal_contributions c WHERE c.goal_id = g.id GROUP BY user_id) x) AS contributors
       FROM goals g
      WHERE ${vis.sql} ${extra.length ? "AND " + extra.join(" AND ") : ""}
      ORDER BY g.archived, g.achieved_at NULLS FIRST, g.deadline NULLS LAST, g.id`,
    vis.params,
  );
  return rows.map((g) => decorate({ ...g, contributors: (g.contributors ?? []).map((c) => ({ userId: c.userId, cents: Number(c.cents) })) }));
}

function decorate(g: Omit<GoalRow, "percent" | "monthlyNeededCents">): GoalRow {
  const percent = Math.max(0, Math.min(100, Math.round((g.savedCents / g.targetCents) * 1000) / 10));
  let monthlyNeededCents: number | null = null;
  const remaining = g.targetCents - g.savedCents;
  if (g.deadline && remaining > 0) {
    const t = today();
    const months = Math.max(1, (Number(g.deadline.slice(0, 4)) - Number(t.slice(0, 4))) * 12 + (Number(g.deadline.slice(5, 7)) - Number(t.slice(5, 7))) + (g.deadline.slice(8) >= t.slice(8) ? 1 : 0));
    monthlyNeededCents = Math.ceil(remaining / months);
  }
  return { ...g, percent, monthlyNeededCents };
}

async function loadGoal(q: Queryable, viewer: AuthUser, id: number) {
  const goals = await listGoals(q, viewer, { includeArchived: true });
  const g = goals.find((x) => x.id === id);
  if (!g) throw notFound("Meta não encontrada.");
  return g;
}

const GoalInput = z.object({
  scope: z.enum(["individual", "family"]).default("individual"),
  name: z.string().trim().min(1, "Dê um nome para a meta.").max(60),
  targetCents: zCents,
  deadline: zDate.optional().nullable(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#4F6BED"),
  icon: z.string().regex(/^[a-z0-9-]{1,30}$/).default("target"),
  initialCents: z.number().int().min(0).max(MAX_CENTS).optional(),
});

export async function createGoal(db: Db, user: AuthUser, body: unknown, source: Source = "web") {
  const input = parse(GoalInput, body);
  if (input.scope === "family" && user.family_access === "none") throw forbidden("Sua conta não participa das metas da família.");
  return db.tx(async (q) => {
    const { rows } = await q.query<{ id: number }>(
      `INSERT INTO goals (scope, owner_id, name, target_cents, deadline, color, icon) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [input.scope, user.id, input.name, input.targetCents, input.deadline ?? null, input.color, input.icon],
    );
    const id = rows[0].id;
    if (input.initialCents) {
      await q.query(`INSERT INTO goal_contributions (goal_id, user_id, amount_cents, date, note) VALUES ($1,$2,$3,$4,'Valor inicial')`, [id, user.id, input.initialCents, today()]);
    }
    await refreshAchieved(q, id);
    await audit(q, { userId: user.id, action: "goal.create", entity: "goal", entityId: id, source });
    return loadGoal(q, user, id);
  });
}

export async function updateGoal(db: Db, user: AuthUser, id: number, body: unknown) {
  const input = parse(GoalInput.omit({ initialCents: true, scope: true }).partial().extend({ archived: z.boolean().optional() }), body);
  return db.tx(async (q) => {
    const g = await loadGoal(q, user, id);
    assertOwner(user, g.ownerId, "esta meta");
    await q.query(
      `UPDATE goals SET name = COALESCE($2,name), target_cents = COALESCE($3,target_cents),
         deadline = CASE WHEN $4::boolean THEN $5::date ELSE deadline END, color = COALESCE($6,color), icon = COALESCE($7,icon),
         archived = COALESCE($8,archived), updated_at = now() WHERE id = $1`,
      [id, input.name ?? null, input.targetCents ?? null, input.deadline !== undefined, input.deadline ?? null, input.color ?? null, input.icon ?? null, input.archived ?? null],
    );
    await refreshAchieved(q, id);
    await audit(q, { userId: user.id, action: "goal.update", entity: "goal", entityId: id, details: input });
    return loadGoal(q, user, id);
  });
}

export async function deleteGoal(db: Db, user: AuthUser, id: number) {
  return db.tx(async (q) => {
    const g = await loadGoal(q, user, id);
    assertOwner(user, g.ownerId, "esta meta");
    await q.query("DELETE FROM goals WHERE id = $1", [id]);
    await audit(q, { userId: user.id, action: "goal.delete", entity: "goal", entityId: id, details: { name: g.name, savedCents: g.savedCents } });
  });
}

const ContributionInput = z.object({
  amountCents: z.number().int().refine((v) => v !== 0 && Math.abs(v) <= MAX_CENTS, "Valor inválido."),
  date: zDate.optional(),
  note: z.string().trim().max(120).optional().nullable(),
});

export async function contribute(db: Db, user: AuthUser, goalId: number, body: unknown, source: Source = "web") {
  const input = parse(ContributionInput, body);
  return db.tx(async (q) => {
    const g = await loadGoal(q, user, goalId);
    if (g.archived) throw badRequest("Esta meta está arquivada.");
    if (g.scope === "individual") assertOwner(user, g.ownerId, "esta meta");
    else if (user.family_access === "none") throw forbidden();
    if (input.amountCents < 0) {
      // retirada não pode deixar a meta (nem a parte da própria pessoa) negativa
      const mine = g.contributors.find((c) => c.userId === user.id)?.cents ?? 0;
      if (mine + input.amountCents < 0) throw badRequest("A retirada é maior do que o valor que você guardou nesta meta.");
    }
    const { rows } = await q.query<{ id: number }>(
      `INSERT INTO goal_contributions (goal_id, user_id, amount_cents, date, note) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [goalId, user.id, input.amountCents, input.date ?? today(), input.note ?? null],
    );
    await refreshAchieved(q, goalId);
    await audit(q, { userId: user.id, action: "goal.contribute", entity: "goal", entityId: goalId, source, details: { amountCents: input.amountCents } });
    return { id: rows[0].id, goal: await loadGoal(q, user, goalId) };
  });
}

export async function listContributions(q: Queryable, user: AuthUser, goalId: number) {
  await loadGoal(q, user, goalId); // checa visibilidade
  const { rows } = await q.query(
    `SELECT id, user_id AS "userId", amount_cents AS "amountCents", date, note, created_at AS "createdAt"
       FROM goal_contributions WHERE goal_id = $1 ORDER BY date DESC, id DESC LIMIT 200`,
    [goalId],
  );
  return rows;
}

export async function deleteContribution(db: Db, user: AuthUser, goalId: number, contributionId: number) {
  return db.tx(async (q) => {
    await loadGoal(q, user, goalId);
    const { rows } = await q.query<{ user_id: number }>("SELECT user_id FROM goal_contributions WHERE id = $1 AND goal_id = $2", [contributionId, goalId]);
    if (!rows[0]) throw notFound();
    assertOwner(user, rows[0].user_id, "esta contribuição");
    await q.query("DELETE FROM goal_contributions WHERE id = $1", [contributionId]);
    await refreshAchieved(q, goalId);
    await audit(q, { userId: user.id, action: "goal.contribution_delete", entity: "goal", entityId: goalId });
  });
}

async function refreshAchieved(q: Queryable, goalId: number) {
  await q.query(
    `UPDATE goals g SET achieved_at = CASE
        WHEN (SELECT COALESCE(sum(amount_cents),0) FROM goal_contributions c WHERE c.goal_id = g.id) >= g.target_cents
          THEN COALESCE(g.achieved_at, now()) ELSE NULL END
      WHERE g.id = $1`,
    [goalId],
  );
}
