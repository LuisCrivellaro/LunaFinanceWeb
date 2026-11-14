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

## Auditoria e recuperação
- `audit_log` registra logins (inclusive falhos), criação/edição/exclusão de lançamentos, mudanças de permissão, links gerados, vínculos do Telegram.
- Lançamentos excluídos são marcados (`deleted_at`), não apagados.
- `npm run backup` gera um JSON completo (permissão 600). `npm run restore` só restaura em banco vazio.
- Recomendado: backup automático do provedor Postgres (PITR) + backup JSON semanal guardado fora do servidor (o arquivo contém dados financeiros e hashes de senha — armazene criptografado).

## Segredos
- Tokens e chaves só em variáveis de ambiente (`.env` está no `.gitignore`). O frontend nunca recebe o token do bot nem a chave da IA.
- Em produção o servidor se recusa a iniciar com `APP_URL` sem HTTPS ou segredos curtos.
