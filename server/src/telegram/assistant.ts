/**
 * Assistente financeiro com IA (Claude) — opcional (ANTHROPIC_API_KEY).
 *
 * Garantias:
 *  1. A IA só acessa dados por FERRAMENTAS do backend (data.ts), sempre no
 *     escopo do usuário autenticado. Não existe ferramenta de SQL livre.
 *  2. A IA não grava nada: as ferramentas `propose_*` só montam um rascunho,
 *     que vira o mesmo cartão de confirmação do fluxo normal.
 *  3. O valor de uma proposta precisa estar escrito na mensagem do usuário.
 *  4. Toda resposta em texto é verificada: cada "R$" citado precisa existir nos
 *     resultados das ferramentas desta conversa. Se não existir, a resposta é
 *     descartada e o bot usa a resposta determinística.
 *  5. Respostas que afirmem ter registrado/salvo algo são descartadas.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Queryable } from "../db/index.js";
import type { Logger } from "../context.js";
import { addDays, isIsoDate, isYearMonth } from "../lib/clock.js";
import { parseMoneyToCents } from "../lib/money.js";
import type { AuthUser } from "../services/access.js";
import { PAYMENT_METHODS, type PaymentMethod } from "../services/transactions.js";
import {
  compareMonths, getBalance, getCategoryBreakdown, getCategoryTotal, getEvolution, getFlow, getGoals, getPendingBills,
  getPeriodTotals, getTransactionsList,
} from "./data.js";
import type { Intent } from "./nlu.js";
import { findGoal } from "./nlu.js";
import { normalize, type AccountLite, type CategoryLite } from "./parser.js";

export interface AssistantDeps {
  db: Queryable;
  user: AuthUser;
  today: string;
  categories: CategoryLite[];
  accounts: AccountLite[];
  goals: Array<{ id: number; name: string }>;
}

export type AssistantResult =
  | { type: "text"; text: string }
  | { type: "proposal"; intent: Intent }
  | { type: "none"; reason: string };

export interface Assistant {
  respond(text: string, deps: AssistantDeps): Promise<AssistantResult>;
}

/** Subconjunto do cliente usado (permite injetar um falso nos testes). */
export interface MessagesClient {
  messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
}

const MAX_ROUNDS = 6;

const SYSTEM = `Você é o assistente financeiro do Luna Finance, no Telegram, falando português do Brasil.
Regras obrigatórias:
- Use SOMENTE dados retornados pelas ferramentas. Nunca invente saldos, valores, datas ou movimentações.
- Se faltar dado, diga claramente que não há informação suficiente.
- Para registrar algo, use propose_transaction, propose_goal ou propose_goal_contribution. Isso só cria um rascunho: o usuário ainda vai confirmar. Nunca diga que algo foi registrado ou salvo.
- Em propose_*, o campo de valor deve ser copiado exatamente como o usuário escreveu.
- Não dê recomendações de investimento como garantia. Observações sobre gastos devem se basear nos dados.
- Respostas curtas e objetivas (até 8 linhas), valores no formato R$ 1.234,56, sem tabelas Markdown.
- Datas no formato AAAA-MM-DD nas ferramentas. Hoje é informado na mensagem.`;

const nullableString = { type: ["string", "null"] } as const;

function tool(name: string, description: string, properties: Record<string, unknown>): Anthropic.Tool {
  return {
    name,
    description,
    strict: true,
    input_schema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false },
  } as Anthropic.Tool;
}

export const TOOLS: Anthropic.Tool[] = [
  tool("get_balance", "Saldo atual do usuário, total e por conta.", {}),
  tool("get_period_totals", "Totais de receitas, despesas e resultado num período.", {
    from: { type: "string", description: "AAAA-MM-DD" },
    to: { type: "string", description: "AAAA-MM-DD" },
  }),
  tool("get_category_breakdown", "Valores por categoria num período.", {
    from: { type: "string" },
    to: { type: "string" },
    kind: { type: "string", enum: ["income", "expense"] },
  }),
  tool("get_category_total", "Total gasto/recebido numa categoria específica num período.", {
    category_name: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
  }),
  tool("list_transactions", "Lista movimentações do usuário (mais recentes ou maiores).", {
    kind: { type: ["string", "null"], enum: ["income", "expense", null] },
    from: nullableString,
    to: nullableString,
    category_name: nullableString,
    search: nullableString,
    limit: { type: "integer" },
    order: { type: "string", enum: ["recent", "largest"] },
  }),
  tool("compare_months", "Compara despesas e receitas de um mês com o anterior (no mês atual, compara o mesmo intervalo de dias).", {
    month: { type: "string", description: "AAAA-MM" },
  }),
  tool("get_cash_flow", "Receitas x despesas por mês dos últimos N meses.", { months: { type: "integer" } }),
  tool("get_balance_evolution", "Saldo no fim de cada mês dos últimos N meses.", { months: { type: "integer" } }),
  tool("get_goals", "Metas do usuário e da família: alvo, guardado, falta, prazo, ritmo e estimativa.", {}),
  tool("get_pending_bills", "Contas a pagar atrasadas e dos próximos 30 dias.", {}),
  tool("propose_transaction", "Cria um RASCUNHO de receita/despesa para o usuário confirmar.", {
    kind: { type: "string", enum: ["income", "expense"] },
    amount_text: { type: "string", description: "Trecho exato do valor como o usuário escreveu" },
    description: { type: "string" },
    category_name: nullableString,
    date: nullableString,
    status: { type: ["string", "null"], enum: ["paid", "pending", null] },
    payment_method: { type: ["string", "null"], enum: [...PAYMENT_METHODS, null] },
  }),
  tool("propose_goal", "Cria um RASCUNHO de meta para o usuário confirmar.", {
    name: { type: "string" },
    target_amount_text: { type: "string", description: "Trecho exato do valor como o usuário escreveu" },
    deadline: nullableString,
  }),
  tool("propose_goal_contribution", "Cria um RASCUNHO de contribuição (ou retirada) numa meta existente.", {
    goal_name: { type: "string" },
    amount_text: { type: "string" },
    withdraw: { type: "boolean" },
  }),
];

class ToolError extends Error {}

function dateOr(v: unknown, fallback: string) {
  return typeof v === "string" && isIsoDate(v) ? v : fallback;
}

function categoryByName(deps: AssistantDeps, name: unknown, kind?: string) {
  if (typeof name !== "string" || !name) return null;
  return deps.categories.find((c) => normalize(c.name) === normalize(name) && (!kind || c.kind === kind)) ?? null;
}

/** Valor citado pela IA precisa estar literalmente na mensagem do usuário. */
function amountFromUser(amountText: unknown, userText: string): number {
  if (typeof amountText !== "string" || !amountText.trim()) throw new ToolError("Valor ausente: pergunte ao usuário.");
  if (!normalize(userText).includes(normalize(amountText))) throw new ToolError("O valor precisa estar escrito na mensagem do usuário. Pergunte o valor.");
  const cents = parseMoneyToCents(amountText.replace(/reais|real/gi, "").trim());
  if (!cents) throw new ToolError("Valor inválido.");
  return cents;
}

async function runTool(name: string, input: Record<string, unknown>, deps: AssistantDeps, userText: string): Promise<{ data?: unknown; proposal?: Intent }> {
  const ids = [deps.user.id];
  const monthStart = `${deps.today.slice(0, 7)}-01`;
  switch (name) {
    case "get_balance":
      return { data: await getBalance(deps.db, deps.user) };
    case "get_period_totals":
      return { data: await getPeriodTotals(deps.db, ids, dateOr(input.from, monthStart), dateOr(input.to, deps.today)) };
    case "get_category_breakdown":
      return { data: await getCategoryBreakdown(deps.db, ids, dateOr(input.from, monthStart), dateOr(input.to, deps.today), input.kind === "income" ? "income" : "expense") };
    case "get_category_total": {
      const cat = categoryByName(deps, input.category_name);
      if (!cat) throw new ToolError(`Categoria não encontrada. Existentes: ${deps.categories.map((c) => c.name).join(", ")}`);
      return { data: await getCategoryTotal(deps.db, ids, cat.id, dateOr(input.from, monthStart), dateOr(input.to, deps.today)) };
    }
    case "list_transactions": {
      const cat = categoryByName(deps, input.category_name);
      return {
        data: await getTransactionsList(deps.db, ids, {
          kind: input.kind === "income" || input.kind === "expense" ? input.kind : undefined,
          from: isIsoDate(input.from) ? input.from : undefined,
          to: isIsoDate(input.to) ? input.to : undefined,
          categoryId: cat?.id,
          search: typeof input.search === "string" && input.search ? input.search.slice(0, 40) : undefined,
          limit: typeof input.limit === "number" ? input.limit : 10,
          order: input.order === "largest" ? "largest" : "recent",
        }),
      };
    }
    case "compare_months":
      return { data: await compareMonths(deps.db, ids, isYearMonth(input.month) ? input.month : deps.today.slice(0, 7)) };
    case "get_cash_flow":
      return { data: await getFlow(deps.db, ids, Math.min(12, Math.max(1, Number(input.months) || 6))) };
    case "get_balance_evolution":
      return { data: await getEvolution(deps.db, ids, Math.min(12, Math.max(1, Number(input.months) || 6))) };
    case "get_goals":
      return { data: await getGoals(deps.db, deps.user) };
    case "get_pending_bills":
      return { data: await getPendingBills(deps.db, deps.user.id) };
    case "propose_transaction": {
      const kind = input.kind === "income" ? "income" : "expense";
      const cents = amountFromUser(input.amount_text, userText);
      const cat = categoryByName(deps, input.category_name, kind) ?? deps.categories.find((c) => c.kind === kind && /^outr/i.test(normalize(c.name))) ?? null;
      let date = deps.today;
      if (isIsoDate(input.date) && input.date >= addDays(deps.today, -400) && input.date <= addDays(deps.today, 400)) date = input.date;
      const status = input.status === "pending" || input.status === "paid" ? input.status : date > deps.today ? "pending" : "paid";
      const pm = PAYMENT_METHODS.includes(input.payment_method as PaymentMethod) ? (input.payment_method as PaymentMethod) : null;
      const desc = String(input.description ?? "").trim().slice(0, 80) || cat?.name || (kind === "income" ? "Receita" : "Despesa");
      return {
        proposal: {
          type: "entry",
          draft: {
            kind, amountCents: cents, description: desc.charAt(0).toUpperCase() + desc.slice(1), categoryId: cat?.id ?? null, date, status,
            installments: null, paymentMethod: pm, accountId: null, amountText: String(input.amount_text),
          },
        },
      };
    }
    case "propose_goal": {
      const cents = amountFromUser(input.target_amount_text, userText);
      const name = String(input.name ?? "").trim().slice(0, 60);
      if (!name) throw new ToolError("Nome da meta ausente.");
      return { proposal: { type: "goal_create", name, targetCents: cents, deadline: isIsoDate(input.deadline) && input.deadline > deps.today ? input.deadline : null } };
    }
    case "propose_goal_contribution": {
      const goal = findGoal(String(input.goal_name ?? ""), deps.goals);
      if (!goal) throw new ToolError(`Meta não encontrada. Metas: ${deps.goals.map((g) => g.name).join(", ") || "nenhuma"}`);
      const cents = amountFromUser(input.amount_text, userText);
      return { proposal: { type: "goal_contribute", goalId: goal.id, goalText: goal.name, amountCents: cents, withdraw: Boolean(input.withdraw) } };
    }
    default:
      throw new ToolError("Ferramenta desconhecida.");
  }
}

/** Todos os números inteiros presentes nos resultados (valores em centavos). */
function collectNumbers(v: unknown, out: Set<number>) {
  if (typeof v === "number" && Number.isFinite(v)) out.add(Math.abs(Math.round(v)));
  else if (Array.isArray(v)) v.forEach((x) => collectNumbers(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => collectNumbers(x, out));
}

/** Verifica se todo "R$" citado no texto existe nos dados das ferramentas. */
export function validateAnswer(text: string, toolData: unknown[]): { ok: boolean; reason?: string } {
  if (/\b(registrei|registrado|registrada|salvei|salvo|salva|lancei|lançad[oa]|anotei|anotad[oa]|foi adicionad[oa])\b/i.test(text)) {
    return { ok: false, reason: "afirma registro sem confirmação" };
  }
  const allowed = new Set<number>();
  toolData.forEach((d) => collectNumbers(d, allowed));
  const amounts = [...text.matchAll(/R\$\s*(-?[\d.]+(?:,\d{1,2})?)/g)].map((m) => parseMoneyToCents(m[1].replace("-", "")));
  for (const cents of amounts) {
    if (cents === null) continue;
    if (!allowed.has(cents)) return { ok: false, reason: `valor ${cents} não consta nos dados` };
  }
  if (amounts.length && toolData.length === 0) return { ok: false, reason: "valores sem consulta" };
  return { ok: true };
}

export function createAssistant(opts: { apiKey?: string; model: string; effort: "low" | "medium" | "high"; log: Logger; client?: MessagesClient }): Assistant {
  const client: MessagesClient = opts.client ?? new Anthropic({ apiKey: opts.apiKey, timeout: 30000, maxRetries: 1 });
  return {
    async respond(text, deps) {
      const started = Date.now();
      const messages: Anthropic.MessageParam[] = [
        { role: "user", content: `Hoje é ${deps.today}. Usuário: ${deps.user.name.split(" ")[0]}.\n<mensagem>${text.slice(0, 600)}</mensagem>` },
      ];
      const toolData: unknown[] = [];
      try {
        for (let round = 0; round < MAX_ROUNDS; round++) {
          const res = await client.messages.create({
            model: opts.model,
            max_tokens: 4096,
            system: SYSTEM,
            tools: TOOLS,
            tool_choice: { type: "auto" },
            output_config: { effort: opts.effort },
            messages,
          } as Anthropic.MessageCreateParamsNonStreaming);

          if (res.stop_reason === "refusal") return { type: "none", reason: "refusal" };
          if (res.stop_reason === "max_tokens") return { type: "none", reason: "max_tokens" };

          const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
          if (res.stop_reason !== "tool_use" || !uses.length) {
            const answer = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
            if (!answer) return { type: "none", reason: "vazio" };
            const check = validateAnswer(answer, toolData);
            if (!check.ok) {
              opts.log.warn("ia.resposta_descartada", { user_id: deps.user.id, motivo: check.reason });
              return { type: "none", reason: check.reason ?? "inválida" };
            }
            opts.log.info("ia.resposta", { user_id: deps.user.id, rounds: round + 1, ms: Date.now() - started });
            return { type: "text", text: answer };
          }

          messages.push({ role: "assistant", content: res.content });
          const results: Anthropic.ToolResultBlockParam[] = [];
          for (const u of uses) {
            try {
              const out = await runTool(u.name, (u.input ?? {}) as Record<string, unknown>, deps, text);
              if (out.proposal) {
                opts.log.info("ia.proposta", { user_id: deps.user.id, tool: u.name });
                return { type: "proposal", intent: out.proposal };
              }
              toolData.push(out.data);
              results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out.data) });
            } catch (err) {
              const msg = err instanceof ToolError ? err.message : "Falha ao consultar os dados.";
              if (!(err instanceof ToolError)) opts.log.error("ia.ferramenta_erro", { tool: u.name, err: (err as Error).message });
              results.push({ type: "tool_result", tool_use_id: u.id, content: msg, is_error: true });
            }
          }
          messages.push({ role: "user", content: results });
        }
        return { type: "none", reason: "limite de rodadas" };
      } catch (err) {
        opts.log.warn("ia.falhou", { err: (err as Error).message });
        return { type: "none", reason: "erro" };
      }
    },
  };
}
