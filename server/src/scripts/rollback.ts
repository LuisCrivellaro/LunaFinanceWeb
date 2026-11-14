/**
 * Reverte a ÚLTIMA migração aplicada, usando o SQL `down` dela.
 *   npm run backup                       ← faça antes!
 *   npm run db:rollback -- --confirm
 * Só reverte migrações que declaram `down`. A migração 1 (estrutura base)
 * não é reversível por segurança.
 */
import { migrations } from "../db/migrations.js";
import { loadConfig } from "../config.js";
import { createDb } from "../db/index.js";
import { flag } from "./_cli.js";

if (!flag("confirm")) throw new Error("Faça um backup (npm run backup) e rode com --confirm.");
const db = await createDb(loadConfig().databaseUrl);
try {
  const { rows } = await db.query<{ id: number }>("SELECT max(id) AS id FROM schema_migrations");
  const last = migrations.find((m) => m.id === rows[0]?.id);
  if (!last) throw new Error("Nenhuma migração para reverter.");
  if (!last.down) throw new Error(`A migração ${last.id}_${last.name} não é reversível.`);
  await db.tx(async (q) => {
    await q.exec(last.down!);
    await q.query("DELETE FROM schema_migrations WHERE id = $1", [last.id]);
  });
  console.log(`Migração ${last.id}_${last.name} revertida. Atenção: o servidor reaplica migrações ao iniciar — publique a versão anterior do código antes de reiniciá-lo.`);
} finally {
  await db.close();
}
