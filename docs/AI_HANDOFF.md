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

- **Frontend — Configurações → Integrações** (sessão de 26/11/2026): `web/src/pages/SettingsIntegrations.tsx`
  (`WhatsAppSection`, `OpenBotSection`, `CardsSettingsSection`, `BudgetsSection`), `Section` extraído para
  `web/src/components/SettingsSection.tsx`, helper `put` em `web/src/lib/api.ts`, links na navegação lateral
  (Integrações: Seu WhatsApp, OpenBot*; Finanças: Orçamentos, Cartões e fatura*; *só `manageMembers`), CSS
  `.integration-status`, `.list-item.ob-member`, `.list-item.budget-row` em `styles/pages.css`.
  Só usa rotas existentes; nenhuma mudança no backend.
- README (seção "Integração OpenBot/WhatsApp") e `docs/SEGURANCA.md` (seção "WhatsApp via OpenBot").
- `e2e/smoke.mjs`: verifica "Seu WhatsApp"/"Orçamentos" para todos e OpenBot/cartões só para quem gerencia.
- Verificação: `npm run typecheck` OK · `npx vitest run --no-file-parallelism` **239/239** · `npm run build` OK ·
  `npm run e2e` **23/23** (servidor `npm start` + PGlite com `db:migrate` + `demo:seed`). Fluxos exercitados no
  Chromium (Playwright): gerar código, definir PIN, ligar integração, criar credencial (chave exibida uma vez;
  `GET /health` com ela = 200), vincular número pelo painel, testar integração, criar orçamento, salvar cartão;
  login de não-gestor sem OpenBot/cartões; 375 px sem rolagem horizontal; zero erros de JS.

- Sessão de 27/11/2026: login demo do Lipe virou `lipe@demo` / `teste123` (demais: `DemoLuna2026`);
  `npm run demo:local` (scripts/demo-local.mjs) recria o banco de demo e sobe API + site num comando, conferindo
  as portas 3000/5173; **nova logo** (husky no círculo roxo) em `web/public/brand/`, usada pelo `LunaMark`
  (menu, topo no celular, login) e nos favicons; `luna.svg` removido. e2e 23/23.

## Pendente (próximas etapas, nesta ordem)
1. Abrir PR de `feat/openbot-whatsapp` (base: `feat/cartoes-da-familia`, ou `main` depois do PR #1). **Sem merge na main.**
2. Teste ponta a ponta real com o OpenBot + WhatsApp (seguir `integrations/openbot/TEST_CASES.md`) — exige a
   instalação do OpenBot e um número; não é possível no container.
3. (Opcional) MCP: a doc do OpenBot não descreve config de MCP externo; integração oficial segue HTTP+OpenAPI.
4. (Opcional) Versão simplificada da logo para tamanhos ≤ 32 px (favicon); logo no cabeçalho do PDF de relatórios;
   foto do bot do Telegram (trocada pelo @BotFather, não pelo código).

## Problemas conhecidos
- Vitest em paralelo no Windows às vezes derruba workers (0xC0000409, PGlite). Em série passa.
- Shell: heredocs grandes com aspas falham no Git Bash; grave scripts de edição em arquivo e rode com python.

## Próxima ação exata
Abrir o PR de `feat/openbot-whatsapp` (item 1) e, com o OpenBot instalado, rodar os cenários de
`integrations/openbot/TEST_CASES.md`. Para ver o app no computador do usuário (Windows/cmd): feche terminais antigos
do Luna, `git pull origin feat/openbot-whatsapp`, `npm install`, `npm run demo:local` → http://localhost:5173
(`lipe@demo` / `teste123`). "Algo deu errado" no login = API (porta 3000) fora do ar, não senha errada.
