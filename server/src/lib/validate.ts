import { z } from "zod";
import { badRequest } from "./errors.js";
import { isIsoDate } from "./clock.js";
import { MAX_CENTS } from "./money.js";

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issue = r.error.issues[0];
    const field = issue.path.join(".");
    throw badRequest(issue.message || "Dados inválidos.", { field });
  }
  return r.data;
}

export const zDate = z
  .string()
  .refine((s) => isIsoDate(s) && s >= "2000-01-01" && s <= "2100-12-31", "Data inválida (use AAAA-MM-DD).");
export const zCents = z
  .number()
  .int("Valor deve estar em centavos.")
  .positive("O valor precisa ser maior que zero.")
  .max(MAX_CENTS, "Valor alto demais.");
export const zId = z.number().int().positive();
export const zKind = z.enum(["income", "expense"], "Tipo deve ser receita ou despesa.");
export const zText = (max: number, label: string) =>
  z.string().trim().min(1, `Informe ${label}.`).max(max, `${label} muito longo.`);
