/**
 * Baixa a fonte Satoshi (variável, 300–900) do Fontshare para web/public/fonts.
 *
 * Por que não está no git: a ITF Free Font License permite hospedar a fonte no
 * próprio site/app, mas proíbe disponibilizá-la em repositórios públicos.
 * Então o arquivo é baixado da fonte oficial na hora do dev/build e servido
 * pelo nosso próprio servidor (a CSP exige fontes de 'self').
 *
 * Sem rede, o app continua funcionando com as fontes do sistema (fallback).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "../public/fonts");
const out = resolve(outDir, "satoshi-variable.woff2");
const CSS_URL = "https://api.fontshare.com/v2/css?f[]=satoshi@1&display=swap";

if (existsSync(out) && !process.argv.includes("--force")) process.exit(0);

try {
  const css = await (await fetch(CSS_URL)).text();
  const m = css.match(/url\('([^']+\.woff2)'\)/);
  if (!m) throw new Error("URL do woff2 não encontrada na resposta do Fontshare");
  const url = m[1].startsWith("//") ? `https:${m[1]}` : m[1];
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download falhou (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.subarray(0, 4).toString("latin1") !== "wOF2") throw new Error("arquivo recebido não é WOFF2");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(out, buf);
  console.log(`[fonts] Satoshi baixada (${Math.round(buf.length / 1024)} KB) — licença: ITF Free Font License (fontshare.com)`);
} catch (e) {
  console.warn(`[fonts] não foi possível baixar a Satoshi: ${e instanceof Error ? e.message : e}. Usando fontes do sistema.`);
}
