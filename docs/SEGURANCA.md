# Segurança, privacidade e permissões

## Modelo de permissões (backend: `server/src/services/access.ts`)

| Regra | Onde é garantida |
|---|---|
| Cada pessoa cria/edita/exclui **apenas os próprios** lançamentos, contas, recorrências e metas individuais | `assertOwner` em cada serviço |
| Lançar só em contas (carteiras) próprias | `getOwnAccount` |
| O que se vê dos outros: `full` (tudo), `summary` (só totais agregados), `none` (nada) | `resolveScope` |
| Metas familiares: todos com acesso ≠ `none` contribuem; só quem criou edita/exclui | `goals.ts` |
| Gestão de pessoas (permissões, links de acesso, desativar) | `assertCanManageFamily` |

### Regra sobre o papel interno
- O papel `admin` existe **só no banco** e serve para gerenciar pessoas.
- Nenhuma resposta da API contém `role`. A interface recebe apenas `capabilities.manageMembers` (booleano) do **próprio** usuário, usado para mostrar a seção "Pessoas da família" nas configurações — sem título, selo ou texto que indique papel.
- O papel **não** concede acesso extra a dados financeiros nem permite editar lançamentos alheios.
- Membros são listados em ordem alfabética, todos com o mesmo peso visual.
- Testes automatizados verificam que nenhuma resposta e nenhuma tela contém "admin/ADM/administrador/dono".

## Autenticação
- Senhas com scrypt (N=2^15, r=8, p=1, sal aleatório); mínimo de 10 caracteres com letras e números.
- Sessão: token aleatório de 256 bits em cookie `HttpOnly`, `Secure` (produção), `SameSite=Lax`; no banco fica só o SHA-256.
- 5 senhas erradas bloqueiam a conta por 15 min; limite de tentativas por IP; mesma resposta para e-mail inexistente.
- Trocar senha encerra as outras sessões. Links de acesso são de uso único, expiram e trafegam no fragmento `#` (não vão para logs/referrer).
- CSRF: toda requisição que altera dados exige o cabeçalho `X-Luna-Client` (navegadores não o enviam entre origens sem CORS, que não está habilitado).

## Cabeçalhos e entrada
- Helmet com CSP restritiva (`script-src 'self'`, `frame-ancestors 'none'`), `Referrer-Policy: no-referrer`.
- Toda entrada validada com Zod no servidor; SQL sempre parametrizado; busca com `LIKE` escapado.
- CSV exportado com proteção contra injeção de fórmulas (`=`, `+`, `-`, `@`).
- Limites de tamanho de corpo (200 KB API / 256 KB webhook).

## Telegram
- Webhook só aceita requisições com o segredo correto (comparação em tempo constante).
- Identidade = `from.id` vinculado; só chats privados; botões de rascunhos de outra pessoa são recusados.
- Confirmação obrigatória: trava do rascunho (status, versão e validade de 15 min) e gravação na mesma transação do banco — sem duplicidade, sem gravação parcial, cartões antigos não confirmam.
- `update_id` registrado com status/tentativas: reenvios são ignorados; falhas transitórias são reprocessadas até 3 vezes.
- IA (opcional) só lê dados por ferramentas do backend e só propõe rascunhos; respostas com valores que não vieram das ferramentas são descartadas. Não há SQL livre.
- Detalhes: `docs/TELEGRAM.md`.

## WhatsApp via OpenBot
O OpenBot recebe as mensagens do WhatsApp (aparelho conectado, cliente não oficial) e um **agente de IA** chama a API do Luna (`/api/integrations/openbot/v1`). O remetente real chega ao agente, mas nada assinado pela plataforma prova ao servidor quem escreveu — por isso a identidade tem três camadas, todas verificadas no backend (`server/src/integrations/openbot/identity.ts`):

1. **Credencial da instalação** — `Authorization: Bearer lfo_…`. Gerada em Configurações → Integrações → OpenBot (só quem gerencia a família), mostrada **uma única vez**; o banco guarda só o SHA-256 e o prefixo. Escopos `link`, `read`, `write`, `notifications`. Revogar derruba na hora as sessões abertas com ela. Integração desligada = 503 para tudo, exceto `/health` e o encerramento de sessão.
2. **Vínculo do número** — a própria pessoa, logada no site, gera um código de 8 caracteres (10 min, uso único, válido **só para o número informado**); o agente apresenta o código com o número do remetente. Código inexistente, usado, vencido ou de outro número recebem a mesma resposta. Alternativa: quem gerencia a família vincula pelo painel (fica registrado como vínculo administrativo). Trocar ou desvincular o número encerra sessões e cancela rascunhos pendentes.
3. **Sessão por pessoa com PIN** — `POST /sessions` com número + PIN (6–8 dígitos, sem sequências/repetições, guardado com scrypt; definir exige a senha do site). Devolve `X-Luna-Session` (`lfs_…`, só o hash no banco), válida por 1–72 h (padrão 12 h). **A cada chamada** a sessão é conferida contra o cabeçalho `X-Luna-Sender`, a credencial que a abriu e o vínculo atual: a sessão de uma pessoa nunca atende outro número. 5 PINs errados bloqueiam por 15 min. Desligar "Exigir PIN" é possível, mas o painel avisa do risco; religar derruba as sessões abertas sem PIN.

Outras garantias:
- **Escrita só por rascunho** (`telegram_pending_actions` com `channel='whatsapp'`): versionado, expira em 15 min, confirmação atômica pelo mesmo executor do Telegram (`server/src/channels/execute.ts`). "Gravar sem pedir confirmação" vale só para lançamentos simples sem alertas; correções, exclusões e pagamento de fatura sempre pedem confirmação.
- **Idempotência**: `Idempotency-Key` obrigatório em todo POST (`integration_requests`, hash do corpo — a mesma chave com outro conteúdo é recusada com 422) + `external_ref` nos rascunhos. Reenvio do agente não duplica lançamento.
- Limite de requisições por credencial e por número; histórico em `integration_events` (operação, status, duração — **sem valores financeiros**); telefones sempre mascarados no painel.
- As permissões de visão (`full`/`summary`/`none`) são as mesmas do site: o agente só vê o que a pessoa da sessão veria.
- O painel nunca mostra "WhatsApp conectado": o Luna não vê essa conexão. Mostra apenas a última mensagem autenticada recebida de um número vinculado.

## Auditoria e recuperação
- `audit_log` registra logins (inclusive falhos), criação/edição/exclusão de lançamentos, mudanças de permissão, links gerados, vínculos do Telegram e do WhatsApp, PINs definidos/errados, credenciais criadas/revogadas e mudanças na integração.
- Lançamentos excluídos são marcados (`deleted_at`), não apagados.
- `npm run backup` gera um JSON completo (permissão 600). `npm run restore` só restaura em banco vazio.
- Recomendado: backup automático do provedor Postgres (PITR) + backup JSON semanal guardado fora do servidor (o arquivo contém dados financeiros e hashes de senha — armazene criptografado).

## Segredos
- Tokens e chaves só em variáveis de ambiente (`.env` está no `.gitignore`). O frontend nunca recebe o token do bot nem a chave da IA.
- A chave do OpenBot (`lfo_…`) fica só na configuração do OpenBot; o Luna não consegue mostrá-la de novo. Se vazar, revogue e crie outra.
- Em produção o servidor se recusa a iniciar com `APP_URL` sem HTTPS ou segredos curtos.
