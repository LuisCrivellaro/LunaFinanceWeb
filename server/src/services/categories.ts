import { z } from "zod";
import type { Queryable } from "../db/index.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { parse, zKind } from "../lib/validate.js";
import { canManageFamily, type AuthUser } from "./access.js";
import { audit } from "./audit.js";

export interface CategoryRow {
  id: number;
  name: string;
  kind: "income" | "expense";
  icon: string;
  color: string;
  keywords: string;
  isDefault: boolean;
  createdBy: number | null;
  archived: boolean;
}

/** Categorias são da família (compartilhadas) para os relatórios baterem. */
export async function listCategories(q: Queryable, includeArchived = false): Promise<CategoryRow[]> {
  const { rows } = await q.query<CategoryRow>(
    `SELECT id, name, kind, icon, color, keywords, is_default AS "isDefault", created_by AS "createdBy", archived
       FROM categories ${includeArchived ? "" : "WHERE NOT archived"} ORDER BY kind, lower(name)`,
  );
  return rows;
}

const CategoryInput = z.object({
  name: z.string().trim().min(1, "Informe o nome da categoria.").max(40),
  kind: zKind,
  icon: z.string().trim().max(30).regex(/^[a-z0-9-]+$/).default("tag"),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Cor inválida.").default("#8A8F98"),
  keywords: z.string().trim().max(400).default(""),
});

export async function createCategory(q: Queryable, user: AuthUser, body: unknown) {
  const input = parse(CategoryInput, body);
  const dup = await q.query("SELECT 1 FROM categories WHERE lower(name) = lower($1) AND kind = $2 AND NOT archived", [input.name, input.kind]);
  if (dup.rows.length) throw conflict("Já existe uma categoria com esse nome.");
  const { rows } = await q.query<{ id: number }>(
    `INSERT INTO categories (name, kind, icon, color, keywords, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [input.name, input.kind, input.icon, input.color, input.keywords, user.id],
  );
  await audit(q, { userId: user.id, action: "category.create", entity: "category", entityId: rows[0].id });
  return rows[0];
}

export async function updateCategory(q: Queryable, user: AuthUser, id: number, body: unknown) {
  const input = parse(CategoryInput.omit({ kind: true }).partial().extend({ archived: z.boolean().optional() }), body);
  const { rows } = await q.query<{ created_by: number | null; is_default: boolean; kind: string }>(
    "SELECT created_by, is_default, kind FROM categories WHERE id = $1",
    [id],
  );
  const c = rows[0];
  if (!c) throw notFound();
  // quem criou edita; categorias padrão só quem gerencia o sistema
  const allowed = c.created_by === user.id || (c.is_default && canManageFamily(user)) || (!c.created_by && canManageFamily(user));
  if (!allowed) throw forbidden("Somente quem criou a categoria pode alterá-la.");
  if (input.name) {
    const dup = await q.query("SELECT 1 FROM categories WHERE lower(name) = lower($1) AND kind = $2 AND id <> $3 AND NOT archived", [input.name, c.kind, id]);
    if (dup.rows.length) throw conflict("Já existe uma categoria com esse nome.");
  }
  await q.query(
    `UPDATE categories SET name = COALESCE($2,name), icon = COALESCE($3,icon), color = COALESCE($4,color),
       keywords = COALESCE($5,keywords), archived = COALESCE($6,archived) WHERE id = $1`,
    [id, input.name ?? null, input.icon ?? null, input.color ?? null, input.keywords ?? null, input.archived ?? null],
  );
  await audit(q, { userId: user.id, action: "category.update", entity: "category", entityId: id, details: input });
}

export async function assertCategory(q: Queryable, categoryId: number | null | undefined, kind: string): Promise<number | null> {
  if (!categoryId) return null;
  const { rows } = await q.query<{ kind: string; archived: boolean }>("SELECT kind, archived FROM categories WHERE id = $1", [categoryId]);
  const c = rows[0];
  if (!c || c.archived) throw notFound("Categoria não encontrada.");
  if (c.kind !== kind) throw badRequest(kind === "income" ? "Escolha uma categoria de receita." : "Escolha uma categoria de despesa.");
  return categoryId;
}
