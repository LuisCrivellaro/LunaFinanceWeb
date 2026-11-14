/**
 * IA opcional (Claude) para entender frases que as regras não entenderam.
 *
 * Garantias contra "invenção":
 *  - A IA só CLASSIFICA e EXTRAI; ela nunca responde saldos ou totais.
 *    Consultas viram uma intenção fixa e os números vêm do banco.
 *  - O valor precisa aparecer literalmente na mensagem (`amount_text`) e é
 *    reconvertido pelo nosso parser; se não bater, a resposta é descartada.
 *  - Categoria só pode ser uma das existentes; data é validada.
 *  - Todo lançamento ainda exige confirmação do usuário no Telegram.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { addDays, isIsoDate } from "../lib/clock.js";
import { parseMoneyToCents } from "../lib/money.js";
import type { Logger } from "../context.js";
import { normalize, type CategoryLite, type Intent, type QueryIntent } from "./parser.js";

export interface AiParser {
  interpret(text: string, categories: CategoryLite[], today: string): Promise<Intent | null>;
}

const QUERY_VALUES = ["balance", "family", "income", "expenses", "bills", "upcoming", "goals", "summary"] as const;

const Interpretation = z.object({
  type: z.enum(["entry", "query", "other"]),
  query: z.enum(QUERY_VALUES).nullable(),
  kind: z.enum(["income", "expense"]).nullable(),
  amount_text: z.string().nullable(),
  description: z.string().nullable(),
  category_name: z.string().nullable(),
  date: z.string().nullable(),
  status: z.enum(["paid", "pending"]).nullable(),
  installments: z.number().int().nullable(),
});

const SYSTEM = `Você interpreta mensagens curtas, em português do Brasil, enviadas a um bot de finanças familiares.
Classifique a mensagem e extraia campos. Regras:
- type "entry": a pessoa quer registrar uma receita ou despesa. type "query": quer consultar algo. type "other": qualquer outra coisa.
- query (só quando type = "query"): balance (saldo próprio), family (dados da família), income (receitas do mês), expenses (despesas do mês), bills (contas pendentes/atrasadas), upcoming (próximos vencimentos), goals (metas), summary (resumo do mês).
- amount_text: copie EXATAMENTE o trecho da mensagem que contém o valor (ex.: "R$ 150", "45,90", "3 mil"). Nunca calcule nem invente valores. Se não houver valor escrito, use null.
- category_name: escolha somente um nome da lista de categorias fornecida, ou null.
- date: AAAA-MM-DD, calculada a partir da data de hoje informada; null se a mensagem não indicar data.
- status: "pending" para contas a pagar/vencimentos futuros; "paid" para algo que já aconteceu.
- description: 1 a 5 palavras descrevendo o lançamento, sem o valor.
- installments: número de parcelas se a mensagem disser (ex.: "em 3x"), senão null.`;

export function createAiParser(apiKey: string, model: string, log: Logger, client?: Anthropic): AiParser {
  const anthropic = client ?? new Anthropic({ apiKey, timeout: 20000, maxRetries: 1 });
  return {
    async interpret(text, categories, today) {
      const catList = categories.map((c) => `${c.name} (${c.kind === "income" ? "receita" : "despesa"})`).join(", ");
      try {
        const response = await anthropic.messages.parse({
          model,
          max_tokens: 1024,
          output_config: { effort: "low", format: zodOutputFormat(Interpretation) },
          system: SYSTEM,
          messages: [
            {
              role: "user",
              content: `Hoje é ${today}.\nCategorias: ${catList}\n\nMensagem:\n<mensagem>${text.slice(0, 500)}</mensagem>`,
            },
          ],
        });
        if (response.stop_reason === "refusal") return null;
        const out = response.parsed_output;
        if (!out) return null;
        return validateInterpretation(out, text, categories, today);
      } catch (err) {
        log.warn("ai.interpret falhou", { err: (err as Error).message });
        return null; // sem IA, o bot pede para reformular
      }
    },
  };
}

/** Exportado para teste: transforma a saída da IA em Intent, descartando o que não for verificável. */
export function validateInterpretation(
  out: z.infer<typeof Interpretation>,
  originalText: string,
  categories: CategoryLite[],
  today: string,
): Intent | null {
  if (out.type === "query" && out.query && (QUERY_VALUES as readonly string[]).includes(out.query)) {
    return { type: "query", query: out.query as QueryIntent };
  }
  if (out.type !== "entry" || !out.kind) return null;
  if (!out.amount_text) return { type: "incomplete", missing: ["amount"], partial: { kind: out.kind } };
  // o valor precisa estar escrito na mensagem
  if (!normalize(originalText).includes(normalize(out.amount_text))) return null;
  const cents = parseMoneyToCents(out.amount_text.replace(/reais|real/gi, "").trim());
  if (!cents) return null;
  const cat = out.category_name
    ? categories.find((c) => c.kind === out.kind && normalize(c.name) === normalize(out.category_name!))
    : undefined;
  let date = today;
  if (out.date && isIsoDate(out.date) && out.date >= addDays(today, -400) && out.date <= addDays(today, 400)) date = out.date;
  const status = out.status ?? (date > today ? "pending" : "paid");
  const desc = (out.description ?? "").trim().slice(0, 80) || cat?.name || (out.kind === "income" ? "Receita" : "Despesa");
  return {
    type: "entry",
    draft: {
      kind: out.kind,
      amountCents: cents,
      description: desc.charAt(0).toUpperCase() + desc.slice(1),
      categoryId: cat?.id ?? null,
      date,
      status,
      installments: out.kind === "expense" && out.installments && out.installments >= 2 && out.installments <= 72 ? out.installments : null,
      amountText: out.amount_text,
    },
  };
}
