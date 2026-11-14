/**
 * Estado do bot no banco (sobrevive a reinícios e funciona com várias instâncias):
 *  - conversas: o que o bot está esperando do usuário (ex.: o valor);
 *  - ações pendentes: rascunhos aguardando confirmação, com VERSÃO —
 *    toda edição incrementa a versão e só a versão atual pode ser confirmada.
 */
import { randomBytes } from "node:crypto";
import type { Db, Queryable } from "../db/index.js";
import { now } from "../lib/clock.js";
import type { Draft } from "./parser.js";

// ------------------------------ conversas ------------------------------

export type ConvState =
  | { step: "await_amount"; draft: Partial<Draft> & { kind: "income" | "expense" } }
  | { step: "edit_field"; pendingId: string; field: "amount" | "description" | "date" | "name" | "target" }
  | { step: "goal_name" }
  | { step: "goal_amount"; name: string }
  | { step: "goal_deadline"; name: string; targetCents: number }
  | { step: "contrib_amount"; goalId: number; goalName: string; withdraw: boolean }
  | { step: "edit_tx"; txId: number; field: "amount" | "description" | "date" }
  | { step: "transfer_amount"; fromAccountId: number | null; toAccountId: number | null; date: string };

const CONV_TTL_MIN = 10;

export async function getConversation(q: Queryable, userId: number): Promise<ConvState | null> {
  const { rows } = await q.query<{ state: ConvState | string; expires_at: Date }>(
    "SELECT state, expires_at FROM telegram_conversations WHERE user_id = $1",
    [userId],
  );
  const r = rows[0];
  if (!r) return null;
  if (r.expires_at < now()) {
    await clearConversation(q, userId);
    return null;
  }
  return typeof r.state === "string" ? (JSON.parse(r.state) as ConvState) : r.state;
}

export async function setConversation(q: Queryable, userId: number, state: ConvState) {
  await q.query(
    `INSERT INTO telegram_conversations (user_id, state, expires_at, updated_at) VALUES ($1,$2,$3,now())
     ON CONFLICT (user_id) DO UPDATE SET state = EXCLUDED.state, expires_at = EXCLUDED.expires_at, updated_at = now()`,
    [userId, JSON.stringify(state), new Date(now().getTime() + CONV_TTL_MIN * 60000)],
  );
}

export async function clearConversation(q: Queryable, userId: number) {
  await q.query("DELETE FROM telegram_conversations WHERE user_id = $1", [userId]);
}

// ------------------------------ ações pendentes ------------------------------

export type PendingKind = "transaction" | "goal" | "contribution" | "transfer" | "tx_update" | "tx_delete";

export interface GoalPayload {
  name: string;
  targetCents: number;
  deadline: string | null;
  scope: "individual" | "family";
}
export interface ContributionPayload {
  goalId: number;
  goalName: string;
  amountCents: number; // negativo = retirada
}

export interface TransferPayload {
  amountCents: number;
  fromAccountId: number | null;
  toAccountId: number | null;
  date: string;
}
/** Alteração de um lançamento JÁ registrado (mostra antes → depois). */
export interface TxUpdatePayload {
  txId: number;
  description: string;
  field: "amount" | "description" | "date" | "category";
  fromLabel: string;
  toLabel: string;
  patch: Record<string, unknown>;
}
export interface TxDeletePayload {
  txId: number;
  description: string;
  amountCents: number;
  date: string;
  kind: "income" | "expense";
}

export type PendingPayload =
  | { kind: "transaction"; draft: Draft; messageId?: number }
  | { kind: "goal"; goal: GoalPayload; messageId?: number }
  | { kind: "contribution"; contribution: ContributionPayload; messageId?: number }
  | { kind: "transfer"; transfer: TransferPayload; messageId?: number }
  | { kind: "tx_update"; update: TxUpdatePayload; messageId?: number }
  | { kind: "tx_delete"; del: TxDeletePayload; messageId?: number };

export interface Pending {
  id: string;
  userId: number;
  chatId: number;
  kind: PendingKind;
  payload: PendingPayload;
  status: "pending" | "confirmed" | "cancelled" | "expired";
  version: number;
  expiresAt: Date;
  resultId: number | null;
}

export const PENDING_TTL_MIN = 15;

export async function createPending(q: Queryable, userId: number, chatId: number, payload: PendingPayload): Promise<Pending> {
  const id = randomBytes(9).toString("base64url"); // 12 caracteres — cabe no callback_data
  const expiresAt = new Date(now().getTime() + PENDING_TTL_MIN * 60000);
  await q.query(
    `INSERT INTO telegram_pending_actions (id, user_id, chat_id, payload, kind, expires_at) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, userId, chatId, JSON.stringify(payload), payload.kind, expiresAt],
  );
  return { id, userId, chatId, kind: payload.kind, payload, status: "pending", version: 1, expiresAt, resultId: null };
}

export async function getPending(q: Queryable, id: string): Promise<Pending | null> {
  const { rows } = await q.query<{
    id: string; user_id: number; chat_id: number; kind: PendingKind; payload: PendingPayload | string; status: Pending["status"];
    version: number; expires_at: Date; result_id: number | null;
  }>("SELECT id, user_id, chat_id, kind, payload, status, version, expires_at, result_id FROM telegram_pending_actions WHERE id = $1", [id]);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    userId: r.user_id,
    chatId: Number(r.chat_id),
    kind: r.kind,
    payload: typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload,
    status: r.status,
    version: r.version,
    expiresAt: r.expires_at,
    resultId: r.result_id,
  };
}

/** Motivo pelo qual uma ação não pode mais ser usada (ou null se pode). */
export function pendingProblem(p: Pending | null, userId: number, version?: number): string | null {
  if (!p || p.userId !== userId) return "Esta ação não está mais disponível.";
  if (p.status === "confirmed") return "Isso já foi registrado. ✅";
  if (p.status === "cancelled") return "Esta ação foi cancelada.";
  if (p.status === "expired" || p.expiresAt < now()) return "Esta confirmação expirou. Envie a mensagem de novo.";
  if (version !== undefined && version !== p.version) return "Este resumo foi alterado. Use a versão mais recente, logo abaixo.";
  return null;
}

/** Atualiza o rascunho e incrementa a versão (só enquanto pendente). Retorna a nova versão. */
export async function updatePending(q: Queryable, id: string, payload: PendingPayload): Promise<number | null> {
  const { rows } = await q.query<{ version: number }>(
    `UPDATE telegram_pending_actions SET payload = $2, version = version + 1, expires_at = $3
      WHERE id = $1 AND status = 'pending' RETURNING version`,
    [id, JSON.stringify(payload), new Date(now().getTime() + PENDING_TTL_MIN * 60000)],
  );
  return rows[0]?.version ?? null;
}

export async function setPendingMessage(q: Queryable, id: string, payload: PendingPayload, messageId: number) {
  await q.query("UPDATE telegram_pending_actions SET payload = $2 WHERE id = $1", [id, JSON.stringify({ ...payload, messageId })]);
}

export async function cancelPending(q: Queryable, id: string, userId: number) {
  const r = await q.query("UPDATE telegram_pending_actions SET status = 'cancelled' WHERE id = $1 AND user_id = $2 AND status = 'pending'", [id, userId]);
  return r.rowCount > 0;
}

export async function cancelAllPending(q: Queryable, userId: number) {
  const r = await q.query("UPDATE telegram_pending_actions SET status = 'cancelled' WHERE user_id = $1 AND status = 'pending'", [userId]);
  return r.rowCount;
}

/**
 * Confirmação atômica: trava a ação (status pending → confirmed, conferindo a
 * versão e a validade) E executa a gravação na MESMA transação de banco.
 * Se a gravação falhar, nada é salvo e a ação continua pendente.
 */
export async function confirmPending<T>(
  db: Db,
  id: string,
  userId: number,
  version: number,
  execute: (q: Queryable, p: Pending) => Promise<{ resultId: number; value: T }>,
): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  return db.tx(async (q) => {
    const { rows } = await q.query<{ id: string }>(
      `UPDATE telegram_pending_actions SET status = 'confirmed'
        WHERE id = $1 AND user_id = $2 AND status = 'pending' AND version = $3 AND expires_at > $4
        RETURNING id`,
      [id, userId, version, now()],
    );
    if (!rows[0]) {
      const p = await getPending(q, id);
      return { ok: false as const, reason: pendingProblem(p, userId, version) ?? "Esta ação não está mais disponível." };
    }
    const p = (await getPending(q, id))!;
    const out = await execute(q, p);
    await q.query("UPDATE telegram_pending_actions SET result_id = $2 WHERE id = $1", [id, out.resultId]);
    return { ok: true as const, value: out.value };
  });
}

// ------------------------------ contexto da conversa ------------------------------
// Guarda a última consulta para entender continuações como "e no mês passado?".

const CONTEXT_TTL_MIN = 15;

export async function saveLastQuery(q: Queryable, userId: number, query: unknown) {
  await q.query(
    `INSERT INTO telegram_context (user_id, last_query, updated_at) VALUES ($1,$2,now())
     ON CONFLICT (user_id) DO UPDATE SET last_query = EXCLUDED.last_query, updated_at = now()`,
    [userId, JSON.stringify(query)],
  );
}

export async function getLastQuery<T>(q: Queryable, userId: number): Promise<T | null> {
  const { rows } = await q.query<{ last_query: T | string; updated_at: Date }>("SELECT last_query, updated_at FROM telegram_context WHERE user_id = $1", [userId]);
  const r = rows[0];
  if (!r || now().getTime() - new Date(r.updated_at).getTime() > CONTEXT_TTL_MIN * 60000) return null;
  return typeof r.last_query === "string" ? (JSON.parse(r.last_query) as T) : r.last_query;
}
