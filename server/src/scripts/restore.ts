/**
 * Restaura um backup JSON em um banco VAZIO (segurança: nunca sobrescreve dados).
 *   npm run restore -- --file backups/luna-....json --confirm
 * Para restaurar por cima de um banco existente, crie um banco novo, aponte
 * DATABASE_URL para ele e rode este comando.
 */
import { readFileSync } from "node:fs";
import { arg, flag, withContext } from "./_cli.js";

const TABLES = [
  "users", "accounts", "categories", "recurrences", "transactions", "goals", "goal_contributions",
  "telegram_links", "notification_log", "audit_log",
];

const file = arg("file");
if (!file) throw new Error("Use --file caminho/do/backup.json");
if (!flag("confirm")) throw new Error("Adicione --confirm para confirmar a restauração.");
const backup = JSON.parse(readFileSync(file, "utf8")) as { app: string; schema: number; data: Record<string, Record<string, unknown>[]> };
if (backup.app !== "luna-finance") throw new Error("Arquivo não é um backup do Luna Finance");

await withContext(async (ctx) => {
  const { rows } = await ctx.db.query<{ n: number }>("SELECT count(*)::int AS n FROM users");
  if (rows[0].n > 0) throw new Error("O banco de destino já tem dados. Restaure em um banco vazio.");
  await ctx.db.tx(async (q) => {
    await q.query("DELETE FROM categories"); // remove as categorias padrão criadas na migração
    for (const t of TABLES) {
      for (const row of backup.data[t] ?? []) {
        const cols = Object.keys(row);
        const vals = cols.map((c) => {
          const v = row[c];
          return v !== null && typeof v === "object" ? JSON.stringify(v) : v;
        });
        await q.query(
          `INSERT INTO ${t} (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`,
          vals,
        );
      }
      // reposiciona a sequência do id (telegram_links usa user_id como chave)
      if (t === "telegram_links") continue;
      await q.query(
        `SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE((SELECT max(id) FROM ${t}), 0) + 1, false)
          WHERE pg_get_serial_sequence('${t}', 'id') IS NOT NULL`,
      );
    }
  });
  console.log("Restauração concluída.");
});
