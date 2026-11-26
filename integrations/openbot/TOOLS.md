# Ferramentas do agente Luna (API do Luna Finance)

Base: `{LUNA_API_URL}/api/integrations/openbot/v1` · Especificação completa: `openapi.json` (também em `GET /openapi.json`).

## Cabeçalhos
| Cabeçalho | Quando | Valor |
|---|---|---|
| `Authorization` | sempre | `Bearer {LUNA_OPENBOT_API_KEY}` |
| `X-Luna-Sender` | rotas da pessoa | `authorId` do remetente (plataforma), ex.: `5511987654321` |
| `X-Luna-Session` | rotas da pessoa | token `lfs_…` de `POST /sessions` |
| `Idempotency-Key` | todo POST (exceto /sessions e /interpret) | `wa:<authorId>:<idMensagem>:<operação>` |

Valores em **centavos** (`amountCents`). Datas `AAAA-MM-DD` (America/Sao_Paulo). Erros: `{ "error": { "code", "message", "details" } }`.

## Conexão
| Ferramenta | Chamada | Uso |
|---|---|---|
| health | `GET /health` | teste de conectividade |
| vincular | `POST /links/claim {phone, code}` | primeira vez da pessoa |
| abrir sessão | `POST /sessions {phone, pin}` | depois do PIN |
| encerrar | `DELETE /sessions/current` | "sair" |

## Consultas (somente leitura)
| Pergunta | Chamada |
|---|---|
| Quem sou / meu cartão | `GET /me` |
| Categorias, contas, formas de pagamento | `GET /catalog` |
| Saldo | `GET /balance?scope=me|family` |
| Quanto gastei/recebi | `GET /summary?period=this_month` (ou `month=2026-11`, `from`/`to`, `scope`) |
| Últimos lançamentos | `GET /transactions?period=this_month&kind=expense&limit=10` |
| Quanto posso gastar | `GET /spendable` |
| Cartões, fatura atual, limite | `GET /cards` |
| Fatura de um mês | `GET /invoices?month=2026-12` |
| Orçamentos | `GET /budgets` |
| Metas | `GET /goals` |
| Contas a pagar | `GET /bills?days=15` |
| Relatório | `GET /reports?scope=family&month=2026-11` |
| Conferir interpretação | `POST /interpret {text}` (não grava) |

## Escrita (rascunho → confirmação)
```http
POST /drafts/transactions
Idempotency-Key: wa:5511987654321:3EB0C767D26A:expense
{ "kind": "expense", "amountCents": 25000, "categoryName": "Mercado", "paymentMethod": "pix",
  "originalText": "Paguei 250 de mercado no Pix" }
→ 202 { "status": "pending_confirmation", "draft": { "id": "…", "version": 1, "summary": "Despesa: Mercado — R$ 250,00 · …", "warnings": [] } }

POST /drafts/{id}/confirm        Idempotency-Key: wa:5511987654321:3EB0C767D26B:confirm
{ "version": 1 }
→ 201 { "status": "committed", "result": { "kind": "transaction", "transactions": [ { "id": 812, "amountCents": 25000, "source": "whatsapp", … } ] } }
```
| Ação | Chamada | Exemplo de corpo |
|---|---|---|
| Despesa/receita | `POST /drafts/transactions` | `{ kind, amountCents \| amount, description, categoryName, paymentMethod, date, originalText }` |
| Parcelada | idem | `{ kind: "expense", amountCents: 360000, installments: 12, paymentMethod: "credit_card" }` |
| Recorrente | idem | `{ kind: "expense", amountCents: 12990, description: "Internet", recurrence: { autoPaid: false } }` |
| Transferência | `POST /drafts/transfers` | `{ amountCents, fromAccountName, toAccountName }` |
| Correção | `POST /drafts/corrections` | `{ target: { last: "expense" }, changes: { amountCents: 15000 } }` |
| Exclusão | `POST /drafts/deletions` | `{ target: { transactionId: 812 } }` |
| Pagar fatura (titular) | `POST /drafts/invoice-payments` | `{ invoiceMonth: "2026-12" }` |
| Confirmar | `POST /drafts/{id}/confirm` | `{ version }` |
| Cancelar | `POST /drafts/{id}/cancel` | `{}` |

`status` possíveis: `pending_confirmation` (202), `committed` (201), `needs_info` (422 — pergunte o que está em `missing`).

## Avisos
| Chamada | Uso |
|---|---|
| `GET /notifications/pending?limit=20` | reserva avisos por 5 min (`recipient.phoneE164`, `payload.text`) |
| `POST /notifications/{id}/ack {claimToken, status}` | `delivered` ou `failed` |

Tipos: `bill_due`, `bill_overdue`, `invoice_due`, `budget_70|90|100`, `card_limit_90|100`, `weekly_summary`, `monthly_report` (com evolução individual e consolidado da família para quem tem acesso).

## Códigos de erro frequentes
`invalid_credentials` (401) · `session_required` / `session_expired` (401) · `invalid_pin` (401) · `not_linked` / `pin_not_set` (403) · `forbidden` (403) · `insufficient_scope` (403) · `draft_not_found` (404) · `version_mismatch` / `already_confirmed` / `draft_cancelled` / `draft_expired` / `request_in_progress` (409) · `idempotency_key_reused` (422) · `rate_limited` (429) · `integration_disabled` (503).

## MCP
O OpenBot repassa servidores MCP aos provedores (Claude Code, Codex…), mas a documentação não descreve o formato de configuração de servidores externos. Por isso a integração oficial é **HTTP + OpenAPI** (acima). Um servidor MCP fino pode ser criado depois sobre estas mesmas rotas, sem mudar o Luna.
