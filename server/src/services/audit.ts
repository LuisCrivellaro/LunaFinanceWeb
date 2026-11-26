import type { Queryable } from "../db/index.js";

export type Source = "web" | "telegram" | "whatsapp" | "system" | "cli";

/** Origem gravada em lançamentos/transferências (canais de mensagem viram a própria origem). */
export function recordSource(source: Source): "web" | "telegram" | "whatsapp" {
  return source === "telegram" || source === "whatsapp" ? source : "web";
}

export interface AuditEntry {
  userId: number | null;
  action: string; // ex.: transaction.create, auth.login_failed
  entity: string;
  entityId?: string | number | null;
  source?: Source;
  ip?: string | null;
  details?: Record<string, unknown>;
}

/** Registra uma ação no log de auditoria (append-only). */
export async function audit(q: Queryable, e: AuditEntry) {
  await q.query(
    `INSERT INTO audit_log (user_id, action, entity, entity_id, source, ip, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      e.userId,
      e.action,
      e.entity,
      e.entityId == null ? null : String(e.entityId),
      e.source ?? "web",
      e.ip ?? null,
      e.details ? JSON.stringify(e.details) : null,
    ],
  );
}
