# AI Handoff — integração OpenBot + WhatsApp

> Arquivo de continuidade entre sessões. Atualize ao fim de cada etapa.

## Objetivo
Preparar o Luna Finance para um agente externo no OpenBot atender os 4 membros da família pelo WhatsApp
(pedido completo: ver o histórico da sessão / PR). Branch dedicada: `feat/openbot-whatsapp`
(criada a partir de `feat/cartoes-da-familia`, PR #1, porque usa o Wallet Stack). Não fazer merge na main.

## Decisões técnicas
- **OpenBot (pesquisado na doc e no código):** app local/servidor que roda agentes de IA; WhatsApp por
  cliente não oficial (linked device). O remetente real (`authorId`, dígitos com país) é definido pela
  plataforma, mas quem chama nossa API é o próprio agente (curl/MCP) — não há campo assinado que prove o
  remetente ao servidor. Não existe webhook de saída do OpenBot para servidores externos.
- **Por isso, autenticação em 3 camadas:** credencial da integração (`Bearer lfo_…`, hash, escopos,
  revogável) + vínculo do número por código de uso único gerado no site (ou admin) + **sessão por pessoa
  aberta com PIN pessoal** (`X-Luna-Session`), conferida contra `X-Luna-Sender` a cada chamada.
- Escritas sempre por rascunho (tabela `telegram_pending_actions`, coluna `channel='whatsapp'`),
  versionado, 15 min, confirmação atômica (`confirmPending`). Executor comum aos canais:
  `server/src/channels/execute.ts` (o Telegram passou a usar).
- Idempotência: `Idempotency-Key` obrigatório em POST (`integration_requests`) + `external_ref` no rascunho.
- Cartões/fatura: `card_settings` (titular, fechamento, vencimento, limite), `card_invoice_payments`
  (pagar fatura NÃO cria despesa). Ciclo: fatura M = compras de [fechamento M−1, fechamento M).
- Orçamentos: tabela `budgets` + `services/budgets.ts` (70/90/100%).
- Fila de avisos: `notification_queue` (dedup, claim/ack); enfileirada pelo agendador existente; nada é enviado.
- Sincronização do site: `GET /api/sync` (max(audit_log.id)) — o front faz polling e invalida queries.

## Etapas
- [x] Auditoria + pesquisa OpenBot
- [x] Migração 5 (`server/src/db/migrations.ts`) — sobe/desce/sobe testado
- [x] Serviços: `services/cards.ts`, `services/budgets.ts`, `channels/execute.ts`, origem `whatsapp`
- [x] Integração: `server/src/integrations/phone.ts`, `integrations/openbot/{identity,operations,queries,router,openapi,overview}.ts`
- [x] Fila: `server/src/notifications/queue.ts` (+ gancho em `jobs.ts`)
- [x] Rotas do site em `routes/api.ts` (/cards, /budgets, /sync, /me/whatsapp*, /integrations/openbot*)
- [x] Typecheck do servidor OK; testes do Telegram OK após refatoração (104/104)
- [ ] **Testes** `server/test/openbot.test.ts` (identificação dos 4, número não autorizado, falsificação,
      receitas/despesas, parcelado, duplicidade, retentativa, confirmação simultânea, permissões, isolamento,
      fatura, sync, fila) + teste de sincronia do `openapi.json`
- [ ] **Frontend:** Configurações → seção "Integrações" (admin + "Seu WhatsApp"), cartões/fatura e orçamentos,
      ícone WhatsApp em `pages/Transactions.tsx` (padrão do Telegram: `Send`), hook de sync em `lib/app.tsx`
- [ ] **Docs** `integrations/openbot/`: AGENT_INSTRUCTIONS.md, AGENT_INSTRUCTIONS_SHORT.md (≤2000 chars),
      TOOLS.md, openapi.json (gerar de `buildOpenApi()`), SETUP.md, TEST_CASES.md, .env.example, MCP opcional
      (`integrations/openbot/mcp/luna-mcp.mjs`, stdio JSON-RPC sem dependências); README + docs/SEGURANCA.md
- [ ] Validação final: `npm test` (use `--no-file-parallelism` se o PGlite derrubar workers no Windows),
      `npm run typecheck`, `npm run build`, `npm run e2e` (precisa do Playwright + servidor com demo:seed)
- [ ] Commit + push em `feat/openbot-whatsapp`

## Problemas conhecidos
- Vitest em paralelo no Windows às vezes derruba workers (0xC0000409, PGlite). Em série passa.

## Próxima ação exata
Escrever `server/test/openbot.test.ts` usando `setupTestApp()` de `server/test/helpers.ts`; criar
credencial via `createCredential(db, adminUser, {})`, ligar a integração com `updateSettings`, vincular por
`adminLink`, definir PIN com `setPin` (senha de teste `SenhaForte123`), abrir sessão em `POST /sessions`.
