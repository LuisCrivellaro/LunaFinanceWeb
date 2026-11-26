/**
 * Transferências entre contas da MESMA pessoa (ex.: corrente → poupança).
 * Alteram o saldo de cada conta, mas não são receita nem despesa — por isso
 * ficam fora de relatórios, totais do mês e categorias.
 */
import { z } from "zod";
import type { Db, Queryable } from "../db/index.js";
import { today } from "../lib/clock.js";
import { badRequest, notFound } from "../lib/errors.js";
import { parse, zCents, zDate, zId } from "../lib/validate.js";
import { assertOwner, type AuthUser } from "./access.js";
import { getOwnAccount } from "./accounts.js";
import { audit, recordSource, type Source } from "./audit.js";

export interface TransferRow {
  id: number;
  userId: number;
  fromAccountId: number;
  fromAccountName: string;
  toAccountId: number;
  toAccountName: string;
  amountCents: number;
  date: string;
  description: string | null;
  source: string;
}

const SELECT = `
  SELECT tr.id, tr.user_id AS "userId", tr.from_account_id AS "fromAccountId", fa.name AS "fromAccountName",
         tr.to_account_id AS "toAccountId", ta.name AS "toAccountName", tr.amount_cents AS "amountCents",
         tr.date, tr.description, tr.source
    FROM transfers tr JOIN accounts fa ON fa.id = tr.from_account_id JOIN accounts ta ON ta.id = tr.to_account_id`;

export const TransferInput = z
  .object({
    fromAccountId: zId,
    toAccountId: zId,
    amountCents: zCents,
    date: zDate.default(() => today()),
    description: z.string().trim().max(120).optional().nullable(),
  })
  .refine((v) => v.fromAccountId !== v.toAccountId, "Escolha contas diferentes para origem e destino.");

export async function createTransfer(db: Db, user: AuthUser, body: unknown, source: Source = "web") {
  return db.tx((q) => createTransferWith(q, user, body, source));
}

export async function createTransferWith(q: Queryable, user: AuthUser, body: unknown, source: Source = "web") {
  const input = parse(TransferInput, body);
  // as duas contas precisam ser da própria pessoa e estar ativas
  await getOwnAccount(q, user, input.fromAccountId);
  await getOwnAccount(q, user, input.toAccountId);
  const { rows } = await q.query<{ id: number }>(
    `INSERT INTO transfers (user_id, from_account_id, to_account_id, amount_cents, date, description, source, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$1) RETURNING id`,
    [user.id, input.fromAccountId, input.toAccountId, input.amountCents, input.date, input.description ?? null, recordSource(source)],
  );
  await audit(q, { userId: user.id, action: "transfer.create", entity: "transfer", entityId: rows[0].id, source, details: { amountCents: input.amountCents } });
  return (await getTransfer(q, rows[0].id))!;
}

export async function getTransfer(q: Queryable, id: number): Promise<TransferRow | null> {
  const { rows } = await q.query<TransferRow>(`${SELECT} WHERE tr.id = $1 AND tr.deleted_at IS NULL`, [id]);
  return rows[0] ?? null;
}

export async function listTransfers(q: Queryable, user: AuthUser, limit = 50): Promise<TransferRow[]> {
  const { rows } = await q.query<TransferRow>(
    `${SELECT} WHERE tr.user_id = $1 AND tr.deleted_at IS NULL ORDER BY tr.date DESC, tr.id DESC LIMIT $2`,
    [user.id, Math.min(Math.max(limit, 1), 200)],
  );
  return rows;
}

export async function deleteTransfer(db: Db, user: AuthUser, id: number, source: Source = "web") {
  return db.tx(async (q) => {
    const t = await getTransfer(q, id);
    if (!t) throw notFound("Transferência não encontrada.");
    assertOwner(user, t.userId, "esta transferência");
    await q.query("UPDATE transfers SET deleted_at = now() WHERE id = $1", [id]);
    await audit(q, { userId: user.id, action: "transfer.delete", entity: "transfer", entityId: id, source });
  });
}

export function assertDistinct(from: number | null, to: number | null) {
  if (from && to && from === to) throw badRequest("Escolha contas diferentes para origem e destino.");
}
