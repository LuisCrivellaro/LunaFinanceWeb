/**
 * Vinculação segura Luna Finance ↔ Telegram.
 *
 * 1. A pessoa, LOGADA no site, gera um código de uso único (válido por 10 min).
 * 2. No Telegram (chat privado) ela abre o deep link ou envia /vincular CÓDIGO.
 * 3. O backend associa o `from.id` do Telegram à conta dona do código.
 *
 * Conhecer o nome de alguém não dá acesso a nada: sem o código gerado na
 * sessão autenticada da pessoa, não há vínculo. O código é guardado só como
 * hash e há limite de tentativas por usuário do Telegram.
 */
import type { Db, Queryable } from "../db/index.js";
import { humanCode, sha256 } from "../lib/crypto.js";
import { now } from "../lib/clock.js";
import type { AuthUser } from "../services/access.js";
import { audit, type Source } from "../services/audit.js";

export const LINK_CODE_TTL_MIN = 10;
const MAX_FAILED_ATTEMPTS = 5;
const ATTEMPT_WINDOW_MIN = 15;

export async function createLinkCode(db: Db, user: AuthUser, botUsername: string) {
  const code = humanCode(8);
  const expiresAt = new Date(now().getTime() + LINK_CODE_TTL_MIN * 60000);
  await db.tx(async (q) => {
    await q.query("UPDATE telegram_link_codes SET used_at = now() WHERE user_id = $1 AND used_at IS NULL", [user.id]);
    await q.query("INSERT INTO telegram_link_codes (user_id, code_hash, expires_at) VALUES ($1,$2,$3)", [user.id, sha256(code), expiresAt]);
    await audit(q, { userId: user.id, action: "telegram.link_code_created", entity: "user", entityId: user.id });
  });
  return {
    code,
    expiresAt,
    deepLink: botUsername ? `https://t.me/${botUsername}?start=link_${code}` : null,
  };
}

export type LinkResult =
  | { ok: true; userId: number; name: string }
  | { ok: false; reason: "rate_limited" | "invalid" };

export async function consumeLinkCode(
  db: Db,
  tg: { telegramUserId: number; chatId: number; username?: string; firstName?: string },
  rawCode: string,
): Promise<LinkResult> {
  const code = rawCode.trim().toUpperCase().replace(/^LINK_/, "").replace(/[^A-Z0-9]/g, "");
  const since = new Date(now().getTime() - ATTEMPT_WINDOW_MIN * 60000);
  const { rows: att } = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM telegram_link_attempts WHERE telegram_user_id = $1 AND NOT success AND created_at > $2",
    [tg.telegramUserId, since],
  );
  if (att[0].n >= MAX_FAILED_ATTEMPTS) return { ok: false, reason: "rate_limited" };

  const result = await db.tx(async (q) => {
    const { rows } = await q.query<{ user_id: number }>(
      `UPDATE telegram_link_codes SET used_at = now()
        WHERE code_hash = $1 AND used_at IS NULL AND expires_at > $2
          AND user_id IN (SELECT id FROM users WHERE active)
        RETURNING user_id`,
      [sha256(code), now()],
    );
    if (!rows[0]) return null;
    const userId = rows[0].user_id;
    // um Telegram ↔ uma conta: remove vínculos antigos dos dois lados
    await q.query("DELETE FROM telegram_links WHERE user_id = $1 OR telegram_user_id = $2", [userId, tg.telegramUserId]);
    await q.query(
      `INSERT INTO telegram_links (user_id, telegram_user_id, chat_id, username, first_name) VALUES ($1,$2,$3,$4,$5)`,
      [userId, tg.telegramUserId, tg.chatId, tg.username ?? null, tg.firstName ?? null],
    );
    await audit(q, { userId, action: "telegram.linked", entity: "user", entityId: userId, source: "telegram" });
    const { rows: u } = await q.query<{ name: string }>("SELECT name FROM users WHERE id = $1", [userId]);
    return { userId, name: u[0].name };
  });
  await db.query("INSERT INTO telegram_link_attempts (telegram_user_id, success) VALUES ($1,$2)", [tg.telegramUserId, Boolean(result)]);
  if (!result) return { ok: false, reason: "invalid" };
  return { ok: true, ...result };
}

export async function unlinkTelegram(q: Queryable, userId: number, source: Source) {
  await q.query("DELETE FROM telegram_links WHERE user_id = $1", [userId]);
  await audit(q, { userId, action: "telegram.unlinked", entity: "user", entityId: userId, source });
}

/** Resolve quem está falando a partir do ID do Telegram (nunca pelo nome). */
export async function userByTelegramId(q: Queryable, telegramUserId: number): Promise<(AuthUser & { chatId: number }) | null> {
  const { rows } = await q.query<AuthUser & { chatId: number }>(
    `SELECT u.id, u.name, u.email, u.role, u.family_access, u.color, l.chat_id AS "chatId"
       FROM telegram_links l JOIN users u ON u.id = l.user_id
      WHERE l.telegram_user_id = $1 AND u.active`,
    [telegramUserId],
  );
  return rows[0] ?? null;
}
