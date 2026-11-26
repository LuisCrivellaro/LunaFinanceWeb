/**
 * Identidade na integração OpenBot/WhatsApp — três camadas, todas no servidor:
 *
 * 1. Credencial da integração (Authorization: Bearer lfo_…): identifica a
 *    instalação do OpenBot. Revogável, com escopos, só o hash é guardado.
 * 2. Vínculo do WhatsApp: cada pessoa liga o PRÓPRIO número por um código de
 *    uso único gerado no site (logada com senha), ou quem gerencia a família
 *    liga pelo painel. O número fica normalizado em E.164.
 * 3. Sessão da pessoa (X-Luna-Session): aberta com o número + PIN pessoal.
 *
 * Por que o PIN: na documentação e no código do OpenBot, o remetente real
 * (authorId, definido pela plataforma a partir do protocolo do WhatsApp) chega
 * ao AGENTE, mas a chamada à nossa API é feita pelo próprio agente de IA —
 * não há campo assinado pela plataforma que prove ao servidor quem escreveu.
 * Um texto malicioso poderia induzir o agente a informar outro número. O PIN
 * (que só a pessoa sabe) fecha essa porta: sem ele não há sessão, e sem sessão
 * não há operação financeira. Ver integrations/openbot/SETUP.md.
 */
import type { Db, Queryable } from "../../db/index.js";
import { now } from "../../lib/clock.js";
import { hashPassword, humanCode, randomToken, sha256, verifyPassword } from "../../lib/crypto.js";
import { badRequest, conflict, forbidden, HttpError, notFound, tooMany, unauthorized } from "../../lib/errors.js";
import { assertCanManageFamily, type AuthUser } from "../../services/access.js";
import { audit } from "../../services/audit.js";
import { getAuthUser } from "../../services/auth.js";
import { maskPhone, normalizePhone, phoneVariants } from "../phone.js";

export const SCOPES = ["link", "read", "write", "notifications"] as const;
export type Scope = (typeof SCOPES)[number];

export const LINK_CODE_TTL_MIN = 10;
export const PIN_MAX_FAILURES = 5;
export const PIN_LOCK_MIN = 15;

// ------------------------------ configuração ------------------------------

export interface IntegrationSettings {
  enabled: boolean;
  autoConfirm: boolean;
  pinRequired: boolean;
  sessionHours: number;
  updatedAt: Date;
}

export async function getSettings(q: Queryable): Promise<IntegrationSettings> {
  const { rows } = await q.query<{ enabled: boolean; auto_confirm: boolean; pin_required: boolean; session_hours: number; updated_at: Date }>(
    "SELECT enabled, auto_confirm, pin_required, session_hours, updated_at FROM integration_settings WHERE provider = 'openbot'",
  );
  const r = rows[0];
  return {
    enabled: Boolean(r?.enabled),
    autoConfirm: Boolean(r?.auto_confirm),
    pinRequired: r ? r.pin_required : true,
    sessionHours: r?.session_hours ?? 12,
    updatedAt: r?.updated_at ?? new Date(0),
  };
}

export async function updateSettings(db: Db, actor: AuthUser, body: Record<string, unknown>) {
  assertCanManageFamily(actor);
  const sets: string[] = [];
  const vals: unknown[] = [];
  const put = (col: string, v: unknown) => {
    vals.push(v);
    sets.push(`${col} = $${vals.length}`);
  };
  if (body.enabled !== undefined) put("enabled", Boolean(body.enabled));
  if (body.autoConfirm !== undefined) put("auto_confirm", Boolean(body.autoConfirm));
  if (body.pinRequired !== undefined) put("pin_required", Boolean(body.pinRequired));
  if (body.sessionHours !== undefined) {
    const h = Number(body.sessionHours);
    if (!Number.isInteger(h) || h < 1 || h > 72) throw badRequest("Duração da sessão: de 1 a 72 horas.");
    put("session_hours", h);
  }
  if (!sets.length) return getSettings(db);
  vals.push(actor.id);
  await db.tx(async (q) => {
    await q.query(`UPDATE integration_settings SET ${sets.join(", ")}, updated_by = $${vals.length}, updated_at = now() WHERE provider = 'openbot'`, vals);
    // desligar a integração derruba todas as sessões na hora
    if (body.enabled === false) await q.query("UPDATE integration_sessions SET revoked_at = now() WHERE revoked_at IS NULL");
    // exigir PIN de novo invalida sessões abertas sem PIN
    if (body.pinRequired === true) await q.query("UPDATE integration_sessions SET revoked_at = now() WHERE revoked_at IS NULL");
    await audit(q, { userId: actor.id, action: "integration.settings", entity: "integration", details: { fields: Object.keys(body) } });
  });
  return getSettings(db);
}

// ------------------------------ credenciais ------------------------------

export interface Credential {
  id: number;
  name: string;
  scopes: Scope[];
}

export async function createCredential(db: Db, actor: AuthUser, body: { name?: unknown; scopes?: unknown }) {
  assertCanManageFamily(actor);
  const name = String(body.name ?? "OpenBot").trim().slice(0, 60) || "OpenBot";
  const requested = Array.isArray(body.scopes) ? body.scopes.map(String) : [...SCOPES];
  const scopes = requested.filter((s): s is Scope => (SCOPES as readonly string[]).includes(s));
  if (!scopes.length) throw badRequest("Escolha ao menos uma permissão.");
  const prefix = randomToken(6).replace(/[-_]/g, "x").slice(0, 8);
  const key = `lfo_${prefix}_${randomToken(32)}`;
  const { rows } = await db.query<{ id: number; created_at: Date }>(
    `INSERT INTO integration_credentials (name, key_hash, key_prefix, scopes, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
    [name, sha256(key), prefix, scopes, actor.id],
  );
  await audit(db, { userId: actor.id, action: "integration.credential_create", entity: "integration_credential", entityId: rows[0].id, details: { scopes } });
  // a chave completa só aparece AGORA; o banco guarda apenas o hash
  return { id: rows[0].id, name, prefix, scopes, createdAt: rows[0].created_at, key };
}

export async function listCredentials(q: Queryable) {
  const { rows } = await q.query(
    `SELECT id, name, key_prefix AS prefix, scopes, created_at AS "createdAt", last_used_at AS "lastUsedAt", revoked_at AS "revokedAt"
       FROM integration_credentials ORDER BY revoked_at NULLS FIRST, id DESC`,
  );
  return rows;
}

export async function revokeCredential(db: Db, actor: AuthUser, id: number) {
  assertCanManageFamily(actor);
  await db.tx(async (q) => {
    const r = await q.query("UPDATE integration_credentials SET revoked_at = now(), revoked_by = $2 WHERE id = $1 AND revoked_at IS NULL", [id, actor.id]);
    if (!r.rowCount) throw notFound();
    await q.query("UPDATE integration_sessions SET revoked_at = now() WHERE credential_id = $1 AND revoked_at IS NULL", [id]);
    await audit(q, { userId: actor.id, action: "integration.credential_revoke", entity: "integration_credential", entityId: id });
  });
}

/** Valida o Bearer. Revogada ou desconhecida → null (sem dizer qual). */
export async function credentialFromKey(q: Queryable, key: string): Promise<Credential | null> {
  if (!/^lfo_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{40,}$/.test(key)) return null;
  const { rows } = await q.query<{ id: number; name: string; scopes: Scope[] }>(
    "SELECT id, name, scopes FROM integration_credentials WHERE key_hash = $1 AND revoked_at IS NULL",
    [sha256(key)],
  );
  if (!rows[0]) return null;
  await q.query("UPDATE integration_credentials SET last_used_at = now() WHERE id = $1", [rows[0].id]);
  return rows[0];
}

// ------------------------------ vínculo do WhatsApp ------------------------------

export function requirePhone(input: unknown): string {
  const p = normalizePhone(input);
  if (!p) throw badRequest("Telefone inválido. Use o formato internacional, ex.: +55 11 98765-4321.");
  return p;
}

async function linkedUserId(q: Queryable, phone: string): Promise<{ userId: number; phone: string } | null> {
  const { rows } = await q.query<{ user_id: number; phone_e164: string }>(
    "SELECT user_id, phone_e164 FROM whatsapp_links WHERE phone_e164 = ANY($1::text[])",
    [phoneVariants(phone)],
  );
  return rows[0] ? { userId: rows[0].user_id, phone: rows[0].phone_e164 } : null;
}

/** A própria pessoa (logada no site) gera um código para ligar o SEU número. */
export async function createLinkCode(db: Db, user: AuthUser, phoneInput: unknown) {
  const phone = requirePhone(phoneInput);
  const other = await linkedUserId(db, phone);
  if (other && other.userId !== user.id) throw conflict("Este número já está vinculado a outra pessoa da família.");
  const code = humanCode(8);
  const expiresAt = new Date(now().getTime() + LINK_CODE_TTL_MIN * 60000);
  await db.tx(async (q) => {
    // só um código válido por vez
    await q.query("UPDATE whatsapp_link_codes SET used_at = now() WHERE user_id = $1 AND used_at IS NULL", [user.id]);
    await q.query("INSERT INTO whatsapp_link_codes (code_hash, user_id, phone_e164, expires_at) VALUES ($1,$2,$3,$4)", [sha256(code), user.id, phone, expiresAt]);
    await audit(q, { userId: user.id, action: "whatsapp.link_code", entity: "user", entityId: user.id });
  });
  return { code, expiresAt, phoneMasked: maskPhone(phone) };
}

/**
 * O OpenBot apresenta o código recebido do número `phone`. Só vincula se o
 * código for válido, não usado, não expirado E emitido para ESSE número.
 */
export async function claimLink(db: Db, phoneInput: unknown, codeInput: unknown) {
  const phone = requirePhone(phoneInput);
  const code = String(codeInput ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== 8) throw badRequest("Código inválido.");
  return db.tx(async (q) => {
    const { rows } = await q.query<{ user_id: number; phone_e164: string; expires_at: Date; used_at: Date | null }>(
      "SELECT user_id, phone_e164, expires_at, used_at FROM whatsapp_link_codes WHERE code_hash = $1 FOR UPDATE",
      [sha256(code)],
    );
    const c = rows[0];
    // mesma resposta para código inexistente, usado, vencido ou de outro número
    const generic = new HttpError(400, "Código inválido ou expirado. Gere outro no site.", "invalid_code");
    if (!c || c.used_at || c.expires_at < now() || !phoneVariants(phone).includes(c.phone_e164)) throw generic;
    const user = await getAuthUser(q, c.user_id);
    if (!user) throw generic;
    await q.query("UPDATE whatsapp_link_codes SET used_at = now() WHERE code_hash = $1", [sha256(code)]);
    const other = await linkedUserId(q, c.phone_e164);
    if (other && other.userId !== user.id) throw conflict("Este número já está vinculado a outra pessoa da família.");
    await q.query(
      `INSERT INTO whatsapp_links (user_id, phone_e164, linked_via, linked_by) VALUES ($1,$2,'code',$1)
       ON CONFLICT (user_id) DO UPDATE SET phone_e164 = EXCLUDED.phone_e164, linked_via = 'code', linked_by = $1, linked_at = now()`,
      [user.id, c.phone_e164],
    );
    // trocar de número derruba sessões antigas
    await q.query("UPDATE integration_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [user.id]);
    await audit(q, { userId: user.id, action: "whatsapp.linked", entity: "user", entityId: user.id, source: "whatsapp" });
    return { userId: user.id, name: user.name, pinSet: await hasPin(q, user.id) };
  });
}

/** Configuração administrativa autorizada (quem gerencia a família, logado no site). */
export async function adminLink(db: Db, actor: AuthUser, userId: number, phoneInput: unknown) {
  assertCanManageFamily(actor);
  const phone = requirePhone(phoneInput);
  const target = await getAuthUser(db, userId);
  if (!target) throw notFound();
  const other = await linkedUserId(db, phone);
  if (other && other.userId !== userId) throw conflict("Este número já está vinculado a outra pessoa da família.");
  await db.tx(async (q) => {
    await q.query(
      `INSERT INTO whatsapp_links (user_id, phone_e164, linked_via, linked_by) VALUES ($1,$2,'admin',$3)
       ON CONFLICT (user_id) DO UPDATE SET phone_e164 = EXCLUDED.phone_e164, linked_via = 'admin', linked_by = $3, linked_at = now()`,
      [userId, phone, actor.id],
    );
    await q.query("UPDATE integration_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
    await audit(q, { userId: actor.id, action: "whatsapp.admin_link", entity: "user", entityId: userId });
  });
  return { phoneMasked: maskPhone(phone) };
}

/** Desvincula e encerra todas as sessões da pessoa — efeito imediato. */
export async function unlink(db: Db, actor: AuthUser, userId: number) {
  if (actor.id !== userId) assertCanManageFamily(actor);
  await db.tx(async (q) => {
    await q.query("DELETE FROM whatsapp_links WHERE user_id = $1", [userId]);
    await q.query("UPDATE integration_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
    await q.query("UPDATE whatsapp_link_codes SET used_at = now() WHERE user_id = $1 AND used_at IS NULL", [userId]);
    await q.query("UPDATE telegram_pending_actions SET status = 'cancelled' WHERE user_id = $1 AND channel = 'whatsapp' AND status = 'pending'", [userId]);
    await audit(q, { userId: actor.id, action: "whatsapp.unlinked", entity: "user", entityId: userId });
  });
}

export async function revokeSessions(db: Db, actor: AuthUser, userId: number) {
  if (actor.id !== userId) assertCanManageFamily(actor);
  const r = await db.query("UPDATE integration_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
  await audit(db, { userId: actor.id, action: "whatsapp.sessions_revoked", entity: "user", entityId: userId });
  return r.rowCount;
}

// ------------------------------ PIN ------------------------------

async function hasPin(q: Queryable, userId: number) {
  const { rows } = await q.query<{ h: string | null }>("SELECT channel_pin_hash AS h FROM users WHERE id = $1", [userId]);
  return Boolean(rows[0]?.h);
}

/** A pessoa define o próprio PIN no site, confirmando a senha. */
export async function setPin(db: Db, user: AuthUser, pin: unknown, password: unknown) {
  const p = String(pin ?? "");
  if (!/^\d{6,8}$/.test(p)) throw badRequest("O PIN deve ter de 6 a 8 dígitos.");
  if (/^(\d)\1+$/.test(p) || "0123456789".includes(p) || "9876543210".includes(p)) throw badRequest("Escolha um PIN menos óbvio (sem sequências ou dígitos repetidos).");
  const { rows } = await db.query<{ password_hash: string | null }>("SELECT password_hash FROM users WHERE id = $1", [user.id]);
  if (!(await verifyPassword(String(password ?? ""), rows[0]?.password_hash ?? null))) throw new HttpError(400, "Senha atual incorreta.", "bad_password");
  await db.tx(async (q) => {
    await q.query("UPDATE users SET channel_pin_hash = $2, channel_pin_failed = 0, channel_pin_locked_until = NULL WHERE id = $1", [user.id, await hashPassword(p)]);
    await q.query("UPDATE integration_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [user.id]);
    await audit(q, { userId: user.id, action: "whatsapp.pin_set", entity: "user", entityId: user.id });
  });
}

export async function resetPin(db: Db, actor: AuthUser, userId: number) {
  if (actor.id !== userId) assertCanManageFamily(actor);
  await db.tx(async (q) => {
    await q.query("UPDATE users SET channel_pin_hash = NULL, channel_pin_failed = 0, channel_pin_locked_until = NULL WHERE id = $1", [userId]);
    await q.query("UPDATE integration_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
    await audit(q, { userId: actor.id, action: "whatsapp.pin_reset", entity: "user", entityId: userId });
  });
}

// ------------------------------ sessões ------------------------------

export interface MemberSession {
  sessionId: string;
  user: AuthUser;
  phone: string;
  credentialId: number;
}

/**
 * Abre a sessão de uma pessoa: número vinculado + PIN (quando exigido).
 * Bloqueio após 5 PINs errados por 15 minutos.
 */
export async function openSession(db: Db, cred: Credential, phoneInput: unknown, pinInput: unknown) {
  const settings = await getSettings(db);
  const phone = requirePhone(phoneInput);
  const link = await linkedUserId(db, phone);
  // número desconhecido: resposta neutra (não revela quem está vinculado)
  if (!link) throw new HttpError(403, "Número não autorizado. Peça o código de vinculação no site do Luna.", "not_linked");
  const { rows } = await db.query<{ channel_pin_hash: string | null; channel_pin_failed: number; channel_pin_locked_until: Date | null; active: boolean }>(
    "SELECT channel_pin_hash, channel_pin_failed, channel_pin_locked_until, active FROM users WHERE id = $1",
    [link.userId],
  );
  const u = rows[0];
  if (!u?.active) throw new HttpError(403, "Número não autorizado. Peça o código de vinculação no site do Luna.", "not_linked");
  if (settings.pinRequired) {
    if (!u.channel_pin_hash) throw new HttpError(403, "Defina seu PIN do WhatsApp no site do Luna (Configurações → Integrações).", "pin_not_set");
    if (u.channel_pin_locked_until && u.channel_pin_locked_until > now()) throw tooMany("PIN bloqueado por excesso de tentativas. Aguarde 15 minutos.");
    const ok = await verifyPassword(String(pinInput ?? ""), u.channel_pin_hash);
    if (!ok) {
      const failed = u.channel_pin_failed + 1;
      const lock = failed >= PIN_MAX_FAILURES ? new Date(now().getTime() + PIN_LOCK_MIN * 60000) : null;
      await db.query("UPDATE users SET channel_pin_failed = $2, channel_pin_locked_until = $3 WHERE id = $1", [link.userId, lock ? 0 : failed, lock]);
      await audit(db, { userId: link.userId, action: "whatsapp.pin_failed", entity: "user", entityId: link.userId, source: "whatsapp" });
      throw new HttpError(401, "PIN incorreto.", "invalid_pin");
    }
  }
  const token = `lfs_${randomToken(32)}`;
  const expiresAt = new Date(now().getTime() + settings.sessionHours * 3600000);
  await db.tx(async (q) => {
    await q.query("UPDATE users SET channel_pin_failed = 0, channel_pin_locked_until = NULL WHERE id = $1", [link.userId]);
    await q.query(
      "INSERT INTO integration_sessions (id, user_id, credential_id, phone_e164, expires_at) VALUES ($1,$2,$3,$4,$5)",
      [sha256(token), link.userId, cred.id, link.phone, expiresAt],
    );
    await q.query("UPDATE whatsapp_links SET last_seen_at = now() WHERE user_id = $1", [link.userId]);
    await audit(q, { userId: link.userId, action: "whatsapp.session_open", entity: "user", entityId: link.userId, source: "whatsapp" });
  });
  const user = (await getAuthUser(db, link.userId))!;
  return { sessionToken: token, expiresAt, user };
}

/**
 * Valida a sessão a cada chamada: não revogada, não vencida, mesma credencial,
 * pessoa ativa, número ainda vinculado e igual ao remetente informado.
 */
export async function resolveSession(db: Db, cred: Credential, token: string | undefined, sender: string | undefined): Promise<MemberSession> {
  if (!token || !/^lfs_[A-Za-z0-9_-]{40,}$/.test(token)) throw new HttpError(401, "Sessão ausente. Abra uma sessão com o PIN.", "session_required");
  const senderPhone = normalizePhone(sender ?? "");
  if (!senderPhone) throw new HttpError(400, "Cabeçalho X-Luna-Sender ausente ou inválido.", "sender_required");
  const id = sha256(token);
  const { rows } = await db.query<{ user_id: number; credential_id: number; phone_e164: string; expires_at: Date; revoked_at: Date | null; linked_phone: string | null }>(
    `SELECT s.user_id, s.credential_id, s.phone_e164, s.expires_at, s.revoked_at, l.phone_e164 AS linked_phone
       FROM integration_sessions s LEFT JOIN whatsapp_links l ON l.user_id = s.user_id WHERE s.id = $1`,
    [id],
  );
  const s = rows[0];
  const expired = new HttpError(401, "Sessão expirada ou encerrada. Abra outra com o PIN.", "session_expired");
  if (!s || s.revoked_at || s.expires_at < now() || s.credential_id !== cred.id || s.linked_phone !== s.phone_e164) throw expired;
  // a sessão de uma pessoa nunca atende outro remetente
  if (!phoneVariants(senderPhone).includes(s.phone_e164)) throw forbidden("A sessão não pertence a este remetente.");
  const user = await getAuthUser(db, s.user_id);
  if (!user) throw expired;
  await db.query("UPDATE integration_sessions SET last_used_at = now() WHERE id = $1", [id]);
  await db.query("UPDATE whatsapp_links SET last_seen_at = now() WHERE user_id = $1", [s.user_id]);
  return { sessionId: id, user, phone: s.phone_e164, credentialId: cred.id };
}

export async function closeSession(db: Db, s: MemberSession) {
  await db.query("UPDATE integration_sessions SET revoked_at = now() WHERE id = $1", [s.sessionId]);
}

// ------------------------------ status por pessoa ------------------------------

export async function myWhatsApp(q: Queryable, user: AuthUser) {
  const { rows } = await q.query<{ phone_e164: string | null; linked_at: Date | null; last_seen_at: Date | null; linked_via: string | null; pin: string | null; sessions: number }>(
    `SELECT l.phone_e164, l.linked_at, l.last_seen_at, l.linked_via, u.channel_pin_hash AS pin,
            (SELECT count(*)::int FROM integration_sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS sessions
       FROM users u LEFT JOIN whatsapp_links l ON l.user_id = u.id WHERE u.id = $1`,
    [user.id],
  );
  const r = rows[0];
  return {
    linked: Boolean(r?.phone_e164),
    phoneMasked: maskPhone(r?.phone_e164),
    linkedAt: r?.linked_at ?? null,
    linkedVia: r?.linked_via ?? null,
    lastSeenAt: r?.last_seen_at ?? null,
    pinSet: Boolean(r?.pin),
    activeSessions: r?.sessions ?? 0,
  };
}

export { unauthorized };
