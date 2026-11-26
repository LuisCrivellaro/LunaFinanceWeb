/**
 * Gera integrations/openbot/openapi.json a partir da especificação em código.
 *   npm run openbot:openapi
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildOpenApi } from "../integrations/openbot/openapi.js";

const out = resolve(process.cwd(), "integrations/openbot/openapi.json");
mkdirSync(resolve(out, ".."), { recursive: true });
writeFileSync(out, JSON.stringify(buildOpenApi(), null, 2) + "\n");
console.log(`OpenAPI gravado em ${out}`);
