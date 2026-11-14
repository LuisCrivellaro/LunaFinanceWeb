/**
 * Controle de acesso — TODA regra de permissão vive aqui, no backend.
 * O frontend só esconde botões por conveniência; a segurança é esta camada.
 *
 * Modelo:
 *  - Cada pessoa vê e altera os PRÓPRIOS dados sempre.
 *  - `family_access` define o que ela vê dos outros:
 *      none    → nada da família
 *      summary → apenas totais agregados (sem lançamentos individuais alheios)
 *      full    → totais + lançamentos de todos
 *  - Ninguém altera lançamentos de outra pessoa (nem quem gerencia o sistema).
 *  - O papel interno `admin` serve só para gerenciar o sistema (membros,
 *    permissões, links de acesso). Ele NÃO dá acesso extra a dados financeiros
 *    e nunca é exposto na interface.
 */
import type { Queryable } from "../db/index.js";
import { forbidden } from "../lib/errors.js";

export interface AuthUser {
  id: number;
  name: string;
  email: string;
  role: "admin" | "member";
  family_access: "none" | "summary" | "full";
  color: string;
}

export type ViewRequest = "me" | "family" | number;

export interface ViewScope {
  /** IDs cujos dados entram no cálculo. */
  userIds: number[];
  /** Pode listar lançamentos individuais (não só totais)? */
  detail: boolean;
  isFamily: boolean;
}

export async function activeUserIds(q: Queryable): Promise<number[]> {
  const { rows } = await q.query<{ id: number }>("SELECT id FROM users WHERE active ORDER BY id");
  return rows.map((r) => r.id);
}

export function parseViewRequest(v: unknown): ViewRequest {
  if (v === undefined || v === null || v === "" || v === "me") return "me";
  if (v === "family") return "family";
  const n = Number(v);
  if (Number.isInteger(n) && n > 0) return n;
  return "me";
}

export async function resolveScope(q: Queryable, viewer: AuthUser, req: ViewRequest): Promise<ViewScope> {
  if (req === "me" || req === viewer.id) return { userIds: [viewer.id], detail: true, isFamily: false };
  if (viewer.family_access === "none") throw forbidden("Sua conta não tem acesso aos dados da família.");
  if (req === "family") {
    return { userIds: await activeUserIds(q), detail: viewer.family_access === "full", isFamily: true };
  }
  // pessoa específica
  if (viewer.family_access !== "full") throw forbidden("Sua conta só tem acesso aos totais da família.");
  const ids = await activeUserIds(q);
  if (!ids.includes(req)) throw forbidden();
  return { userIds: [req], detail: true, isFamily: false };
}

/** Lançamentos individuais de outra pessoa só com acesso completo. */
export function canSeeDetailsOf(viewer: AuthUser, ownerId: number) {
  return viewer.id === ownerId || viewer.family_access === "full";
}

export function assertOwner(viewer: AuthUser, ownerId: number, what = "este registro") {
  if (viewer.id !== ownerId) throw forbidden(`Somente o responsável pode alterar ${what}.`);
}

export function canManageFamily(user: AuthUser) {
  return user.role === "admin";
}

export function assertCanManageFamily(user: AuthUser) {
  // Mensagem neutra: não revela que existe um papel especial.
  if (!canManageFamily(user)) throw forbidden();
}
