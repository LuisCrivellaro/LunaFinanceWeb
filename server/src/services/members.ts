import type { Db, Queryable } from "../db/index.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { assertCanManageFamily, canManageFamily, type AuthUser } from "./access.js";
import { audit } from "./audit.js";
import { createAccessLink, revokeAllSessions } from "./auth.js";

/** Cor de cada pessoa — mesma "importância" visual para todos. */
export const MEMBER_PALETTE = ["#4F6BED", "#2F9E7A", "#D9822B", "#B5508A", "#3A8FB7", "#8A6FDB"];

/**
 * Formato público de um integrante. Propositalmente SEM `role`:
 * nenhuma tela recebe a informação de quem gerencia o sistema.
 */
export interface PublicMember {
  id: number;
  name: string;
  color: string;
  telegramLinked: boolean;
}

export async function listMembers(q: Queryable): Promise<PublicMember[]> {
  // Ordem alfabética: nenhuma posição de destaque.
  const { rows } = await q.query<PublicMember>(
    `SELECT u.id, u.name, u.color, (t.user_id IS NOT NULL) AS "telegramLinked"
       FROM users u LEFT JOIN telegram_links t ON t.user_id = u.id
      WHERE u.active ORDER BY lower(u.name)`,
  );
  return rows;
}

export async function getProfile(q: Queryable, user: AuthUser) {
  const { rows } = await q.query(
    `SELECT u.id, u.name, u.email, u.color, u.family_access AS "familyAccess",
            u.notify_due_days AS "notifyDueDays", u.notify_overdue AS "notifyOverdue",
            u.notify_daily AS "notifyDaily", u.notify_weekly AS "notifyWeekly",
            u.notify_goals AS "notifyGoals", u.notify_anomaly AS "notifyAnomaly",
            t.username AS "telegramUsername", t.linked_at AS "telegramLinkedAt"
       FROM users u LEFT JOIN telegram_links t ON t.user_id = u.id WHERE u.id = $1`,
    [user.id],
  );
  return {
    ...rows[0],
    // Capacidade usada só para exibir a área de membros nas configurações.
    // Não há rótulo, selo ou texto associado a isso na interface.
    capabilities: { manageMembers: canManageFamily(user) },
  };
}

const HEX = /^#[0-9a-fA-F]{6}$/;

export async function updateProfile(q: Queryable, user: AuthUser, body: Record<string, unknown>) {
  const sets: string[] = [];
  const vals: unknown[] = [user.id];
  const put = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (name.length < 2 || name.length > 40) throw badRequest("Nome deve ter entre 2 e 40 caracteres.");
    put("name", name);
  }
  if (body.color !== undefined) {
    if (!HEX.test(String(body.color))) throw badRequest("Cor inválida.");
    put("color", body.color);
  }
  if (body.notifyDueDays !== undefined) {
    const n = Number(body.notifyDueDays);
    if (!Number.isInteger(n) || n < 0 || n > 15) throw badRequest("Antecedência deve ser de 0 a 15 dias.");
    put("notify_due_days", n);
  }
  for (const [key, col] of [
    ["notifyOverdue", "notify_overdue"],
    ["notifyDaily", "notify_daily"],
    ["notifyWeekly", "notify_weekly"],
    ["notifyGoals", "notify_goals"],
    ["notifyAnomaly", "notify_anomaly"],
  ] as const) {
    if (body[key] !== undefined) put(col, Boolean(body[key]));
  }
  if (!sets.length) return;
  await q.query(`UPDATE users SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, vals);
  await audit(q, { userId: user.id, action: "profile.update", entity: "user", entityId: user.id, details: { fields: Object.keys(body) } });
}

// ----------- Gestão de membros (somente quem gerencia o sistema) -----------

export async function listMembersForManagement(q: Queryable, actor: AuthUser) {
  assertCanManageFamily(actor);
  // Mesmo aqui, nenhum campo `role` é devolvido.
  const { rows } = await q.query(
    `SELECT u.id, u.name, u.email, u.color, u.family_access AS "familyAccess", u.active,
            (u.password_hash IS NOT NULL) AS "hasPassword", (t.user_id IS NOT NULL) AS "telegramLinked",
            (SELECT max(last_seen_at) FROM sessions s WHERE s.user_id = u.id) AS "lastSeenAt"
       FROM users u LEFT JOIN telegram_links t ON t.user_id = u.id ORDER BY lower(u.name)`,
  );
  return rows;
}

export async function createMember(db: Db, actor: AuthUser | null, input: { name: string; email: string; color?: string; familyAccess?: string; role?: "admin" | "member" }, appUrl: string) {
  if (actor) assertCanManageFamily(actor);
  const name = String(input.name ?? "").trim();
  const email = String(input.email ?? "").trim().toLowerCase();
  if (name.length < 2) throw badRequest("Informe o nome.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw badRequest("E-mail inválido.");
  const access = input.familyAccess ?? "full";
  if (!["none", "summary", "full"].includes(access)) throw badRequest("Permissão inválida.");
  return db.tx(async (q) => {
    const exists = await q.query("SELECT 1 FROM users WHERE lower(email) = $1", [email]);
    if (exists.rows.length) throw conflict("Já existe alguém com este e-mail.");
    const { rows: countRows } = await q.query<{ n: number }>("SELECT count(*)::int AS n FROM users");
    const color = input.color && HEX.test(input.color) ? input.color : MEMBER_PALETTE[countRows[0].n % MEMBER_PALETTE.length];
    const { rows } = await q.query<{ id: number }>(
      `INSERT INTO users (name, email, color, family_access, role) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [name, email, color, access, input.role ?? "member"],
    );
    const id = rows[0].id;
    await q.query(`INSERT INTO accounts (owner_id, name, type, is_default) VALUES ($1, 'Conta principal', 'checking', TRUE)`, [id]);
    const link = await createAccessLink(q, id, "setup", actor?.id ?? null, appUrl);
    await audit(q, { userId: actor?.id ?? null, action: "member.create", entity: "user", entityId: id, source: actor ? "web" : "cli" });
    return { id, ...link };
  });
}

export async function updateMemberAccess(db: Db, actor: AuthUser, memberId: number, body: { familyAccess?: string; active?: boolean }) {
  assertCanManageFamily(actor);
  const target = await db.query<{ id: number }>("SELECT id FROM users WHERE id = $1", [memberId]);
  if (!target.rows[0]) throw notFound();
  await db.tx(async (q) => {
    if (body.familyAccess !== undefined) {
      if (!["none", "summary", "full"].includes(body.familyAccess)) throw badRequest("Permissão inválida.");
      await q.query("UPDATE users SET family_access = $2, updated_at = now() WHERE id = $1", [memberId, body.familyAccess]);
    }
    if (body.active !== undefined) {
      if (memberId === actor.id && body.active === false) throw badRequest("Você não pode desativar a própria conta.");
      await q.query("UPDATE users SET active = $2, updated_at = now() WHERE id = $1", [memberId, Boolean(body.active)]);
      if (!body.active) {
        await revokeAllSessions(q, memberId, actor.id);
        await q.query("DELETE FROM telegram_links WHERE user_id = $1", [memberId]);
      }
    }
    await audit(q, { userId: actor.id, action: "member.update_access", entity: "user", entityId: memberId, details: body });
  });
}

export async function issueResetLink(db: Db, actor: AuthUser, memberId: number, appUrl: string) {
  assertCanManageFamily(actor);
  const t = await db.query<{ id: number }>("SELECT id FROM users WHERE id = $1 AND active", [memberId]);
  if (!t.rows[0]) throw notFound();
  return db.tx(async (q) => {
    const link = await createAccessLink(q, memberId, "reset", actor.id, appUrl, 24);
    await audit(q, { userId: actor.id, action: "member.reset_link", entity: "user", entityId: memberId });
    return link;
  });
}
