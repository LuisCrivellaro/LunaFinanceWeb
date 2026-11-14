/**
 * Teste de fumaça no navegador (Playwright) contra um servidor rodando com
 * os dados de demonstração (npm run demo:seed).
 *   BASE_URL=http://localhost:3000 node e2e/smoke.mjs
 */
import { createRequire } from "node:module";
// usa o Playwright instalado (local ou global via NODE_PATH)
const { chromium } = createRequire(import.meta.url)("playwright");

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const PASS = "DemoLuna2026";
const forbidden = /\b(adm|admin|administrador|propriet[aá]rio|fundador|dono)\b/i;
let failures = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "✓" : "✗"} ${msg}`);
  if (!ok) failures++;
};

const browser = await chromium.launch();

async function login(email, viewport = { width: 1280, height: 860 }) {
  const ctx = await browser.newContext({ viewport, locale: "pt-BR" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/entrar`);
  await page.fill("input[type=email]", email);
  await page.fill("input[type=password]", PASS);
  await page.click("button.btn-primary");
  await page.waitForSelector(".hero .balance");
  return { ctx, page, errors };
}

// 1) Nenhuma tela mostra hierarquia — para ninguém, inclusive o Lipe
for (const email of ["lipe@demo.luna", "luciana@demo.luna"]) {
  const { ctx, page } = await login(email);
  let found = [];
  for (const path of ["/", "/movimentacoes", "/contas", "/metas", "/relatorios", "/configuracoes"]) {
    await page.goto(BASE + path);
    await page.waitForTimeout(900);
    const text = await page.locator("body").innerText();
    if (forbidden.test(text)) found.push(path);
  }
  check(found.length === 0, `${email}: nenhuma tela exibe ADM/administrador/dono ${found.join(",")}`);
  const hasPeople = await page.getByRole("heading", { name: "Pessoas da família" }).count();
  check(email.startsWith("lipe") ? hasPeople === 1 : hasPeople === 0, `${email}: área de pessoas ${hasPeople ? "visível" : "oculta"} conforme permissão interna`);
  await ctx.close();
}

// 2) Cadastro, edição e exclusão pelo formulário
{
  const { ctx, page, errors } = await login("joao@demo.luna");
  await page.goto(`${BASE}/movimentacoes`);
  await page.locator(".sidebar .btn-primary").click();
  await page.fill(".money-input input", "87,45");
  await page.fill("input[placeholder='Ex.: Supermercado']", "Teste E2E livraria");
  await page.selectOption(".modal select >> nth=0", { label: "Educação" });
  await page.click(".modal-foot .btn-primary");
  await page.waitForSelector(".toast");
  await page.fill("input[placeholder^='Pesquisar']", "livraria");
  await page.waitForTimeout(800);
  const row = page.locator(".list-item", { hasText: "Teste E2E livraria" });
  check((await row.count()) === 1, "despesa criada aparece na lista (busca)");
  check((await row.innerText()).includes("87,45"), "valor exibido corretamente");
  await row.click();
  await page.fill(".money-input input", "90,00");
  await page.click(".modal-foot .btn-primary");
  await page.waitForTimeout(900);
  check((await row.innerText()).includes("90,00"), "edição salva");
  await row.click();
  page.once("dialog", (d) => d.accept());
  await page.click(".modal-foot .btn-danger");
  await page.waitForTimeout(900);
  check((await row.count()) === 0, "exclusão remove da lista");
  check(errors.length === 0, `sem erros de JavaScript ${errors.join(" | ")}`);
  await ctx.close();
}

// 2b) Transferência entre contas pelo site (requer 2+ contas; cria a segunda se faltar)
{
  const { ctx, page, errors } = await login("joao@demo.luna");
  await page.goto(`${BASE}/configuracoes`);
  await page.waitForSelector("#contas");
  if (!(await page.getByRole("button", { name: "Transferir entre contas" }).count())) {
    await page.getByRole("button", { name: "Nova conta" }).click();
    await page.fill(".modal input[placeholder='Ex.: Nubank']", "Cofrinho E2E");
    await page.click(".modal-foot .btn-primary");
    await page.waitForTimeout(800);
  }
  await page.getByRole("button", { name: "Transferir entre contas" }).click();
  await page.fill(".modal .money-input input", "12,34");
  await page.click(".modal-foot .btn-primary");
  const ok = await page.getByText("Transferência registrada").waitFor({ timeout: 5000 }).then(() => true, () => false);
  check(ok, "transferência pelo site registrada");
  await page.waitForTimeout(600);
  check((await page.getByText("Transferências recentes").count()) === 1, "lista de transferências recentes aparece");
  check(errors.length === 0, `sem erros de JavaScript na transferência ${errors.join(" | ")}`);
  await ctx.close();
}

// 3) Responsividade: sem rolagem horizontal no celular
{
  const { ctx, page } = await login("luciana@demo.luna", { width: 375, height: 760 });
  for (const path of ["/", "/movimentacoes", "/contas", "/metas", "/relatorios", "/configuracoes"]) {
    await page.goto(BASE + path);
    await page.waitForTimeout(800);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 1, `375px ${path}: sem rolagem horizontal (${overflow}px)`);
  }
  check(await page.locator(".tabbar").isVisible(), "barra de navegação inferior visível no celular");
  await ctx.close();
}

await browser.close();
console.log(failures ? `\n${failures} falha(s)` : "\nTudo certo.");
process.exit(failures ? 1 : 0);
