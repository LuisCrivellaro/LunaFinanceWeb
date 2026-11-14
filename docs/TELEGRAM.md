# Bot do Telegram — configuração

O bot é uma extensão do site: usa **o mesmo banco** e **as mesmas permissões**. Nada fica guardado só no Telegram.

## Como funciona

```
Telegram ──HTTPS──▶ POST /telegram/webhook  (cabeçalho X-Telegram-Bot-Api-Secret-Token validado)
                     │
                     ├─ dedup por update_id (o Telegram reenvia se não receber 200)
                     ├─ só conversa privada
                     ├─ quem fala = from.id vinculado (nunca o nome digitado)
                     ├─ consultas → números calculados no banco
                     └─ registros → rascunho + botões ✅ Confirmar / Cancelar
                                     (nada é gravado sem confirmação; clique duplo não duplica)
```

### Vinculação segura
1. A pessoa entra no site → **Configurações → Telegram → Conectar meu Telegram**.
2. O site gera um código pessoal de 8 caracteres, **uso único**, válido por **10 minutos** (guardado só como hash).
3. Ela toca em **Abrir no Telegram** (deep link `t.me/<bot>?start=link_CÓDIGO`) ou envia `/vincular CÓDIGO`.
4. O backend associa o ID do Telegram à conta. Após 5 códigos errados em 15 min, aquele Telegram é bloqueado temporariamente.

Saber o nome de alguém não dá acesso a nada: sem vínculo, o bot só responde com instruções.

### Comandos
| Comando | |
|---|---|
| `/resumo` | resumo do mês: saldo, receitas, despesas, resultado, maiores gastos, alertas |
| `/saldo` | saldo por conta |
| `/familia` | totais da família (e por pessoa, se a permissão for "vê tudo") |
| `/receitas`, `/despesas` | totais do mês por categoria |
| `/contas` | atrasadas e a vencer (30 dias), com botão para marcar como paga |
| `/vencimentos` | próximos 15 dias |
| `/metas` | progresso das metas |
| `/notificacoes` | liga/desliga avisos |
| `/desvincular` | desconecta este Telegram |

Também entende frases: *"Registra uma despesa de R$ 150 com supermercado"*, *"Recebi R$ 3.000 de salário"*, *"Conta de internet de R$ 120 para dia 20"*, *"Comprei um celular de 2.400 em 12x"*, *"qual meu saldo?"*.

### Avisos automáticos (entre 9h e 21h)
- contas a vencer (antecedência configurável: 1–7 dias) — com botão "Marcar como paga";
- contas atrasadas (uma vez por conta);
- resumo diário (20h, opcional) e semanal (segunda, 9h);
- metas em 90% e metas atingidas;
- gasto fora do padrão: só quando há **6+ lançamentos** na mesma categoria nos últimos 180 dias e o novo gasto é **≥ 3× a mediana** e ≥ R$ 50. Sem histórico suficiente, não avisa.

### IA (opcional)
Com `ANTHROPIC_API_KEY`, frases que as regras não entendem são interpretadas pelo Claude. A IA **só extrai campos**; o valor precisa estar escrito literalmente na mensagem (senão é descartado), a categoria precisa existir e o registro ainda pede confirmação. Saldos e totais vêm sempre do banco. Sem a chave, tudo funciona com o interpretador por regras.

---

## Passo a passo (o que você precisa fazer)

### 1. Criar o bot no BotFather
1. No Telegram, abra **@BotFather** (selo azul de verificado).
2. Envie `/newbot`.
3. Nome de exibição: por exemplo `Luna Finance`.
4. Username (precisa terminar em `bot`): por exemplo `LunaFinanceFamiliaBot`.
5. O BotFather responde com o **token** (`123456789:AA...`). Trate como senha: não cole em chat, issue ou código.
6. Opcional: `/setdescription`, `/setabouttext` e `/setuserpic` para dar a cara do Luna.

> Dica de privacidade: o bot só responde em conversa privada e ignora quem não tem vínculo, mas qualquer pessoa pode encontrá-lo pelo username. Isso não expõe dados.

### 2. Configurar as variáveis (no servidor, nunca no frontend)
```
TELEGRAM_BOT_TOKEN=<token do BotFather>
TELEGRAM_BOT_USERNAME=LunaFinanceFamiliaBot
TELEGRAM_WEBHOOK_SECRET=<saída de: openssl rand -hex 32>
APP_URL=https://seu-dominio
```
Reinicie o servidor. O log deve mostrar `"telegram":"ativo"`.

### 3. Publicar o webhook
Com o site já no ar em HTTPS e o `.env` de produção carregado:
```bash
npm run telegram:set-webhook     # registra APP_URL/telegram/webhook com o segredo + menu de comandos
npm run telegram:webhook-info    # confira: url correta, pending_update_count baixo, sem last_error_message
```
O Telegram exige HTTPS com certificado válido nas portas 443, 80, 88 ou 8443 — qualquer hospedagem com domínio próprio/HTTPS atende.

### 4. Testar
1. No site, conecte seu Telegram (passo "Vinculação segura").
2. Envie `/resumo`, depois *"gastei 10 reais de teste"* → **Confirmar** → confira em Movimentações (ícone ✈︎ indica origem Telegram) → exclua pelo site.
3. Peça para alguém **sem vínculo** mandar `/saldo` ao bot: deve receber só instruções.
4. Para forçar a rodada de avisos: `curl -X POST https://seu-dominio/api/cron/run -H "Authorization: Bearer $CRON_SECRET"`.

### Testar localmente sem domínio público
```bash
npm run telegram:delete-webhook   # se já houver webhook
npm run telegram:poll             # recebe mensagens por long polling
```
Use um bot separado para desenvolvimento, para não brigar com o webhook de produção.

### Problemas comuns
| Sintoma | Causa provável |
|---|---|
| Bot não responde | webhook não registrado ou URL errada → `telegram:webhook-info` |
| `last_error_message: 401` | `TELEGRAM_WEBHOOK_SECRET` diferente do usado no `set-webhook` → rode `set-webhook` de novo |
| "Código inválido ou expirado" | passou de 10 min, ou já usado → gere outro |
| Avisos não chegam | hospedagem dormindo → configure o cron externo; ou o horário está fora de 9h–21h |
