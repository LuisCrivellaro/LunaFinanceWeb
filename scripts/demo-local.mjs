/**
 * Um comando para ver o Luna rodando no seu computador (Windows, macOS ou Linux):
 *   npm run demo:local
 * Apaga o banco local (.data), recria a família de demonstração e sobe API + site.
 * Login: lipe@demo / teste123 — os outros perfis usam DemoLuna2026.
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import net from "node:net";

const step = (msg) => console.log(`\n▶ ${msg}`);
const fail = (msg) => {
  console.error(`\n✗ ${msg}\n`);
  process.exit(1);
};
const portFree = (port) =>
  new Promise((resolve) => {
    const srv = net.createServer().once("error", () => resolve(false)).once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port);
  });
const run = (script) => {
  const r = spawnSync("npm", ["run", script], { stdio: "inherit", shell: true });
  if (r.status !== 0) fail(`"npm run ${script}" falhou (veja a mensagem acima).`);
};

step("Conferindo as portas 3000 (API) e 5173 (site)");
for (const port of [3000, 5173]) {
  if (!(await portFree(port))) {
    fail(`A porta ${port} já está em uso — provavelmente um "npm run dev" antigo ainda aberto.
  Feche os outros terminais do Luna (ou reinicie o computador) e rode de novo: npm run demo:local`);
  }
}

if (!existsSync(".env")) {
  step("Criando .env a partir do .env.example");
  copyFileSync(".env.example", ".env");
}

step("Apagando o banco local de demonstração (.data)");
try {
  rmSync(".data", { recursive: true, force: true });
} catch (e) {
  fail(`Não consegui apagar a pasta .data (${e.code ?? e.message}). Feche qualquer "npm run dev" aberto e tente de novo.`);
}

step("Criando as tabelas");
run("db:migrate");
step("Criando a família de demonstração");
run("demo:seed");

step("Subindo API (3000) e site (5173). Para parar: Ctrl+C");
console.log("  Abra http://localhost:5173 e entre com  lipe@demo  /  teste123\n");
const dev = spawn("npm", ["run", "dev"], { stdio: "inherit", shell: true });
dev.on("exit", (code) => process.exit(code ?? 0));
