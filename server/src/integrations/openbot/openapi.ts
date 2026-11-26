/**
 * Especificação OpenAPI 3.1 da API de integração do OpenBot.
 * Fonte única: o arquivo integrations/openbot/openapi.json é gerado daqui
 * (`npm run openbot:openapi`) e um teste garante que os dois não divergem.
 */
const errorRef = { $ref: "#/components/schemas/Error" };
const json = (schema: unknown, example?: unknown) => ({ "application/json": { schema, ...(example !== undefined ? { example } : {}) } });
const err = (description: string, code: string, message: string) => ({
  description,
  content: json(errorRef, { error: { code, message } }),
});

const COMMON_ERRORS = {
  "401": err("Credencial inválida/revogada, sessão ausente/expirada ou PIN incorreto.", "session_expired", "Sessão expirada ou encerrada. Abra outra com o PIN."),
  "403": err("Sem permissão (escopo da credencial, número não autorizado, sessão de outro remetente ou dado de outra pessoa).", "forbidden", "Você não tem permissão para esta ação."),
  "429": err("Limite de requisições ou PIN bloqueado.", "rate_limited", "Muitas tentativas. Aguarde alguns minutos."),
  "503": err("Integração desligada no Luna.", "integration_disabled", "A integração com o OpenBot está desligada no Luna."),
};
const WRITE_ERRORS = {
  ...COMMON_ERRORS,
  "400": err("Dados inválidos (validação Zod).", "bad_request", "O valor precisa ser maior que zero."),
  "409": err("Operação em andamento com a mesma chave, rascunho já confirmado/cancelado/expirado ou versão desatualizada.", "version_mismatch", "Este resumo foi alterado. Use a versão mais recente, logo abaixo."),
  "422": err("Idempotency-Key reutilizada com outro conteúdo, ou faltam informações (status needs_info no corpo de sucesso).", "idempotency_key_reused", "Esta Idempotency-Key já foi usada com outro conteúdo."),
};

const member = [{ bearerAuth: [], memberSession: [], sender: [] }];
const credOnly = [{ bearerAuth: [] }];
const idem = { $ref: "#/components/parameters/IdempotencyKey" };
const scopeParam = { $ref: "#/components/parameters/Scope" };
const periodParams = [
  scopeParam,
  { name: "period", in: "query", schema: { type: "string", enum: ["today", "this_week", "this_month", "last_month", "last_30_days", "this_year"] }, description: "Período nomeado (ou use month / from+to)." },
  { name: "month", in: "query", schema: { type: "string", pattern: "^\\d{4}-\\d{2}$" }, example: "2026-11" },
  { name: "from", in: "query", schema: { type: "string", format: "date" } },
  { name: "to", in: "query", schema: { type: "string", format: "date" } },
];

const draftOutcomeExamples = {
  pending: {
    summary: "Despesa aguardando confirmação",
    value: {
      status: "pending_confirmation",
      draft: {
        id: "Qm9vYm9vYm9v", version: 1, kind: "transaction", status: "pending", expiresAt: "2026-11-26T15:15:00.000Z",
        summary: "Despesa: Restaurante — R$ 85,00 · Alimentação fora · Pix · 2026-11-26 · paga",
        data: { kind: "expense", amountCents: 8500, description: "Restaurante", categoryId: 4, categoryName: "Alimentação fora", date: "2026-11-26", status: "paid", paymentMethod: "pix", installments: null, accountName: "Conta principal" },
        warnings: [],
        confirmationReasons: ["confirmation_required"],
      },
    },
  },
  needsInfo: { summary: "Faltou o valor", value: { status: "needs_info", missing: ["amount"], message: "Qual foi o valor? Não registro nada sem o valor informado pela pessoa." } },
};

function writeOp(summary: string, description: string, bodySchema: string, example: unknown, opId: string) {
  return {
    post: {
      operationId: opId,
      summary,
      description,
      tags: ["Rascunhos"],
      security: member,
      parameters: [idem],
      requestBody: { required: true, content: json({ $ref: `#/components/schemas/${bodySchema}` }, example) },
      responses: {
        "202": { description: "Rascunho criado — mostre `draft.summary` e peça confirmação.", content: { "application/json": { schema: { $ref: "#/components/schemas/WriteOutcome" }, examples: { pending: draftOutcomeExamples.pending } } } },
        "201": { description: "Gravado direto (confirmação automática ligada e sem nenhum motivo para confirmar).", content: json({ $ref: "#/components/schemas/WriteOutcome" }) },
        ...WRITE_ERRORS,
        "422": { description: "Faltam informações (`status: needs_info`) ou Idempotency-Key reutilizada.", content: { "application/json": { schema: { oneOf: [{ $ref: "#/components/schemas/WriteOutcome" }, errorRef] }, examples: { needsInfo: draftOutcomeExamples.needsInfo } } } },
      },
    },
  };
}

function readOp(opId: string, summary: string, description: string, params: unknown[] = [], example?: unknown) {
  return {
    get: {
      operationId: opId,
      summary,
      description,
      tags: ["Consultas"],
      security: member,
      parameters: params,
      responses: { "200": { description: "OK", content: json({ type: "object" }, example) }, ...COMMON_ERRORS },
    },
  };
}

export function buildOpenApi() {
  return {
    openapi: "3.1.0",
    info: {
      title: "Luna Finance — API de integração OpenBot (WhatsApp)",
      version: "1.0.0",
      description:
        "API exclusiva para o agente Luna no OpenBot atender a família pelo WhatsApp. O OpenBot interpreta e conversa; o Luna valida, autoriza, calcula e grava.\n\n" +
        "Autenticação em três camadas: (1) `Authorization: Bearer lfo_…` — credencial da integração, criada e revogada no site; " +
        "(2) `X-Luna-Session` — sessão da pessoa, aberta em POST /sessions com o número vinculado + PIN pessoal; " +
        "(3) `X-Luna-Sender` — o número do remetente exatamente como a plataforma do OpenBot informou (authorId), nunca um número citado no texto.\n\n" +
        "Toda escrita vira um rascunho versionado (15 min) que precisa de POST /drafts/{id}/confirm. Todo POST exige `Idempotency-Key` (use o id da mensagem do WhatsApp + a operação): repetir a mesma chave devolve a mesma resposta, sem duplicar.\n\n" +
        "Valores sempre em centavos inteiros (`amountCents`); datas AAAA-MM-DD no fuso America/Sao_Paulo.",
    },
    servers: [{ url: "{baseUrl}/api/integrations/openbot/v1", variables: { baseUrl: { default: "https://seu-dominio-do-luna" } } }],
    tags: [
      { name: "Conexão", description: "Saúde, vínculo do número e sessões." },
      { name: "Consultas", description: "Somente leitura, no escopo e nas permissões da pessoa." },
      { name: "Rascunhos", description: "Escrita em duas etapas: rascunho → confirmação." },
      { name: "Avisos", description: "Fila de notificações para o OpenBot entregar." },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer", description: "Credencial da integração (lfo_…). Criada em Configurações → Integrações; aparece uma única vez." },
        memberSession: { type: "apiKey", in: "header", name: "X-Luna-Session", description: "Token da sessão da pessoa (lfs_…), devolvido por POST /sessions." },
        sender: { type: "apiKey", in: "header", name: "X-Luna-Sender", description: "Número do remetente informado pela plataforma (ex.: 5511987654321). Precisa ser o mesmo da sessão." },
      },
      parameters: {
        IdempotencyKey: { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string", pattern: "^[A-Za-z0-9:._@-]{8,200}$" }, example: "wa:5511987654321:3EB0C767D26A1D2F:expense" },
        Scope: { name: "scope", in: "query", schema: { oneOf: [{ type: "string", enum: ["me", "family"] }, { type: "integer" }], default: "me" }, description: "me (padrão), family, ou o id de outra pessoa — sujeito às permissões dela." },
      },
      schemas: {
        Error: {
          type: "object",
          required: ["error"],
          properties: { error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" }, details: {} } } },
        },
        Warning: { type: "object", properties: { code: { type: "string", enum: ["amount_mismatch", "kind_mismatch", "no_category", "card_not_registered", "invoice_info", "possible_duplicate", "installment", "no_double_count"] }, message: { type: "string" }, details: {} } },
        Draft: {
          type: "object",
          properties: {
            id: { type: "string" },
            version: { type: "integer" },
            kind: { type: "string", enum: ["transaction", "transfer", "tx_update", "tx_delete", "invoice_payment"] },
            status: { type: "string", enum: ["pending", "confirmed", "cancelled", "expired"] },
            expiresAt: { type: "string", format: "date-time" },
            summary: { type: "string", description: "Texto pronto para mostrar à pessoa antes de confirmar." },
            data: { type: "object" },
            warnings: { type: "array", items: { $ref: "#/components/schemas/Warning" } },
            confirmationReasons: { type: "array", items: { type: "string", enum: ["confirmation_required", "installments", "recurrence", "possible_duplicate", "amount_mismatch", "kind_mismatch", "no_category", "card_not_registered", "date_not_today", "transfer", "correction", "deletion", "invoice_payment"] } },
          },
        },
        WriteOutcome: {
          type: "object",
          required: ["status"],
          properties: {
            status: { type: "string", enum: ["pending_confirmation", "committed", "needs_info"] },
            draft: { $ref: "#/components/schemas/Draft" },
            result: { type: "object", description: "Dados efetivamente gravados (status committed)." },
            missing: { type: "array", items: { type: "string" } },
            message: { type: "string" },
            partial: { type: "object" },
          },
        },
        TransactionDraftInput: {
          type: "object",
          additionalProperties: false,
          required: ["kind"],
          properties: {
            kind: { type: "string", enum: ["expense", "income"] },
            amountCents: { type: "integer", minimum: 1, description: "Valor em centavos (preferido). Para parcelado, o TOTAL, salvo amountIsPerInstallment." },
            amount: { oneOf: [{ type: "number" }, { type: "string" }], description: "Alternativa: valor em reais como escrito ('3.600', '85,50')." },
            description: { type: "string", maxLength: 160 },
            categoryId: { type: "integer" },
            categoryName: { type: "string", maxLength: 60 },
            date: { type: "string", format: "date", description: "Padrão: hoje (America/Sao_Paulo)." },
            status: { type: "string", enum: ["paid", "pending"] },
            paymentMethod: { type: "string", enum: ["pix", "credit_card", "debit_card", "cash", "boleto", "transfer", "other"] },
            accountId: { type: "integer" },
            installments: { type: "integer", minimum: 2, maximum: 72 },
            amountIsPerInstallment: { type: "boolean" },
            recurrence: { type: "object", properties: { endDate: { type: ["string", "null"], format: "date" }, autoPaid: { type: "boolean" } } },
            notes: { type: "string", maxLength: 500 },
            originalText: { type: "string", maxLength: 500, description: "Texto original da mensagem. O Luna confere com o parser determinístico e avisa divergências." },
          },
        },
        Target: {
          oneOf: [
            { type: "object", additionalProperties: false, required: ["transactionId"], properties: { transactionId: { type: "integer" } } },
            { type: "object", additionalProperties: false, required: ["last"], properties: { last: { type: "string", enum: ["expense", "income", "any"] } } },
          ],
        },
        CorrectionInput: {
          type: "object",
          additionalProperties: false,
          required: ["target", "changes"],
          properties: {
            target: { $ref: "#/components/schemas/Target" },
            changes: {
              type: "object",
              additionalProperties: false,
              properties: {
                amountCents: { type: "integer" }, amount: { oneOf: [{ type: "number" }, { type: "string" }] }, description: { type: "string" }, date: { type: "string", format: "date" },
                categoryId: { type: "integer" }, categoryName: { type: "string" }, paymentMethod: { type: "string" }, status: { type: "string", enum: ["paid", "pending"] },
              },
            },
          },
        },
        DeletionInput: { type: "object", additionalProperties: false, required: ["target"], properties: { target: { $ref: "#/components/schemas/Target" } } },
        TransferInput: {
          type: "object",
          additionalProperties: false,
          properties: {
            amountCents: { type: "integer" }, amount: { oneOf: [{ type: "number" }, { type: "string" }] }, fromAccountId: { type: "integer" }, fromAccountName: { type: "string" },
            toAccountId: { type: "integer" }, toAccountName: { type: "string" }, date: { type: "string", format: "date" },
          },
        },
        InvoicePaymentInput: {
          type: "object",
          additionalProperties: false,
          properties: { invoiceMonth: { type: "string", pattern: "^\\d{4}-\\d{2}$" }, amountCents: { type: "integer" }, amount: { oneOf: [{ type: "number" }, { type: "string" }] }, paidAt: { type: "string", format: "date" } },
        },
      },
    },
    paths: {
      "/health": {
        get: {
          operationId: "health", summary: "Teste de conectividade", tags: ["Conexão"], security: credOnly,
          description: "Confirma credencial e banco. Funciona com a integração desligada (informa `integrationEnabled`). Registra a última comunicação no painel do Luna.",
          responses: { "200": { description: "OK", content: json({ type: "object" }, { ok: true, version: "1.0.0", integrationEnabled: true, pinRequired: true, autoConfirm: false, time: "2026-11-26T15:00:00.000Z", timezone: "America/Sao_Paulo" }) }, "401": COMMON_ERRORS["401"] },
        },
      },
      "/links/claim": {
        post: {
          operationId: "claimLink", summary: "Vincular o número com o código de uso único", tags: ["Conexão"], security: credOnly, parameters: [idem],
          description: "A pessoa gera o código no site (logada, informando o próprio número). Ela envia o código pelo WhatsApp; o agente chama esta rota com o número do REMETENTE (da plataforma) + o código. O código vale 10 min, uma vez, e só para aquele número.",
          requestBody: { required: true, content: json({ type: "object", required: ["phone", "code"], properties: { phone: { type: "string" }, code: { type: "string" } } }, { phone: "5511987654321", code: "K7M2Q9PX" }) },
          responses: { "200": { description: "Vinculado", content: json({ type: "object" }, { linked: true, member: { userId: 3, name: "Lipe" }, pinSet: true, next: "Abra a sessão com POST /sessions (número + PIN)." }) }, "400": err("Código inválido/expirado/de outro número (resposta única).", "invalid_code", "Código inválido ou expirado. Gere outro no site."), ...COMMON_ERRORS },
        },
      },
      "/sessions": {
        post: {
          operationId: "openSession", summary: "Abrir a sessão da pessoa (número + PIN)", tags: ["Conexão"], security: credOnly,
          description: "Número = remetente informado pela plataforma. PIN = 6–8 dígitos definidos pela pessoa no site. 5 erros bloqueiam por 15 min. A sessão dura o tempo configurado (padrão 12 h) e é revogada ao desvincular, trocar o PIN, desligar a integração ou revogar a credencial.",
          requestBody: { required: true, content: json({ type: "object", required: ["phone"], properties: { phone: { type: "string" }, pin: { type: "string" } } }, { phone: "5511987654321", pin: "482915" }) },
          responses: {
            "201": { description: "Sessão aberta", content: json({ type: "object" }, { sessionToken: "lfs_…", expiresAt: "2026-11-27T03:00:00.000Z", member: { userId: 3, name: "Lipe", relation: "Filho 1", familyAccess: "full" } }) },
            "403": err("Número não vinculado, pessoa inativa ou PIN ainda não definido.", "not_linked", "Número não autorizado. Peça o código de vinculação no site do Luna."),
            "401": err("PIN incorreto.", "invalid_pin", "PIN incorreto."),
            "429": COMMON_ERRORS["429"],
            "503": COMMON_ERRORS["503"],
          },
        },
      },
      "/sessions/current": {
        delete: { operationId: "closeSession", summary: "Encerrar a sessão atual", tags: ["Conexão"], security: member, responses: { "200": { description: "Encerrada", content: json({ type: "object" }, { closed: true }) }, ...COMMON_ERRORS } },
      },
      "/me": readOp("me", "Quem é a pessoa da sessão", "Nome, parentesco, permissão de família e cartão (final, titular da fatura).", [], { userId: 3, name: "Lipe", relation: "Filho 1", familyAccess: "full", card: { last4: "7310", registered: true, isInvoiceHolder: false }, timezone: "America/Sao_Paulo", today: "2026-11-26" }),
      "/catalog": readOp("catalog", "Categorias, contas e formas de pagamento", "Use os ids daqui nos rascunhos. Contas: só as da própria pessoa."),
      "/balance": readOp("balance", "Saldo registrado", "Saldo das contas (me) ou total da família (family, conforme permissão).", [scopeParam]),
      "/summary": readOp("summary", "Receitas e despesas do período", "Totais e principais categorias. Responde 'quanto gastei este mês?'.", periodParams),
      "/transactions": readOp("listTransactions", "Lançamentos do período", "Exige acesso aos lançamentos do escopo pedido.", [
        ...periodParams,
        { name: "kind", in: "query", schema: { type: "string", enum: ["income", "expense"] } },
        { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 10 } },
        { name: "q", in: "query", schema: { type: "string" } },
      ]),
      "/spendable": readOp("spendable", "Quanto ainda posso gastar", "Saldo − contas pendentes até o fim do mês + receitas pendentes; orçamentos e limite do cartão quando cadastrados."),
      "/cards": readOp("cards", "Cartões, fatura atual e limite", "Cartões cadastrados (final), fatura consolidada atual (ciclo), limite compartilhado e gastos do mês por titular."),
      "/invoices": readOp("invoice", "Fatura de um mês", "Fatura consolidada (ciclo de fechamento) e, para comparar, os gastos no cartão do mês calendário.", [{ name: "month", in: "query", schema: { type: "string", pattern: "^\\d{4}-\\d{2}$" } }]),
      "/budgets": readOp("budgets", "Orçamentos e quanto resta", "Situação de cada orçamento visível (70/90/100%).", [{ name: "month", in: "query", schema: { type: "string" } }]),
      "/goals": readOp("goals", "Metas financeiras", "Metas visíveis com progresso e ritmo."),
      "/bills": readOp("bills", "Contas a pagar", "Atrasadas e a vencer nos próximos dias.", [{ name: "days", in: "query", schema: { type: "integer", default: 15 } }]),
      "/reports": readOp("reports", "Relatório individual ou da família", "Mesmo relatório do site (mês ou ano), conforme permissões.", [scopeParam, { name: "month", in: "query", schema: { type: "string" } }, { name: "year", in: "query", schema: { type: "string" } }]),
      "/interpret": {
        post: {
          operationId: "interpret", summary: "Interpretar uma frase (sem gravar, sem IA)", tags: ["Consultas"], security: member,
          description: "Usa o mesmo parser do bot do Telegram para sugerir a intenção estruturada. Opcional: o agente pode mandar a intenção direto para os rascunhos.",
          requestBody: { required: true, content: json({ type: "object", required: ["text"], properties: { text: { type: "string", maxLength: 500 } } }, { text: "Comprei um celular de 3.600 em 12 vezes no cartão" }) },
          responses: { "200": { description: "Sugestão", content: json({ type: "object" }) }, ...COMMON_ERRORS },
        },
      },
      "/drafts/transactions": writeOp(
        "Rascunho de despesa/receita (simples, parcelada ou recorrente)",
        "Sem valor explícito → needs_info. Parcelado, recorrente, duplicidade provável, divergência com o texto, cartão não cadastrado ou data diferente de hoje SEMPRE pedem confirmação.",
        "TransactionDraftInput",
        { kind: "expense", amountCents: 8500, description: "Restaurante", categoryName: "Alimentação fora", paymentMethod: "pix", originalText: "Gastei 85 reais no restaurante" },
        "draftTransaction",
      ),
      "/drafts/transfers": writeOp("Rascunho de transferência entre contas da própria pessoa", "Não é receita nem despesa.", "TransferInput", { amountCents: 50000, fromAccountName: "Conta principal", toAccountName: "Poupança" }, "draftTransfer"),
      "/drafts/corrections": writeOp("Rascunho de correção", "Ex.: 'corrige minha última despesa para 150'. Sempre pede confirmação.", "CorrectionInput", { target: { last: "expense" }, changes: { amountCents: 15000 } }, "draftCorrection"),
      "/drafts/deletions": writeOp("Rascunho de exclusão", "Exclui um lançamento da própria pessoa. Sempre pede confirmação.", "DeletionInput", { target: { last: "expense" } }, "draftDeletion"),
      "/drafts/invoice-payments": writeOp("Rascunho de pagamento da fatura", "Só o titular. Marca a fatura como paga sem criar despesa (as compras já foram contadas).", "InvoicePaymentInput", { invoiceMonth: "2026-11" }, "draftInvoicePayment"),
      "/drafts/{id}": {
        get: {
          operationId: "getDraft", summary: "Ver um rascunho", tags: ["Rascunhos"], security: member,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "OK", content: json({ $ref: "#/components/schemas/Draft" }) }, "404": err("Não existe ou é de outra pessoa/canal.", "not_found", "Rascunho não encontrado."), ...COMMON_ERRORS },
        },
      },
      "/drafts/{id}/confirm": {
        post: {
          operationId: "confirmDraft", summary: "Confirmar e gravar (atômico)", tags: ["Rascunhos"], security: member,
          description: "Só depois de a pessoa dizer 'sim' ao resumo. Envie a `version` mostrada. Confirmações simultâneas: só uma grava. Repetir com o mesmo rascunho confirmado devolve o resultado gravado.",
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, idem],
          requestBody: { required: true, content: json({ type: "object", required: ["version"], properties: { version: { type: "integer" } } }, { version: 1 }) },
          responses: {
            "201": { description: "Gravado", content: json({ type: "object" }, { status: "committed", replayed: false, result: { kind: "transaction", transactions: [{ id: 812, kind: "expense", amountCents: 8500, description: "Restaurante", categoryName: "Alimentação fora", date: "2026-11-26", status: "paid", paymentMethod: "pix", source: "whatsapp" }] } }) },
            "404": err("Rascunho inexistente ou de outra pessoa.", "draft_not_found", "Esta ação não está mais disponível."),
            ...WRITE_ERRORS,
          },
        },
      },
      "/drafts/{id}/cancel": {
        post: {
          operationId: "cancelDraft", summary: "Cancelar um rascunho", tags: ["Rascunhos"], security: member,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }, idem],
          responses: { "200": { description: "Cancelado", content: json({ type: "object" }, { status: "cancelled" }) }, ...WRITE_ERRORS },
        },
      },
      "/notifications/pending": {
        get: {
          operationId: "claimNotifications", summary: "Reservar avisos para entregar", tags: ["Avisos"], security: credOnly,
          description: "Reserva até `limit` avisos por 5 minutos. Entregue cada um ao `recipient.phoneE164` e confirme com /ack. Sem ack, voltam para a fila. Nenhuma mensagem é enviada pelo Luna.",
          parameters: [{ name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 50, default: 20 } }],
          responses: { "200": { description: "Avisos reservados", content: json({ type: "object" }, { items: [{ id: 41, kind: "budget_90", claimToken: "…", recipient: { userId: 1, name: "Luís Carlos", phoneE164: "+5511900000000" }, payload: { title: "Orçamento perto do limite", text: "Orçamento da família de Mercado: R$ 1.820,00 de R$ 2.000,00 (91%).", data: {} }, attempt: 1 }] }) }, ...COMMON_ERRORS },
        },
      },
      "/notifications/{id}/ack": {
        post: {
          operationId: "ackNotification", summary: "Confirmar entrega (ou falha) de um aviso", tags: ["Avisos"], security: credOnly,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "integer" } }, idem],
          requestBody: { required: true, content: json({ type: "object", required: ["claimToken", "status"], properties: { claimToken: { type: "string" }, status: { type: "string", enum: ["delivered", "failed"] }, error: { type: "string" } } }) },
          responses: { "200": { description: "OK", content: json({ type: "object" }, { ok: true }) }, "409": err("Reserva inválida ou já confirmada.", "not_claimed", "Aviso não reservado por esta entrega."), ...COMMON_ERRORS },
        },
      },
    },
  };
}
