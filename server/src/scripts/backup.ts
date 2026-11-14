/**
 * Backup lógico completo em JSON (funciona com qualquer Postgres, sem pg_dump).
 *   npm run backup                 → backups/luna-AAAA-MM-DD_HHMM.json
 *   npm run backup -- --out x.json
 * Guarde o arquivo em local seguro: ele contém dados financeiros e hashes de senha.
 */
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { arg, withContext } from "./_cli.js";

export const BACKUP_TABLES = [
  "users", "accounts", "categories", "recurrences", "transactions", "transfers", "goals", "goal_contributions",
  "telegram_links", "notification_log", "audit_log",
];

const stamp = new Date().toISOString().slice(0, 16).replace("T", "_").replace(":", "");
const out = arg("out") ?? `backups/luna-${stamp}.json`;

await withContext(async (ctx) => {
  const data: Record<string, unknown[]> = {};
  for (const t of BACKUP_TABLES) {
    const { rows } = await ctx.db.query(`SELECT * FROM ${t} ORDER BY 1`);
    data[t] = rows;
  }
  const { rows: mig } = await ctx.db.query<{ id: number }>("SELECT max(id) AS id FROM schema_migrations");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ app: "luna-finance", version: 1, schema: mig[0].id, createdAt: new Date().toISOString(), data }));
  try {
    chmodSync(out, 0o600);
  } catch {
    /* Windows */
  }
  const counts = Object.entries(data).map(([k, v]) => `${k}: ${v.length}`).join(", ");
  console.log(`Backup salvo em ${out}\n${counts}`);
});
