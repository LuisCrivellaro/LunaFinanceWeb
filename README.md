# Luna Finance

Gestão financeira da família — pelo site e pelo Telegram, no mesmo banco de dados.

- **Painel** com saldo, receitas, despesas, resultado do mês, evolução do patrimônio, gastos por categoria, próximos pagamentos, contas atrasadas, metas e resumo por pessoa — alternando entre visão **individual** e **familiar**.
- **Movimentações**: receitas e despesas, categorias personalizadas, fixas/variáveis, parcelamentos, recorrência mensal, vencimentos, filtros, pesquisa, edição e exclusão.
- **Contas a pagar**: atrasadas, a vencer, pagas, recorrentes e histórico.
- **Transferências** entre contas próprias (não contam como receita/despesa).
- **Metas** individuais e familiares, com contribuições, retiradas e progresso (fases da lua 🌒).
- **Relatórios** mensais e anuais, por categoria e por responsável, com exportação **CSV** e **PDF** (impressão).
- **Bot do Telegram**: menu com botões (💸 Gastei, 💰 Recebi, 📈 Economizei, 📊 Meu resumo, 🎯 Minhas metas, ⚙️ Configurações) e registro por linguagem natural (valor, data, categoria, conta e forma de pagamento) com resumo, edição e confirmação; consultas e relatórios; metas; pagamento de contas; avisos automáticos; IA opcional com ferramentas controladas. Guia: [`docs/TELEGRAM.md`](docs/TELEGRAM.md).
- **WhatsApp via OpenBot** (opcional): um agente externo no OpenBot atende a família pelo WhatsApp e usa a API do Luna (consultas, lançamentos com confirmação, fatura, orçamentos e avisos). Configuração em **Configurações → Integrações**. Veja abaixo.

## Stack

| Camada | Escolha | Por quê |
|---|---|---|
| Backend | Node 22 + Express 5 + TypeScript | simples, um processo só (API + webhook + agendador) |
| Banco | PostgreSQL (`pg`) — ou PGlite em dev/testes | o mesmo SQL nos dois; sem instalar nada para desenvolver |
| Frontend | React 19 + Vite + TanStack Query + Recharts | servido pelo próprio backend (mesma origem); visual em [`docs/DESIGN.md`](docs/DESIGN.md) |
| Validação | Zod | toda entrada da API é validada no servidor |
| IA (opcional) | Claude (Anthropic SDK) | só para interpretar frases difíceis do bot |

Valores monetários são guardados em **centavos inteiros** (sem float). Datas de calendário seguem o fuso `America/Sao_Paulo`.

## Rodando localmente

```bash
npm install
cp .env.example .env          # pode deixar DATABASE_URL vazio: usa PGlite em .data/
npm run demo:seed             # opcional: família fictícia (lipe@demo / teste123; demais: DemoLuna2026)
npm run dev                   # API em :3000 e site em http://localhost:5173 (baixa a fonte Satoshi na 1ª vez)
```

Para usar dados reais em vez da demonstração, apague `.data/` e veja **Primeiro acesso da família** abaixo.

## Produção

1. **Banco Postgres gerenciado** (Neon, Supabase, Railway, RDS…) com backup automático habilitado. Copie a URL de conexão para `DATABASE_URL`.
2. **Hospedagem** de um container Docker sempre ativo (Railway, Render, Fly.io, VPS). `Dockerfile` e `railway.json` prontos. Obrigatórias: `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` (e `APP_URL=https://seu-dominio` fora do Railway/Render). Passo a passo: [`docs/TELEGRAM.md` §4.2](docs/TELEGRAM.md#passo-a-passo).
   - Se o plano da hospedagem "dormir" quando não há acesso, as notificações não saem. Nesse caso defina `CRON_SECRET` e agende um cron externo: `POST https://seu-dominio/api/cron/run` com `Authorization: Bearer <CRON_SECRET>` a cada 15–30 min.
3. As migrações rodam sozinhas ao iniciar (`npm run db:migrate` também funciona).
4. **Primeiro acesso da família**: copie `family.example.json` para `family.json` (fora do git), coloque os e-mails reais e rode, com o `.env` de produção:
   ```bash
   npm run family:setup -- --file family.json
   ```
   Saem 4 links de uso único (válidos por 72h). Mande cada link **só** para a pessoa certa; ela define a própria senha.
5. **Telegram**: siga [`docs/TELEGRAM.md`](docs/TELEGRAM.md).

## Integração OpenBot/WhatsApp

O Luna expõe uma API HTTP (`/api/integrations/openbot/v1`, contrato em [`integrations/openbot/openapi.json`](integrations/openbot/openapi.json)) para um agente do [OpenBot](integrations/openbot/SETUP.md) que conversa com a família pelo WhatsApp. Passo a passo completo: [`integrations/openbot/SETUP.md`](integrations/openbot/SETUP.md).

Resumo:
1. **Configurações → Integrações → OpenBot** (só para quem gerencia a família): ligue a integração e crie uma **credencial** (`lfo_…`, mostrada uma única vez) para colar no OpenBot.
2. Cada pessoa, em **Configurações → Integrações → Seu WhatsApp**: gera um código de vinculação para o próprio número (10 min, uso único), envia `vincular CÓDIGO` ao agente e define um **PIN** (6–8 dígitos).
3. No WhatsApp, a pessoa abre uma sessão com o PIN; toda gravação passa por rascunho e confirmação.
4. O painel mostra o status da API e a **última mensagem autenticada** — o Luna não enxerga a conexão do WhatsApp em si (ela vive no OpenBot), então nunca exibe "conectado".

Instruções do agente: [`AGENT_INSTRUCTIONS.md`](integrations/openbot/AGENT_INSTRUCTIONS.md) · ferramentas: [`TOOLS.md`](integrations/openbot/TOOLS.md) · cenários de teste: [`TEST_CASES.md`](integrations/openbot/TEST_CASES.md). Segurança: [`docs/SEGURANCA.md`](docs/SEGURANCA.md#whatsapp-via-openbot).

## Comandos

| Comando | O que faz |
|---|---|
| `npm run dev` | desenvolvimento (API + site com recarga) |
| `npm run build` / `npm start` | build de produção / servidor compilado |
| `npm test` | testes automatizados (PGlite em memória) |
| `npm run typecheck` | checagem de tipos do backend e do frontend |
| `npm run e2e` | teste no navegador contra um servidor com `demo:seed` |
| `npm run family:setup -- --file family.json` | cria as contas e gera links de primeiro acesso |
| `npm run family:reset-link -- --email x@y` | novo link para redefinir senha |
| `npm run backup [-- --out arquivo.json]` | backup lógico completo (JSON, permissão 600) |
| `npm run restore -- --file x.json --confirm` | restaura em um banco **vazio** |
| `npm run db:migrate` / `npm run db:rollback -- --confirm` | aplica migrações / reverte a última (faça backup antes) |
| `npm run telegram:set-webhook` / `:webhook-info` / `:delete-webhook` | gerencia o webhook |
| `npm run telegram:poll` | bot local sem domínio público (só desenvolvimento) |
| `npm run openbot:openapi` | regenera `integrations/openbot/openapi.json` (um teste garante a sincronia) |

## Segurança e privacidade

Resumo — detalhes em [`docs/SEGURANCA.md`](docs/SEGURANCA.md):

- Login individual (scrypt), sessão em cookie `HttpOnly` + `Secure` + `SameSite=Lax`, bloqueio após 5 erros, proteção CSRF por cabeçalho.
- **Toda permissão é verificada no backend.** Cada pessoa só altera os próprios lançamentos. O que ela vê dos outros é configurável: `full` (tudo), `summary` (só totais) ou `none`.
- O papel interno de quem gerencia o sistema **nunca** é enviado à interface como texto, selo ou rótulo, e não dá acesso extra a dados financeiros.
- Telegram: webhook autenticado por segredo, vínculo por código temporário de uso único, deduplicação de updates, confirmação obrigatória antes de gravar.
- WhatsApp/OpenBot: credencial revogável com escopos (só o hash no banco), vínculo do número por código de uso único, sessão por pessoa com PIN conferida contra o remetente a cada chamada, `Idempotency-Key` obrigatório e confirmação antes de gravar.
- Log de auditoria das ações sensíveis; exclusão lógica de lançamentos; backup/restauração.

## Estrutura

```
server/src
  app.ts, index.ts, config.ts     servidor, CSP/headers, rotas públicas (webhook, cron)
  db/                             driver (pg | PGlite) e migrações versionadas
  services/                       regras de negócio: access (permissões), auth, transactions, goals, insights…
  routes/api.ts                   API do site
  telegram/                       bot, vinculação, interpretador pt-BR, IA opcional
  integrations/openbot/           API do OpenBot: identidade (credencial, vínculo, PIN), operações, OpenAPI
  notifications/jobs.ts           avisos e agendador
  scripts/                        família, backup/restore, webhook, demo
server/test                       testes (unidades, permissões, finanças, Telegram)
web/src                           React (páginas, componentes, design system em styles.css)
e2e/smoke.mjs                     teste no navegador
integrations/openbot/             guia de setup, instruções do agente, ferramentas e openapi.json
```
