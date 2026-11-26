/**
 * Painel da integração (Configurações → Integrações). Diferencia:
 *   - status da API: integração ligada, credencial ativa, últimas chamadas;
 *   - status do WhatsApp: o Luna NÃO enxerga a conexão do WhatsApp (ela vive no
 *     OpenBot). A única evidência real é uma pessoa vinculada ter usado uma
 *     sessão válida — é isso que mostramos, sem fingir "conectado".
 * Telefones saem mascarados; nada de valores financeiros no histórico.
 */
import type { Db } from "../../db/index.js";
import { now } from "../../lib/clock.js";
import { queueCounts } from "../../notifications/queue.js";
import { getCardSettings } from "../../services/cards.js";
import { maskPhone } from "../phone.js";
import { getSettings, listCredentials } from "./identity.js";

const RELATION: Record<string, string> = { luis: "Pai", luciana: "Mãe", lipe: "Filho 1", joao: "Filho 2" };
const first = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase().split(/\s+/)[0] ?? "";

export async function integrationOverview(db: Db) {
  const settings = await getSettings(db);
  const credentials = await listCredentials(db);
  const active = credentials.filter((c) => !(c as { revokedAt: Date | null }).revokedAt);
  const { rows: ev } = await db.query<{ last_ok: Date | null; last_err: Date | null; last_any: Date | null }>(
    `SELECT max(created_at) FILTER (WHERE outcome = 'ok') AS last_ok,
            max(created_at) FILTER (WHERE outcome <> 'ok') AS last_err,
            max(created_at) AS last_any FROM integration_events`,
  );
  const { rows: members } = await db.query<{
    id: number; name: string; phone_e164: string | null; linked_via: string | null; linked_at: Date | null; last_seen_at: Date | null;
    pin: string | null; locked: Date | null; sessions: number;
  }>(
    `SELECT u.id, u.name, l.phone_e164, l.linked_via, l.linked_at, l.last_seen_at, u.channel_pin_hash AS pin, u.channel_pin_locked_until AS locked,
            (SELECT count(*)::int FROM integration_sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS sessions
       FROM users u LEFT JOIN whatsapp_links l ON l.user_id = u.id WHERE u.active ORDER BY lower(u.name)`,
  );
  const { rows: events } = await db.query(
    `SELECT e.id, e.operation, e.outcome, e.status, e.error_code AS "errorCode", e.duration_ms AS "durationMs", e.created_at AS "createdAt", u.name AS "memberName"
       FROM integration_events e LEFT JOIN users u ON u.id = e.user_id ORDER BY e.id DESC LIMIT 50`,
  );
  const lastSeen = members.reduce<Date | null>((m, r) => (r.last_seen_at && (!m || r.last_seen_at > m) ? r.last_seen_at : m), null);
  const recent = lastSeen && now().getTime() - new Date(lastSeen).getTime() < 24 * 3600000;
  return {
    settings,
    api: {
      enabled: settings.enabled,
      activeCredentials: active.length,
      lastCallAt: ev[0]?.last_any ?? null,
      lastSuccessAt: ev[0]?.last_ok ?? null,
      lastErrorAt: ev[0]?.last_err ?? null,
      status: !settings.enabled ? "disabled" : active.length === 0 ? "no_credentials" : ev[0]?.last_ok ? "ok" : "waiting_first_call",
    },
    whatsapp: {
      // evidência real = sessão válida usada por um número vinculado
      lastAuthenticatedActivityAt: lastSeen,
      linkedMembers: members.filter((m) => m.phone_e164).length,
      status: !lastSeen ? "no_evidence" : recent ? "recent_activity" : "no_recent_activity",
      note: "O Luna não vê a conexão do WhatsApp (ela fica no OpenBot). Mostramos apenas a última mensagem autenticada recebida de um número vinculado.",
    },
    credentials,
    members: members.map((m) => ({
      userId: m.id,
      name: m.name,
      relation: RELATION[first(m.name)] ?? null,
      linked: Boolean(m.phone_e164),
      phoneMasked: maskPhone(m.phone_e164),
      linkedVia: m.linked_via,
      linkedAt: m.linked_at,
      lastSeenAt: m.last_seen_at,
      pinSet: Boolean(m.pin),
      pinLocked: Boolean(m.locked && m.locked > now()),
      activeSessions: m.sessions,
      authorized: Boolean(m.phone_e164) && (Boolean(m.pin) || !settings.pinRequired),
    })),
    events,
    notifications: await queueCounts(db),
  };
}

/** Teste do lado do Luna. A conexão real do WhatsApp só se prova com uma mensagem. */
export async function selfTest(db: Db) {
  const checks: Array<{ id: string; ok: boolean; message: string }> = [];
  const t0 = Date.now();
  await db.query("SELECT 1");
  checks.push({ id: "database", ok: true, message: `Banco respondeu em ${Date.now() - t0} ms.` });
  const s = await getSettings(db);
  checks.push({ id: "enabled", ok: s.enabled, message: s.enabled ? "Integração ligada." : "Integração desligada — o OpenBot recebe 503." });
  const creds = (await listCredentials(db)).filter((c) => !(c as { revokedAt: Date | null }).revokedAt);
  checks.push({ id: "credential", ok: creds.length > 0, message: creds.length ? `${creds.length} credencial(is) ativa(s).` : "Nenhuma credencial ativa. Crie uma para o OpenBot." });
  const lastUsed = creds.map((c) => (c as { lastUsedAt: Date | null }).lastUsedAt).filter(Boolean).sort().pop() as Date | undefined;
  checks.push({
    id: "openbot_call",
    ok: Boolean(lastUsed),
    message: lastUsed ? `Última chamada do OpenBot: ${new Date(lastUsed).toISOString()}.` : "O OpenBot ainda não chamou a API (rode GET /health a partir dele).",
  });
  const { rows } = await db.query<{ linked: number; pins: number; total: number }>(
    `SELECT count(l.user_id)::int AS linked, count(u.channel_pin_hash)::int AS pins, count(*)::int AS total
       FROM users u LEFT JOIN whatsapp_links l ON l.user_id = u.id WHERE u.active`,
  );
  checks.push({ id: "members", ok: rows[0].linked === rows[0].total, message: `${rows[0].linked} de ${rows[0].total} pessoa(s) com WhatsApp vinculado; ${rows[0].pins} com PIN.` });
  const cards = await getCardSettings(db);
  checks.push({ id: "cards", ok: cards.cycleConfigured && Boolean(cards.holderUserId), message: cards.cycleConfigured ? "Fatura com fechamento e vencimento cadastrados." : "Cadastre titular, fechamento e vencimento da fatura para consultas de fatura." });
  return { ok: checks.every((c) => c.ok), checks, whatsapp: "Não verificável pelo Luna: envie uma mensagem de teste pelo WhatsApp e confira a 'última mensagem autenticada'." };
}
