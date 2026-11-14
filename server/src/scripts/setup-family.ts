/**
 * Cria as contas da família e imprime um link de primeiro acesso para cada um.
 *
 *   npm run family:setup -- --file family.json
 *
 * family.json (veja family.example.json):
 *   [{ "name": "Luciana", "email": "...", "manager": false }, ...]
 *
 * `manager: true` dá permissão interna para gerenciar membros. Isso NUNCA
 * aparece na interface — nem para quem tem, nem para os demais.
 */
import { readFileSync } from "node:fs";
import { createMember } from "../services/members.js";
import { arg, withContext } from "./_cli.js";

interface Entry {
  name: string;
  email: string;
  manager?: boolean;
  familyAccess?: "none" | "summary" | "full";
}

const file = arg("file") ?? "family.json";
const entries = JSON.parse(readFileSync(file, "utf8")) as Entry[];
if (!Array.isArray(entries) || !entries.length) throw new Error(`${file} precisa ser uma lista de pessoas`);

await withContext(async (ctx) => {
  console.log("\nLinks de primeiro acesso (válidos por 72h, uso único):\n");
  for (const e of entries) {
    const exists = await ctx.db.query("SELECT id FROM users WHERE lower(email) = lower($1)", [e.email]);
    if (exists.rows.length) {
      console.log(`• ${e.name}: já cadastrado(a) — use "npm run family:reset-link -- --email ${e.email}" para novo link`);
      continue;
    }
    const r = await createMember(ctx.db, null, { name: e.name, email: e.email, familyAccess: e.familyAccess, role: e.manager ? "admin" : "member" }, ctx.config.appUrl);
    console.log(`• ${e.name}: ${r.url}`);
  }
  console.log("\nEnvie cada link SOMENTE para a pessoa correspondente (ex.: mensagem privada).\n");
});
