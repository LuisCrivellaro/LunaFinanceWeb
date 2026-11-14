import type { Db, Queryable } from "../db/index.js";
import { DUMMY_HASH, hashPassword, randomToken, sha256, verifyPassword } from "../lib/crypto.js";
import { badRequest, notFound, unauthorized, tooMany } from "../lib/errors.js";
import { now } from "../lib/clock.js";
import type { AuthUser } from "./access.js";
import { audit, type Source } from "./audit.js";

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
export const SESSION_COOKIE = "luna_session";

export function validatePassword(pw: unknown): string {
  if (typeof pw !== "string") throw badRequest("Informe uma senha.");
  if (pw.length < 10) throw badRequest("A senha precisa ter pelo menos 10 caracteres.");
  if (pw.length > 200) throw badRequest("Senha longa demais.");
  if (!/[A-Za-zÀ-ÿ]/.test(pw) || !/\d/.test(pw)) throw badRequest("Use letras e números na senha.");
  return pw;
}

const USER_COLS = "id, name, email, role, family_access, color";

export async function getAuthUser(q: Queryable, id: number): Promise<AuthUser | null> {
  const { rows } = await q.query<AuthUser>(`SELECT ${USER_COLS} FROM users WHERE id = $1 AND active`, [id]);
  return rows[0] ?? null;
}

export async function login(
  db: Db,
  email: string,
  password: string,
  meta: { ip?: string; userAgent?: string },
  sessionDays: number,
): Promise<{ token: string; user: AuthUser; expiresAt: Date }> {
  const { rows } = await db.query<AuthUser & { password_hash: string | null; locked_until: Date | null; active: boolean }>(
    `SELECT ${USER_COLS}, password_hash, locked_until, active FROM users WHERE lower(email) = lower($1)`,
    [email.trim()],
  );
  const u = rows[0];
  if (u?.locked_until && u.locked_until > now()) {
    throw tooMany("Conta temporariamente bloqueada por tentativas incorretas. Tente novamente em alguns minutos.");
  }
  // sempre roda o scrypt — mesmo tempo de resposta exista ou não o e-mail
  const ok = await verifyPassword(password, u?.password_hash ?? DUMMY_HASH);
  if (!u || !u.active || !ok || !u.password_hash) {
    if (u) {
      await db.query(
        `UPDATE users SET failed_logins = failed_logins + 1,
           locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + ($3 || ' minutes')::interval ELSE locked_until END
         WHERE id = $1`,
        [u.id, MAX_FAILED, String(LOCK_MINUTES)],
      );
      await audit(db, { userId: u.id, action: "auth.login_failed", entity: "user", entityId: u.id, ip: meta.ip });
    }
    throw unauthorized("E-mail ou senha incorretos.");
  }
  await db.query("UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1", [u.id]);
  const { token, expiresAt } = await createSession(db, u.id, meta, sessionDays);
  await audit(db, { userId: u.id, action: "auth.login", entity: "user", entityId: u.id, ip: meta.ip });
  const { password_hash: _p, locked_until: _l, active: _a, ...user } = u;
  return { token, user, expiresAt };
}

export async function createSession(q: Queryable, userId: number, meta: { ip?: string; userAgent?: string }, days: number) {
  const token = randomToken(32);
  const expiresAt = new Date(now().getTime() + days * 86400000);
  await q.query(
    `INSERT INTO sessions (id, user_id, expires_at, user_agent, ip) VALUES ($1,$2,$3,$4,$5)`,
    [sha256(token), userId, expiresAt, meta.userAgent?.slice(0, 300) ?? null, meta.ip ?? null],
  );
  return { token, expiresAt };
}

export async function userFromSession(q: Queryable, token: string | undefined): Promise<{ user: AuthUser; sessionId: string } | null> {
  if (!token || token.length > 100) return null;
  const id = sha256(token);
  const { rows } = await q.query<AuthUser & { last_seen_at: Date }>(
    `SELECT u.id, u.name, u.email, u.role, u.family_access, u.color, s.last_seen_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > $2 AND u.active`,
    [id, now()],
  );
  const r = rows[0];
  if (!r) return null;
  // atualiza "visto por último" no máximo a cada 5 min
  if (now().getTime() - new Date(r.last_seen_at).getTime() > 5 * 60000) {
    await q.query("UPDATE sessions SET last_seen_at = now() WHERE id = $1", [id]);
  }
  const { last_seen_at: _ls, ...user } = r;
  return { user, sessionId: id };
}

export async function destroySession(q: Queryable, sessionId: string) {
  await q.query("DELETE FROM sessions WHERE id = $1", [sessionId]);
}

export async function changePassword(db: Db, user: AuthUser, current: string, next: string, keepSessionId: string, ip?: string) {
  validatePassword(next);
  const { rows } = await db.query<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = $1", [user.id]);
  if (!(await verifyPassword(current ?? "", rows[0]?.password_hash ?? null))) throw badRequest("Senha atual incorreta.");
  await db.tx(async (q) => {
    await q.query("UPDATE users SET password_hash = $2, updated_at = now() WHERE id = $1", [user.id, await hashPassword(next)]);
    // encerra as outras sessões
    await q.query("DELETE FROM sessions WHERE user_id = $1 AND id <> $2", [user.id, keepSessionId]);
    await audit(q, { userId: user.id, action: "auth.password_changed", entity: "user", entityId: user.id, ip });
  });
}

// ---------- Links de acesso (definir / redefinir senha) ----------

export async function createAccessLink(
  q: Queryable,
  userId: number,
  purpose: "setup" | "reset",
  createdBy: number | null,
  appUrl: string,
  hours = 72,
): Promise<{ url: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(now().getTime() + hours * 3600000);
  // invalida links anteriores ainda não usados
  await q.query("UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL", [userId]);
  await q.query(
    `INSERT INTO auth_tokens (user_id, token_hash, purpose, expires_at, created_by) VALUES ($1,$2,$3,$4,$5)`,
    [userId, sha256(token), purpose, expiresAt, createdBy],
  );
  return { url: `${appUrl}/definir-senha#t=${token}`, expiresAt };
}

export async function inspectAccessLink(q: Queryable, token: string) {
  const { rows } = await q.query<{ name: string; purpose: string }>(
    `SELECT u.name, t.purpose FROM auth_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = $1 AND t.used_at IS NULL AND t.expires_at > $2 AND u.active`,
    [sha256(token ?? ""), now()],
  );
  if (!rows[0]) throw notFound("Este link expirou ou já foi usado. Peça um novo link.");
  return { name: rows[0].name.split(" ")[0], purpose: rows[0].purpose };
}

export async function consumeAccessLink(db: Db, token: string, password: string, meta: { ip?: string; userAgent?: string }, sessionDays: number) {
  validatePassword(password);
  const hash = await hashPassword(password);
  return db.tx(async (q) => {
    // UPDATE ... RETURNING garante uso único mesmo com cliques simultâneos
    const { rows } = await q.query<{ user_id: number }>(
      `UPDATE auth_tokens SET used_at = now()
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2
        RETURNING user_id`,
      [sha256(token ?? ""), now()],
    );
    if (!rows[0]) throw notFound("Este link expirou ou já foi usado. Peça um novo link.");
    const userId = rows[0].user_id;
    await q.query("UPDATE users SET password_hash = $2, failed_logins = 0, locked_until = NULL, updated_at = now() WHERE id = $1", [userId, hash]);
    await q.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
    const session = await createSession(q, userId, meta, sessionDays);
    await audit(q, { userId, action: "auth.password_set", entity: "user", entityId: userId, ip: meta.ip });
    const user = await getAuthUser(q, userId);
    return { ...session, user: user! };
  });
}

export async function revokeAllSessions(q: Queryable, userId: number, by: number, source: Source = "web") {
  await q.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
  await audit(q, { userId: by, action: "auth.sessions_revoked", entity: "user", entityId: userId, source });
}
