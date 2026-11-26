# Configurar o agente Luna no OpenBot e conectar o WhatsApp

Nada aqui exige desenvolvimento novo no Luna Finance. Siga na ordem.

## O que foi verificado no OpenBot (nightly-labs/openbot)
- É um app local/servidor que roda agentes de IA (Claude Code, Codex etc.). Licença atual: PolyForm Noncommercial (uso familiar ok; uso comercial exige licença).
- O WhatsApp entra como **aparelho conectado** (cliente não oficial, QR code ou código de pareamento). O WhatsApp pode restringir números que pareçam automatizados; o aparelho cai após ~14 dias offline; mensagens com mais de 1 dia não são respondidas.
- O remetente (`authorId`, dígitos com o país) é definido pela plataforma — mas **quem chama a API do Luna é o próprio agente**. Por isso o Luna exige, além da chave, a **sessão por pessoa aberta com PIN**.
- Não há webhook de saída do OpenBot para servidores externos. Os avisos do Luna ficam numa fila que o agente busca (`/notifications/pending`).
- Agentes rodam com acesso amplo à máquina e todos sob o mesmo usuário do sistema: use um computador/servidor dedicado e só a chave da integração (escopos mínimos).

## 1. No Luna Finance (site, logado como quem gerencia a família)
1. Publique o Luna com HTTPS (Railway/Render/VPS) — o OpenBot precisa alcançar a URL.
2. **Configurações → Integrações → OpenBot**:
   - Ligue a integração.
   - Mantenha **"Exigir PIN" ligado** e **"Confirmação automática" desligado** (padrão seguro).
   - Crie uma credencial (escopos: `link`, `read`, `write`, `notifications`). **Copie a chave `lfo_…` agora** — ela não aparece de novo.
3. **Cartões e fatura**: cadastre titular (Luís Carlos), dia de fechamento, dia de vencimento e, se quiser, o limite. Cada pessoa cadastra o final do próprio cartão no perfil.
4. **Cada pessoa** (logada na própria conta) em **Configurações → Integrações → Seu WhatsApp**:
   - Define o **PIN do WhatsApp** (6–8 dígitos, confirma com a senha).
   - Gera o **código de vinculação** informando o próprio número (vale 10 minutos, uma vez).
   - Alternativa: quem gerencia a família vincula o número de cada pessoa pelo painel.
5. Clique em **Testar** no painel: confere banco, integração, credencial, vínculos e fatura.

## 2. No OpenBot
1. Instale o OpenBot (desktop ou servidor/Docker) no computador que ficará ligado.
2. **Marketplace → Apps → WhatsApp**: conecte o número da Luna por QR code. Recomendado: **"Um número só para o OpenBot"**; em "Quem pode escrever", deixe só os 4 números da família (aprovar os pedidos de pareamento só desses números).
3. Crie o agente **Luna**:
   - Instruções: cole `AGENT_INSTRUCTIONS.md` (ou `AGENT_INSTRUCTIONS_SHORT.md` se houver limite de tamanho).
   - Anexe `TOOLS.md` e `openapi.json` como referência (pasta do agente ou skill `SKILL.md`).
   - Guarde a chave: peça ao agente para usar `openbot.request_api_key` com o nome `LUNA_OPENBOT_API_KEY`, escopo **"Only this agent"**. Configure `LUNA_API_URL` (ver `.env.example`).
   - Permissões do agente: acesso à rede para a URL do Luna; nada além do necessário.
4. (Opcional) Avisos: crie uma rotina agendada (ex.: a cada 15 min) com a instrução: "Busque `GET /notifications/pending`, entregue cada aviso ao número do destinatário com `openbot.messaging_post` e confirme com `/ack`."
5. Teste a conectividade pelo agente: `GET {LUNA_API_URL}/api/integrations/openbot/v1/health` com a chave. O painel do Luna passa a mostrar "última chamada".

## 3. Primeiro uso de cada pessoa (no WhatsApp)
1. Envia: "vincular K7M2Q9PX" (código do site) → o agente chama `/links/claim` com o número do remetente.
2. Envia o PIN quando o agente pedir → `/sessions` (vale 12 h, configurável).
3. "Gastei 85 reais no restaurante" → resumo → "sim" → gravado. Aparece no site em até ~20 s, com o ícone do WhatsApp.

## Revogar acesso
- Uma pessoa: **Desvincular** (site) — corta sessões e rascunhos na hora.
- Todas as sessões: trocar o PIN, desligar a integração ou revogar a credencial.
- Número perdido/roubado: desvincule e redefina o PIN.

## O que depende da conexão real (não testado aqui)
- Pareamento do WhatsApp no OpenBot, entrega de mensagens e avisos, comportamento do modelo com as instruções.
- O que foi testado automaticamente no Luna está em `TEST_CASES.md`.
