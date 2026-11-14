/** Gera um novo link de acesso (redefinir senha):  npm run family:reset-link -- --email pessoa@exemplo.com */
import { createAccessLink } from "../services/auth.js";
import { audit } from "../services/audit.js";
import { arg, withContext } from "./_cli.js";

const email = arg("email");
if (!email) throw new Error("Use --email pessoa@exemplo.com");

await withContext(async (ctx) => {
  const { rows } = await ctx.db.query<{ id: number; name: string }>("SELECT id, name FROM users WHERE lower(email) = lower($1)", [email]);
  if (!rows[0]) throw new Error("E-mail não encontrado");
  const link = await createAccessLink(ctx.db, rows[0].id, "reset", null, ctx.config.appUrl, 24);
  await audit(ctx.db, { userId: null, action: "member.reset_link", entity: "user", entityId: rows[0].id, source: "cli" });
  console.log(`\n${rows[0].name}: ${link.url}\n(válido por 24h, uso único)\n`);
});
