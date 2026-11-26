# AI Handoff — integração OpenBot + WhatsApp

> Arquivo de continuidade entre sessões. Atualize ao fim de cada etapa.

## Objetivo
Preparar o Luna Finance para um agente externo no OpenBot atender os 4 membros da família pelo WhatsApp.
Branch: `feat/openbot-whatsapp` (criada de `feat/cartoes-da-familia`, PR #1, porque usa o Wallet Stack).
**Não fazer merge na main.** Sessão anterior parou por limite de consumo (88% da janela de 5 h).

## Decisões técnicas
- **OpenBot (verificado na doc e no código):** app local/servidor que roda agentes de IA; WhatsApp por cliente
  não oficial (linked device). O remetente real (`authorId`) é da plataforma, mas quem chama a API é o agente —
  nada prova o remetente ao servidor; não há webhook de saída do OpenBot.
- **Autenticação em 3 camadas:** credencial (`Bearer lfo_…`, hash, escopos link/read/write/notifications,
  revogável) + vínculo do número (código de uso único gerado no site, ou admin) + **sessão por pessoa com PIN**
  (`X-Luna-Session`, conferida contra `X-Luna-Sender` a cada chamada; 5 erros = bloqueio 15 min).
- Escrita sempre por rascunho (`telegram_pending_actions.channel='whatsapp'`), versionado, 15 min, confirmação
  atômica. Executor comum: `server/src/channels/execute.ts` (o Telegram passou a usar).
- Idempotência: `Idempotency-Key` obrigatório em POST (`integration_requests`) + `external_ref` nos rascunhos.
- Cartões/fatura: `card_settings`, `card_invoice_payments` (pagar fatura não cria despesa). Ciclo: fatura M =
  compras de [fechamento M−1, fechamento M).
- Orçamentos: `budgets` + `services/budgets.ts`. Fila de avisos: `notification_queue` (claim/ack, dedup).
- Sincronização do site: `GET /api/sync` + `useLiveSync()` (polling 20 s, invalida queries).

## Concluído (commits na branch)
- Migração 5; serviços `cards`, `budgets`, `channels/execute`; origem `whatsapp`.
- `server/src/integrations/phone.ts` e `integrations/openbot/{identity,operations,queries,router,openapi,overview}.ts`.
- `server/src/notifications/queue.ts` (+ gancho em `jobs.ts`).
- Rotas do site (`routes/api.ts`): `/cards`, `/cards/settings`, `/budgets`, `/sync`, `/me/whatsapp*`,
  `/integrations/openbot*` (painel, settings, credenciais, vínculo/PIN/sessões por pessoa, teste).
- Frontend: ícone WhatsApp em `pages/Transactions.tsx`; `useLiveSync` em `components/Layout.tsx`.
- Docs `integrations/openbot/`: AGENT_INSTRUCTIONS(.md/_SHORT.md), TOOLS.md, SETUP.md, TEST_CASES.md,
  `.env.example`, `openapi.json` (gerado por `npm run openbot:openapi`; teste garante sincronia).
- Testes: `server/test/openbot.test.ts` (38). Suíte completa: **239/239** (`npx vitest run --no-file-parallelism`).
  `npm run typecheck` OK, `npm run build` OK.

## Pendente (próximas etapas, nesta ordem)
1. **Frontend — Configurações → seção "Integrações"** em `web/src/pages/Settings.tsx` (padrão `Section`):
   - "Seu WhatsApp" (todos): status (`GET /api/me/whatsapp`), gerar código (`POST /api/me/whatsapp/link-code {phone}`),
     definir PIN (`PUT /api/me/whatsapp/pin {pin, password}`), desvincular (`DELETE /api/me/whatsapp`).
   - "OpenBot" (só `me.capabilities.manageMembers`): `GET /api/integrations/openbot` → status da API ×
     status do WhatsApp (`whatsapp.status`: no_evidence/recent_activity/no_recent_activity — nunca "conectado"),
     liga/desliga e opções (`PATCH …/settings {enabled, autoConfirm, pinRequired, sessionHours}`),
     credenciais (`POST/DELETE …/credentials`, mostrar a chave uma vez), 4 pessoas (vincular por número,
     desvincular, encerrar sessões, resetar PIN), botão Testar (`POST …/test`), histórico `events`, fila `notifications`.
   - "Cartões e fatura" (admin): `PATCH /api/cards/settings {holderUserId, closingDay, dueDay, limitCents}`.
   - "Orçamentos": `GET/POST/DELETE /api/budgets`.
   - Adicionar os links na navegação lateral de Configurações (`links` em `SettingsPage`).
2. README (seção "Integração OpenBot/WhatsApp" apontando para `integrations/openbot/SETUP.md`) e
   `docs/SEGURANCA.md` (modelo de identidade com PIN, credenciais, idempotência).
3. (Opcional) MCP: a doc do OpenBot não descreve o formato de config de MCP externo; integração oficial é HTTP+OpenAPI.
4. `npm run e2e` (Playwright + servidor com `demo:seed`; não rodado nesta sessão) e ajustar `e2e/smoke.mjs` se preciso.
5. Commit + push; abrir PR de `feat/openbot-whatsapp` (base: `feat/cartoes-da-familia` ou main depois do PR #1).

## Problemas conhecidos
- Vitest em paralelo no Windows às vezes derruba workers (0xC0000409, PGlite). Em série passa.
- Shell: heredocs grandes com aspas falham no Git Bash; grave scripts de edição em arquivo e rode com python.

## Próxima ação exata
Implementar o item 1 (seção "Integrações" em `web/src/pages/Settings.tsx`), rodar `npm run typecheck`,
`npx vitest run --no-file-parallelism`, `npm run build`, verificar no navegador (preview `luna-web` + `luna-api`,
login demo `lipe@demo.luna`), atualizar este arquivo, commit e push.
