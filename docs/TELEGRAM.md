# Bot do Telegram — Luna Finance

O bot é uma interface do **mesmo sistema**: mesmo banco Postgres, mesmos serviços, mesmas permissões do site. Uma despesa lançada no Telegram aparece no site na hora (com o ícone ✈︎ de origem), e o que é lançado no site aparece nas consultas do bot. Não existe banco separado para o Telegram.

## Sumário
1. [Arquitetura](#arquitetura)
2. [O que o bot faz](#o-que-o-bot-faz)
3. [Segurança](#seguranca)
4. [Passo a passo: colocar no ar](#passo-a-passo)
5. [Rodar e testar localmente](#local)
6. [Logs e diagnóstico](#logs)
7. [Problemas comuns](#problemas)

---

<a id="arquitetura"></a>
## 1. Arquitetura

```
Telegram ──HTTPS──▶ POST /telegram/webhook
                      │  cabeçalho X-Telegram-Bot-Api-Secret-Token (comparação em tempo constante)
                      ▼
               handleUpdate (telegram/bot.ts)
                      │ 1. reserva o update_id em telegram_updates (idempotência)
                      │ 2. só chat privado; identidade = Telegram ID vinculado
                      │ 3. estado da conversa (telegram_conversations)
                      ▼
      nlu.ts (regras pt-BR) ──não entendeu──▶ assistant.ts (IA opcional, ferramentas controladas)
                      │
         ┌────────────┴─────────────┐
     consultas                   registros
  data.ts → replies.ts      rascunho em telegram_pending_actions (com versão)
  (SQL do backend)          ✅ Confirmar → trava + gravação NA MESMA TRANSAÇÃO
                            services/transactions.ts | goals.ts (os mesmos do site)
```

| Arquivo | Papel |
|---|---|
| `server/src/telegram/bot.ts` | roteamento, comandos, botões, confirmação, idempotência |
| `server/src/telegram/nlu.ts` | intenção: lançamento, consulta (com período), metas |
| `server/src/telegram/parser.ts` | valor, data, categoria, conta, forma de pagamento, parcelas |
| `server/src/telegram/data.ts` | consultas ao banco (únicas fontes de números) |
| `server/src/telegram/replies.ts` | textos das respostas |
| `server/src/telegram/state.ts` | conversas e rascunhos (versão, expiração, confirmação atômica) |
| `server/src/telegram/assistant.ts` | IA com ferramentas + validação das respostas |
| `server/src/telegram/linking.ts` | vinculação por código temporário |
| `server/src/telegram/api.ts` | cliente da Bot API (timeout, 429, retentativa) |
| `server/src/notifications/jobs.ts` | avisos automáticos |

**Webhook × polling.** Produção usa **webhook** (recomendado pelo Telegram, sem processo extra). O modo polling (`npm run telegram:poll`) existe só para desenvolvimento e **se recusa a iniciar** se houver webhook ativo — os dois nunca rodam juntos.

**Hospedagem.** O repositório não tinha infraestrutura definida; o projeto inclui um `Dockerfile` para qualquer serviço de container com HTTPS (Railway, Render, Fly.io, VPS). O webhook exige um processo acessível publicamente por HTTPS.

---

<a id="o-que-o-bot-faz"></a>
## 2. O que o bot faz

### Registrar (sempre com resumo + confirmação)
| Mensagem | O bot entende |
|---|---|
| *Gastei 45 reais no almoço.* | despesa R$ 45,00 · Almoço · Alimentação fora · hoje |
| *Paguei 250 de mercado no Pix.* | + forma de pagamento Pix |
| *Comprei uma camiseta por 89,90 no cartão.* | Compras · cartão de crédito |
| *Gastei 32 reais ontem com Uber.* | data de ontem · Transporte |
| *Paguei 80 no débito do Nubank* | débito · conta "Nubank" (se existir) |
| *Recebi 2.500 de salário.* | receita · Salário |
| *Conta de internet de 120 para dia 20* | conta a pagar, vencimento dia 20 |
| *Comprei um celular de 2.400 em 12x* | 12 parcelas |
| *paguei a farmácia* | pergunta só o valor |
| *mesada 200* | pergunta se é receita ou despesa |

Cartão de confirmação: **✅ Confirmar · ✏️ Editar · ✖️ Cancelar**. Em *Editar*: valor, descrição, data, categoria, forma de pagamento, conta, receita↔despesa, pago↔pendente. Cada edição gera uma nova versão do rascunho; **botões de versões antigas não confirmam nada**. Se já existir um lançamento igual (mesmo tipo e valor, até 2 dias de diferença), o cartão avisa **possível duplicidade**.

### Perguntar (números sempre do banco)
*Quanto tenho disponível? · Quanto gastei este mês? · Quanto recebi este mês? · Quanto gastei com alimentação? · Quais foram minhas últimas despesas? · Quanto gastei hoje? · Como está minha situação financeira? · Compare meus gastos deste mês com o anterior · quanto gastei em outubro? · maiores despesas da semana*

### Metas
*criar meta de 50 mil para comprar um carro até 12/2027* · *guardei 1.500 na meta carro* · *tirei 200 da meta viagem* · *Como está minha meta de comprar um carro?* (alvo, guardado, %, quanto falta, prazo, estimativa no ritmo atual — só quando há contribuições recentes).

### Comandos
| | |
|---|---|
| `/start` | boas-vindas e vinculação (`/start link_CÓDIGO`) |
| `/ajuda` | o que o bot faz |
| `/saldo` | saldo por conta + contas pendentes da semana |
| `/resumo` | resumo do mês + menu: hoje, semana, mês, categorias, comparar, maiores despesas, receitas × despesas, evolução do saldo |
| `/despesas`, `/receitas` | últimas movimentações |
| `/metas` | metas com botões *Ver*, *Guardar* e *Nova meta* |
| `/contas`, `/vencimentos` | pendências, com botão para marcar como paga |
| `/familia` | visão da família (conforme permissão no site) |
| `/cancelar` | cancela rascunhos e perguntas em andamento |
| `/configuracoes` | avisos automáticos e desconexão |
| `/vincular CÓDIGO` | vincula a conta |

### IA (opcional, com `ANTHROPIC_API_KEY`)
Entra **apenas** quando as regras não entendem a frase ou quando a pessoa pede explicação/análise (*por que gastei mais?*). Ela só consegue:
- **ler** dados por ferramentas do backend (saldo, totais, categorias, lista de lançamentos, comparação de meses, fluxo, evolução, metas, contas) — sempre do próprio usuário;
- **propor** lançamentos/metas/contribuições, que viram o mesmo cartão de confirmação.

Proteções: o valor de uma proposta precisa estar escrito na mensagem; toda resposta em texto é conferida — **qualquer "R$" que não esteja nos resultados das ferramentas faz a resposta ser descartada**; respostas que digam "registrei/salvei" são descartadas; não há ferramenta de SQL. Sem a chave, o bot funciona 100% com as regras.

### Avisos automáticos (9h–21h)
Vencimentos (1–7 dias antes, com botão “Marcar como paga”), contas atrasadas, resumo diário (opcional) e semanal, metas em 90%/atingidas, gasto fora do padrão (só com histórico ≥ 6 lançamentos na categoria e valor ≥ 3× a mediana).

---

<a id="seguranca"></a>
## 3. Segurança

- **Token só no servidor** (`TELEGRAM_BOT_TOKEN`), nunca no frontend, nunca em logs (o cliente HTTP mascara a URL em erros).
- **Webhook autenticado** pelo `secret_token` do `setWebhook`, conferido em tempo constante; limite de 300 req/min e 256 KB por requisição.
- **Vinculação**: código de 8 caracteres gerado na sessão autenticada do site, uso único, 10 min, guardado só como hash; 5 erros em 15 min bloqueiam aquele Telegram. Saber o nome de alguém não vincula nada.
- **Autorização**: cada mensagem resolve o usuário pelo Telegram ID vinculado; botões de rascunhos de outra pessoa são recusados; regras de família iguais às do site.
- **Idempotência**: `telegram_updates` registra cada `update_id` (status e tentativas). Repetições são ignoradas.
- **Confirmação atômica**: trava do rascunho (status + versão + validade) e gravação acontecem na mesma transação do banco. Clique duplo, cartão antigo ou confirmação expirada não gravam. Se o banco falhar, nada é salvo e o rascunho continua disponível.
- **Falhas**: erro transitório (banco, rede, Telegram) → resposta 500 para o Telegram reenviar, até 3 tentativas; depois disso o bot avisa que **não** concluiu. Mensagens de sucesso só são enviadas depois do commit.
- **Logs** estruturados em JSON com `op` (`tg-<update_id>`), usuário e duração — sem texto das mensagens, valores ou tokens.

> ⚠️ **Token exposto anteriormente.** Considere-o comprometido. No @BotFather: `/mybots` → escolha o bot → **API Token** → **Revoke current token**. Use somente o token novo. (A busca no histórico deste repositório não encontrou token versionado — o vazamento ocorreu fora dele, mas a revogação é obrigatória do mesmo jeito.)

---

<a id="passo-a-passo"></a>
## 4. Passo a passo: colocar no ar

### 4.1 Bot no BotFather
1. Abra **@BotFather** (selo azul).
2. Bot novo: `/newbot` → nome (*Luna Finance*) → username terminando em `bot` (*LunaFinanceFamiliaBot*).
   Bot existente com token vazado: `/mybots` → bot → **API Token** → **Revoke current token**.
3. Guarde o token **novo** direto no gerenciador de segredos da hospedagem.
4. Opcional: `/setdescription`, `/setabouttext`, `/setuserpic`.

### 4.2 Variáveis de ambiente (servidor)
```
NODE_ENV=production
APP_URL=https://seu-dominio
DATABASE_URL=postgresql://...
TRUST_PROXY=true
TELEGRAM_BOT_TOKEN=<token novo>
TELEGRAM_BOT_USERNAME=LunaFinanceFamiliaBot
TELEGRAM_WEBHOOK_SECRET=<openssl rand -hex 32>
TELEGRAM_WEBHOOK_URL=            # opcional; padrão APP_URL/telegram/webhook
CRON_SECRET=<openssl rand -hex 32>   # se a hospedagem "dormir"
ANTHROPIC_API_KEY=               # opcional (IA)
```
O servidor **se recusa a iniciar** em produção com URL sem HTTPS ou segredos curtos.

### 4.3 Banco de dados
```bash
npm run backup                 # SEMPRE antes de atualizar
# publique a nova versão: as migrações rodam sozinhas ao iniciar
# (ou manualmente: npm run db:migrate)
```
A migração 2 (`telegram_assistant`) só **adiciona** colunas/tabelas. Reversão: `npm run db:rollback -- --confirm` (e volte para a versão anterior do código antes de reiniciar o servidor).

### 4.4 Webhook
```bash
npm run telegram:set-webhook          # registra a URL + segredo + menu de comandos
npm run telegram:webhook-info         # url correta, pending_update_count, last_error_message
# opcional, se houver mensagens velhas acumuladas do token antigo:
npm run telegram:set-webhook -- --drop-pending
```

### 4.5 Vincular cada pessoa
Cada integrante, **logado na própria conta** do site: **Configurações → Telegram → Conectar meu Telegram** → *Abrir no Telegram* (ou envia `/vincular CÓDIGO`). O site mostra "Telegram conectado" sozinho em alguns segundos.

### 4.6 Teste de aceitação (com dados de teste)
1. `/resumo` responde.
2. *gastei 1 real de teste* → **Editar → Valor → 2** → **Confirmar** → aparece no site → exclua no site.
3. `/saldo` muda conforme o site.
4. Outra pessoa **sem vínculo** manda `/saldo` → recebe só instruções.
5. *criar meta de 100 para teste* → confirmar → excluir no site.
6. `curl -X POST https://seu-dominio/api/cron/run -H "Authorization: Bearer $CRON_SECRET"` → avisos de teste (se houver contas a vencer).

---

<a id="local"></a>
## 5. Rodar e testar localmente

```bash
cp .env.example .env              # coloque o token de um BOT DE TESTE (não o de produção)
npm install
npm run demo:seed                 # família fictícia (senha DemoLuna2026)
npm run dev                       # site em http://localhost:5173
npm run telegram:delete-webhook   # só se esse bot tiver webhook
npm run telegram:poll             # outro terminal: bot recebendo mensagens
```
Entre no site como um perfil de demonstração, gere o código em Configurações → Telegram e vincule.

Testes automatizados (não usam a rede nem dados reais):
```bash
npm test                          # 140+ testes, incluindo os 18 cenários do bot
npx vitest run server/test/telegram.test.ts
```

---

<a id="logs"></a>
## 6. Logs e diagnóstico

Cada linha é um JSON. Principais eventos:

| `msg` | Significado |
|---|---|
| `telegram.mensagem` / `telegram.botao` | mensagem/botão recebido (`op`, `user_id`, comando/ação) |
| `telegram.update_ok` | processado (`ms`) |
| `telegram.update_duplicado` | reenvio ignorado |
| `telegram.update_erro` | falha (`attempt` 1–3) — o Telegram vai reenviar |
| `telegram.confirmado` / `telegram.confirmacao_falhou` | gravação concluída / revertida |
| `telegram.webhook_rejeitado` | requisição sem segredo válido |
| `telegram.vinculado` | conta vinculada |
| `ia.resposta` / `ia.proposta` / `ia.resposta_descartada` | uso da IA (e respostas bloqueadas pelo validador) |
| `notificacao.falhou` | aviso não entregue (será tentado de novo) |

Exemplos:
```bash
# na hospedagem, filtre os logs do container por:
grep '"msg":"telegram.update_erro"'          # falhas
grep '"op":"tg-123456789"'                   # tudo de um update específico
```
No banco:
```sql
SELECT status, attempts, received_at FROM telegram_updates ORDER BY received_at DESC LIMIT 20;
SELECT action, source, created_at FROM audit_log WHERE source = 'telegram' ORDER BY id DESC LIMIT 20;
```

---

<a id="problemas"></a>
## 7. Problemas comuns

| Sintoma | Causa provável | Correção |
|---|---|---|
| Bot não responde | webhook ausente/errado | `npm run telegram:webhook-info`; rode `set-webhook` |
| `last_error_message: ... 401` | segredo diferente do registrado | rode `set-webhook` de novo com o `.env` atual |
| `last_error_message: ... 500` | banco fora do ar / erro interno | veja `telegram.update_erro` nos logs |
| "Código inválido ou expirado" | passou de 10 min ou já usado | gere outro no site |
| "Muitas tentativas" | 5 códigos errados | aguarde 15 min |
| `telegram:poll` diz que há webhook | polling e webhook não convivem | `telegram:delete-webhook` (só em dev!) |
| Avisos não chegam | hospedagem dormindo; fora de 9h–21h; pessoa desligou | cron externo; `/configuracoes` |
| IA não responde | sem `ANTHROPIC_API_KEY` ou resposta bloqueada pelo validador | o bot cai na resposta por regras; veja `ia.*` nos logs |
