import { z } from "zod";
import type { Queryable } from "../db/index.js";
import { badRequest, notFound } from "../lib/errors.js";
import { parse } from "../lib/validate.js";
import { assertOwner, canSeeDetailsOf, type AuthUser } from "./access.js";
import { audit, type Source } from "./audit.js";

export const ACCOUNT_TYPES = ["checking", "savings", "cash", "investment", "wallet", "other"] as const;

export interface AccountRow {
  id: number;
  ownerId: number;
  name: string;
  type: string;
  initialBalanceCents: number;
  isDefault: boolean;
  archived: boolean;
  balanceCents: number;
}

const BALANCE_SQL = `
  a.initial_balance_cents + COALESCE((
    SELECT sum(CASE WHEN t.kind = 'income' THEN t.amount_cents ELSE -t.amount_cents END)
      FROM transactions t
     WHERE t.account_id = a.id AND t.status = 'paid' AND t.deleted_at IS NULL), 0)`;

export async function listAccounts(q: Queryable, viewer: AuthUser, userIds: number[], includeArchived = false): Promise<AccountRow[]> {
  const visible = userIds.filter((id) => canSeeDetailsOf(viewer, id));
  if (!visible.length) return [];
  const { rows } = await q.query<AccountRow>(
    `SELECT a.id, a.owner_id AS "ownerId", a.name, a.type, a.initial_balance_cents AS "initialBalanceCents",
            a.is_default AS "isDefault", a.archived, (${BALANCE_SQL})::bigint AS "balanceCents"
       FROM accounts a
      WHERE a.owner_id = ANY($1::int[]) ${includeArchived ? "" : "AND NOT a.archived"}
      ORDER BY a.owner_id, a.is_default DESC, lower(a.name)`,
    [visible],
  );
  return rows;
}

/** Soma dos saldos (sem detalhar contas) — permitida para quem vê só totais. */
export async function totalBalance(q: Queryable, userIds: number[]): Promise<number> {
  const { rows } = await q.query<{ total: number }>(
    `SELECT COALESCE(sum(${BALANCE_SQL}), 0)::bigint AS total FROM accounts a WHERE a.owner_id = ANY($1::int[]) AND NOT a.archived`,
    [userIds],
  );
  return rows[0].total;
}

export async function getOwnAccount(q: Queryable, user: AuthUser, accountId: number | undefined | null) {
  if (accountId) {
    const { rows } = await q.query<{ id: number; owner_id: number; archived: boolean }>(
      "SELECT id, owner_id, archived FROM accounts WHERE id = $1",
      [accountId],
    );
    const a = rows[0];
    if (!a || a.owner_id !== user.id) throw badRequest("Conta (carteira) inválida.");
    if (a.archived) throw badRequest("Esta conta está arquivada.");
    return a.id;
  }
  return ensureDefaultAccount(q, user.id);
}

export async function ensureDefaultAccount(q: Queryable, userId: number): Promise<number> {
  const { rows } = await q.query<{ id: number }>(
    "SELECT id FROM accounts WHERE owner_id = $1 AND NOT archived ORDER BY is_default DESC, id LIMIT 1",
    [userId],
  );
  if (rows[0]) return rows[0].id;
  const ins = await q.query<{ id: number }>(
    "INSERT INTO accounts (owner_id, name, type, is_default) VALUES ($1, 'Conta principal', 'checking', TRUE) RETURNING id",
    [userId],
  );
  return ins.rows[0].id;
}

const AccountInput = z.object({
  name: z.string().trim().min(1, "Informe o nome da conta.").max(40),
  type: z.enum(ACCOUNT_TYPES).default("checking"),
  initialBalanceCents: z.number().int().min(-100_000_000_000).max(100_000_000_000).default(0),
  isDefault: z.boolean().optional(),
});

export async function createAccount(q: Queryable, user: AuthUser, body: unknown) {
  const input = parse(AccountInput, body);
  if (input.isDefault) await q.query("UPDATE accounts SET is_default = FALSE WHERE owner_id = $1", [user.id]);
  const hasAny = await q.query("SELECT 1 FROM accounts WHERE owner_id = $1 AND NOT archived", [user.id]);
  const { rows } = await q.query<{ id: number }>(
    `INSERT INTO accounts (owner_id, name, type, initial_balance_cents, is_default) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [user.id, input.name, input.type, input.initialBalanceCents, input.isDefault || !hasAny.rows.length],
  );
  await audit(q, { userId: user.id, action: "account.create", entity: "account", entityId: rows[0].id });
  return rows[0];
}

export async function updateAccount(q: Queryable, user: AuthUser, id: number, body: unknown, source: Source = "web") {
  const input = parse(AccountInput.partial().extend({ archived: z.boolean().optional() }), body);
  const { rows } = await q.query<{ owner_id: number; is_default: boolean }>("SELECT owner_id, is_default FROM accounts WHERE id = $1", [id]);
  if (!rows[0]) throw notFound();
  assertOwner(user, rows[0].owner_id, "esta conta");
  if (input.isDefault) await q.query("UPDATE accounts SET is_default = FALSE WHERE owner_id = $1", [user.id]);
  if (input.archived && rows[0].is_default) {
    throw badRequest("Defina outra conta como principal antes de arquivar esta.");
  }
  await q.query(
    `UPDATE accounts SET
       name = COALESCE($2, name), type = COALESCE($3, type),
       initial_balance_cents = COALESCE($4, initial_balance_cents),
       is_default = COALESCE($5, is_default), archived = COALESCE($6, archived), updated_at = now()
     WHERE id = $1`,
    [id, input.name ?? null, input.type ?? null, input.initialBalanceCents ?? null, input.isDefault ?? null, input.archived ?? null],
  );
  await audit(q, { userId: user.id, action: "account.update", entity: "account", entityId: id, source, details: input });
}
