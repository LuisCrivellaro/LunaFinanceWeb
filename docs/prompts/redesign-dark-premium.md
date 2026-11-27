# PROMPT MESTRE — REDESIGN DARK PREMIUM DO LUNA FINANCE WEB

> Cole este prompt no Claude Code aberto em `C:\Projetos\LunaFinanceWeb` e **anexe a imagem de referência** (dashboard dark com roxo/lavanda) na mesma mensagem.

---

## 1. MISSÃO

Atue como Senior Product Designer, UI/UX Engineer e Senior Frontend Developer especializado em dashboards financeiros premium.

**Implemente** a reformulação visual completa do frontend do Luna Finance: todas as páginas, componentes, modais, formulários, gráficos e estados. Não entregue só plano, protótipo ou recomendação. Trabalhe em uma passada contínua, de A a F (seção 13), sem pausar para aprovações estéticas. Pergunte apenas se uma decisão realmente bloquear o trabalho. Nos demais casos, escolha a opção mais coerente com a referência e registre a decisão.

O resultado deve ter acabamento de fintech premium, com uma identidade original do Luna Finance. A imagem anexada serve de referência de atmosfera e composição, não de template.

---

## 2. CONTEXTO CONFIRMADO (inspecionado no repositório em 19/11/2026)

Confirme cada item antes de editar. Se algo divergir, siga o código real e registre a diferença no relatório.

**Produto:** gestão financeira de uma família de 4 pessoas. Tem site e bot do Telegram ligados ao mesmo banco. O backend é Express 5 e serve a API; o frontend é uma SPA em `web/`.

**Stack do frontend:** React 19, TypeScript, Vite 7, React Router 7, TanStack Query 5, Recharts 3 e lucide-react. O CSS é tradicional, num único arquivo. Não há Tailwind no app real.

**Arquivos do frontend (lista completa, 4.050 linhas):**

| Arquivo | Papel |
|---|---|
| `web/src/main.tsx` | rotas, providers, lazy-load das páginas e import das fontes (`@fontsource-variable/fraunces` e `@fontsource-variable/hanken-grotesk`) |
| `web/src/styles.css` | design system atual (1.342 linhas): tokens em `:root`, dark em `@media (prefers-color-scheme: dark) :root:not([data-theme="light"])` e em `:root[data-theme="dark"]`, além de blocos `prefers-reduced-motion` e `@media print` |
| `web/src/components/Layout.tsx` | sidebar, navegação, header e `.tabbar` mobile |
| `web/src/components/ui.tsx` | `Icon`, `CategoryIcon`, `Money`, `Avatar`, `MoonPhase`, `Modal`, `Empty`, `Skeleton`, `CardSkeleton`, `ErrorState`, `ViewSwitch`, `StatusChip` |
| `web/src/components/Charts.tsx` | `FlowChart` (receitas × despesas), `BalanceChart` (evolução do saldo), `CategoryBars` |
| `web/src/components/TransactionForm.tsx` | formulário/modal de lançamento (308 linhas, **não estava na lista do briefing original**) |
| `web/src/lib/app.tsx` | contexto do app e tema: `light`, `dark` ou `system`, guardado em `localStorage["luna.theme"]` e aplicado via `data-theme` no `<html>` |
| `web/src/lib/format.ts`, `api.ts`, `types.ts` | formatação BRL, cliente HTTP e tipos |
| `web/src/pages/Dashboard.tsx`, `Transactions.tsx`, `Bills.tsx`, `Goals.tsx`, `Reports.tsx`, `Settings.tsx`, `Auth.tsx` | páginas |

**Rotas reais:** `/entrar`, `/definir-senha`, `/` (painel), `/movimentacoes`, `/contas`, `/metas`, `/relatorios`, `/configuracoes`. Não crie outras.

**Dados que o painel recebe** (`interface Dashboard` em `types.ts`): `balanceCents`, `totals`, `previousTotals`, `resultCents`, `resultPaidCents`, `series`, `balanceHistory`, `expensesByCategory`, `upcoming {items,count,totalCents}`, `overdue {…}`, `goals`, `members` (null quando a pessoa não tem permissão) e `accounts`.
- O endpoint do painel **não traz movimentações recentes.** Para a lista de recentes, reutilize `GET /api/transactions` com o mesmo parâmetro `view` do painel e o filtro de mês. Verifique em `server/src/routes` e `services` quais parâmetros de limite e ordenação já existem. Não altere o contrato da API; se faltar parâmetro de limite, corte no cliente.

**Segurança que afeta o design** (`server/src/app.ts`, Helmet CSP):
`scriptSrc 'self'`, `styleSrc 'self' 'unsafe-inline'`, `fontSrc 'self' data:`, `imgSrc 'self' data:`, `connectSrc 'self'`.
- Fontes, scripts e imagens precisam ser **locais**. CDN de fontes, iframe ou script externo será bloqueado. Não afrouxe a CSP.

**Contratos do teste E2E** (`e2e/smoke.mjs`, Playwright). O redesign não pode quebrar estes pontos. Mantenha as classes e atributos abaixo como ganchos, mesmo mudando todo o visual. Se precisar mudar algum, atualize `e2e/smoke.mjs` na mesma etapa e justifique no relatório.
- Seletores: `button.btn-primary`, `.hero .balance`, `.sidebar .btn-primary`, `.tabbar`, `.list-item`, `.toast`, `.modal`, `.modal-foot .btn-primary`, `.modal-foot .btn-danger`, `.money-input input`, `#contas`, `input[type=email]`, `input[type=password]`, `input[placeholder^='Pesquisar']`, `input[placeholder='Ex.: Supermercado']`, `input[placeholder='Ex.: Nubank']`, além do texto visível "Transferências recentes".
- Regra de privacidade testada: **nenhuma tela pode mostrar** as palavras adm, admin, administrador, proprietário, fundador ou dono. O papel de gestor nunca aparece na interface, nem para o próprio gestor. A área de pessoas em Configurações aparece só para o gestor (Lipe na demonstração).
- Em 375px, nenhuma rota pode ter rolagem horizontal, e a `.tabbar` precisa estar visível.

**Git:** a branch `main` está 1 commit à frente de `origin/main` (`e5ec991`), sem push. Existe a branch local `visual-next`: um protótipo Next.js antigo, com referências do Google Stitch em `design/stitch/` e o tema "Obsidian Kinetic Wealth" (azul/laranja). **Não faça merge dela nem copie a stack dela.** Pode consultá-la só como inspiração (`git show visual-next:caminho`), e a paleta deste prompt prevalece.

**Ambiente local:** `npm run dev` sobe a API em `:3000` e o site em `http://localhost:5173`, com proxy de `/api`. O banco é PGlite em `.data/luna`. A demonstração vem de `npm run demo:seed`, com `lipe@demo` / `teste123` (gestor) e senha `DemoLuna2026` para `luciana@demo.luna`, `luis@demo.luna` e `joao@demo.luna` (membros). Se a ferramenta de preview injetar `PORT=5173`, a API sobe na porta errada. O `.claude/launch.json` já força `PORT=3000`.

---

## 3. REFERÊNCIA VISUAL — TRAÇOS APROVADOS

Use a imagem anexada para estes traços (se a imagem não vier anexada, siga esta descrição e registre a limitação no relatório):

- Dark sofisticado, com fundo quase preto e superfícies grafite em camadas.
- Cards com borda fina e discreta, sem sombras grandes.
- Roxo/lavanda suave como cor de identidade.
- Sidebar vertical compacta e barra superior minimalista.
- Painel em blocos **assimétricos**: um hero grande no centro, cards empilhados à direita e gráficos integrados aos cards.
- Números financeiros grandes, com hierarquia clara.
- Botões arredondados sem exagero, bastante espaço negativo e tipografia sans moderna.

**NÃO FAZER**
- **Não implemente o card de AI Assistant** da imagem. Não troque por chatbot, conversa, caixa de IA ou assistente parecido. Use o espaço para informação financeira real.
- Não copie valores em dólar, textos, dados fictícios, logos nem os botões "Wallet", "Portfolio" e "Analytics" da imagem.
- Não reproduza a imagem pixel a pixel.

---

## 4. ESCOPO

**OBRIGATÓRIO:** redesign de todo o frontend em `web/`: layout global, as 8 rotas, todos os componentes de `ui.tsx`, `TransactionForm.tsx`, gráficos, modais, formulários, tabelas, estados (loading, vazio, erro e sucesso), toasts, tema escuro e tema claro, impressão de relatórios e responsividade.

**PRESERVAR, sem tocar** (só leitura para entender o contrato):
- Tudo em `server/`: backend, rotas, contratos de API, banco, migrações, autenticação, sessões, CSRF, CSP, permissões, auditoria e Telegram.
- Regras de negócio: parcelas, recorrência, transferências (não contam como receita nem despesa), cálculo de totais, metas e relatórios.
- Valores em **centavos inteiros**: não converta para float nem mude arredondamento. `lib/format.ts` pode receber novos formatadores, mas não mude o resultado dos que existem.
- A visão individual/familiar (`ViewSwitch`), as permissões de visibilidade entre membros (`full`/`summary`/`none`) e a ocultação do papel de gestor.
- Exportação CSV e PDF/impressão dos relatórios.
- O mecanismo de tema (`luna.theme`, `data-theme`, opção `system`).
- O nome "Luna Finance" e o conceito de **fases da lua** nas metas (`MoonPhase`), adaptado à nova identidade.

**NÃO FAZER:** usar dados mock no lugar de dados reais; criar páginas vazias para imitar o print; introduzir Tailwind, CSS-in-JS ou outra solução de estilo; trocar o Recharts; instalar biblioteca inteira por um efeito; fazer push, merge em `main`, deploy ou mexer em produção.

---

## 5. DIREÇÃO CRIATIVA

**Conceito:** "noite clara". O Luna sai do editorial papel/serifa/dourado e vira um painel noturno e calmo, onde o roxo marca identidade e foco. Verde e vermelho aparecem só como significado (receita/despesa, estados). A lua continua presente de forma gráfica e abstrata: um arco ou crescente sutil no hero, as fases da lua nas metas e o logotipo. Nada de ilustração literal ou decorativa em excesso.

**Paleta-base** (é diretriz: refine contraste e hierarquia, garantindo WCAG AA, ou seja 4.5:1 para texto e 3:1 para elementos de interface):

| Token | Valor |
|---|---|
| bg | `#0B0B0F` |
| bg-2 | `#111115` |
| surface | `#19191E` |
| surface-raised | `#222229` |
| primary | `#C48AFF` |
| primary-2 | `#A77BDA` |
| primary-soft | `rgba(196,138,255,0.10)` |
| text | `#F5F4F7` |
| text-2 | `#A5A3AD` |
| text-3 | `#74727D` |
| accent (destaque raro) | `#A8FA65` |
| income | `#64D6AA` |
| expense | `#F0787A` |

Regras de uso:
- Gradiente roxo discreto só em pontos estratégicos (hero e estado ativo).
- Sem neon e sem estética gamer ou futurista.
- Glassmorphism, no máximo, em overlays de modal ou menus.
- Superfícies separadas por bordas de 1px e diferença de tom, não por sombras.
- O dark é a experiência principal. Mantenha o tema claro **com tokens próprios e consistentes**: não é só inverter cores, e o roxo do claro precisa de ajuste para ter contraste sobre fundo claro. A alternância entre os temas deve continuar funcionando.

**Tipografia (Fontshare):**
1. Compare **Satoshi** (prioridade), **General Sans** e **Switzer** em títulos, saldos grandes e tabelas densas.
2. Escolha **uma família principal**. Adicione uma segunda só se houver ganho claro, como uma mono ou tabular para valores.
3. Leia a licença (ITF Free Font License) em fontshare.com antes de usar. Baixe os **WOFF2** e hospede em `web/src/assets/fonts/` (ou `web/public/fonts/`) com `@font-face` e `font-display: swap`. Inclua só os pesos usados (ex.: 400/500/700) e o arquivo de licença.
4. Remova os imports e as devDependencies `@fontsource-variable/fraunces` e `@fontsource-variable/hanken-grotesk`, se ficarem sem uso.
5. Use `font-variant-numeric: tabular-nums` em todo valor monetário, tabela e eixo de gráfico.
6. Crie uma escala tipográfica única (display/saldo, h1, h2, h3, body, small, caption, label), com pesos, `letter-spacing` e `line-height` definidos.

---

## 6. LAYOUT GLOBAL

**Sidebar (desktop):**
- Grafite escuro, compacta, com ícones Lucide de traço consistente e item ativo em roxo (fundo `primary-soft` com indicador).
- Navegação principal separada do grupo de configurações e perfil.
- Pode recolher e expandir (estado salvo em `localStorage`, com try/catch). Quando recolhida, cada item mostra tooltip acessível.
- Mantenha `.sidebar .btn-primary` como o botão "Nova movimentação".
- Navegação por teclado com foco visível. Os destinos são só as rotas reais.

**Header:**
- Título ou breadcrumb da página.
- Contexto financeiro (mês e visão atual).
- `ViewSwitch` (eu/família e pessoa, quando permitido).
- Seletor de período onde a página já usa período.
- Acesso a Configurações e ao perfil do usuário.
- Ação principal da página.

**Estrutura:**
- Sidebar fixa com área principal fluida e grid responsivo com cards de proporções variadas.
- Largura máxima confortável no desktop largo.
- Nenhuma rolagem horizontal indevida.

**Mobile:** adapte a `.tabbar` atual (inferior, visível em 375px) ao novo visual, com área de toque mínima de 44px e respeito ao `safe-area-inset`.

---

## 7. PAINEL — PRIORIDADE MÁXIMA

Esta é a página mais refinada do app. Mantenha todos os dados e recursos atuais e mude a composição.

1. **Hero de saldo** (mantenha `.hero` e `.balance`):
   - Saldo como foco principal, em tamanho display com algarismos tabulares.
   - Rótulo da visão (individual ou família).
   - Resultado do mês com variação contra `previousTotals`.
   - Contas atrasadas, se houver.
   - Ação rápida "Nova movimentação" e link para Movimentações.
   - Gradiente roxo muito discreto numa região do card e, opcionalmente, um crescente lunar abstrato em SVG leve, sem prejudicar a leitura.
2. **Indicadores secundários**, sem redundância e só com dados existentes:
   - Receitas, despesas e resultado do mês.
   - Recebido/pago, conforme o que `totals`/`resultPaidCents` já oferecem.
   - A pagar (`upcoming`) e atrasado (`overdue`).
   - Taxa de poupança, só se já for calculada da mesma forma que hoje.
   - Comparação com o mês anterior.
3. **Movimentações recentes:** lista ou tabela elegante via `GET /api/transactions` (ver seção 2), com ícone e cor da categoria, descrição, data, responsável (só quando autorizado), valor colorido por tipo, hover discreto e link para o detalhe ou edição existente.
4. **Coluna lateral empilhada:** próximos pagamentos, despesas por categoria, metas com progresso e fase da lua, e resumo por pessoa (`members`, só quando não for null). **Sem AI Assistant.**
5. **Gráficos (Recharts):** redesenhe `FlowChart`, `BalanceChart` e `CategoryBars`:
   - Paleta por tokens (lendo CSS vars).
   - Grid horizontal tênue e eixos discretos.
   - Tooltip customizado no novo visual, com valor em BRL.
   - Legenda integrada ao card.
   - Estado vazio próprio e responsivo.
   - Não mude cálculos nem a interpretação dos dados.

---

## 8. DEMAIS PÁGINAS

- **Movimentações:**
  - Tabela financeira premium no desktop e lista em cards no mobile, sem esconder valor, data ou categoria.
  - Busca integrada (mantenha `placeholder` começando com "Pesquisar") e filtros organizados em chips/selects.
  - Editar e excluir intuitivos.
  - Transferências e a seção "Transferências recentes" preservadas.
  - `TransactionForm` totalmente redesenhado, mantendo `.money-input`, os placeholders e a lógica de parcelas e recorrência.
- **Contas a pagar:**
  - Atrasadas, pendentes e pagas com diferença visual clara (cor, ícone e texto, nunca só cor).
  - Indicador de vencimento (ex.: "vence em 3 dias") e cards de resumo.
  - Filtros consistentes e ação de pagar com as mesmas regras.
- **Metas:**
  - Cards próprios com `MoonPhase` adaptada (lavanda/roxo).
  - Barra de progresso elegante.
  - Separação clara entre metas individuais e familiares.
  - Contribuir e retirar sem mudança de regra.
  - Estado vazio com convite à ação.
- **Relatórios:**
  - Filtros de período no topo, gráficos com a mesma identidade, comparações legíveis e tabelas refinadas.
  - CSV e PDF preservados.
  - **`@media print` com fundo branco, texto escuro e sem sidebar/header**, legível em papel.
- **Configurações:**
  - Navegação em grupos (perfil, preferências e tema, Telegram, contas — mantenha `#contas` —, categorias, pessoas só para o gestor, segurança).
  - Inputs, toggles e selects novos.
  - Estados de salvar, sucesso e erro.
  - Ações sensíveis com confirmação clara.
- **Autenticação (`/entrar`, `/definir-senha`):**
  - Novo visual dark premium com a lua abstrata.
  - Estados de link inválido ou expirado, erro, loading e bloqueio.
  - Mensagens genéricas preservadas: não revele se o e-mail existe.
  - Lógica de autenticação intocada.

---

## 9. DESIGN SYSTEM E COMPONENTES

Reorganize `styles.css` em vez de acumular sobrescritas no fim. Divida em arquivos por camada, importados por `main.tsx` (ou um `styles/index.css`):
- `tokens.css`: cores dark e light, tipografia, espaçamento (escala de 4px), raios, bordas, sombras mínimas, z-index, durações, easing e breakpoints documentados.
- `base.css`: reset, fontes e foco.
- `layout.css`.
- `components.css`.
- `pages/*.css` quando fizer sentido.
- `print.css`.

Ao final, remova as regras antigas sem uso. Não pode sobrar seletor duplicado nem conflitante.

Padronize (alturas 32/40/48, raios, estados `hover`/`focus-visible`/`active`/`disabled`/`loading`) e transforme em componentes reutilizáveis tipados:
- Button (primary, secondary, ghost, danger e icon), Input, MoneyInput, Select, SearchField, DateField (nativo estilizado, sem nova lib), Textarea, Checkbox, Toggle, Tabs/SegmentedControl, Chip, Badge, StatusChip.
- ProgressBar, Tooltip, Modal (com foco preso e Esc fechando), Dropdown/menu.
- Table e lista responsiva, Toast, Skeleton, Empty, ErrorState, Card e StatCard.

Nenhuma tela ou modal pode ficar com aparência antiga.

**React Bits e Uiverse:**
1. Antes de usar, consulte a documentação e o código real em reactbits.dev e uiverse.io.
2. Candidatos do React Bits: Spotlight Card (hover sutil no hero e nos cards principais, só com ponteiro fino), Count Up (saldo do hero, uma vez no carregamento), Animated Content (entrada dos blocos) e Border Glow (no máximo no hero).
3. Candidatos do Uiverse: botões, inputs, toggles, checkboxes, selects, tooltips, loaders e hover states.
4. Regras:
   - Só itens gratuitos.
   - **Não instale** `motion`/`framer-motion`, `gsap` ou similares só para esses efeitos: reimplemente em React com CSS e `requestAnimationFrame`, em TypeScript tipado.
   - Adapte tudo aos tokens.
   - Registre a origem e a licença de cada peça adaptada em `docs/DESIGN.md`.

---

## 10. MOTION

- Microinterações de 150 a 300ms com easing suave em hover, foco, abertura de modal e entrada de blocos.
- Count Up só no saldo principal, só uma vez e sem repetir ao trocar de visão.
- Sem animação contínua, efeito chamativo seguindo o cursor ou elemento em movimento permanente.
- `prefers-reduced-motion: reduce` desliga transições, Count Up (mostra o valor final na hora) e Spotlight.
- Animações nunca atrasam a leitura do valor nem a interação.

---

## 11. RESPONSIVIDADE

Teste em **1440, 1280, 768, 390 e 360px** (e 375px, pelo E2E). Verifique:
- Cards sem sobreposição.
- Valores monetários grandes sem corte (use `clamp()` e quebra controlada).
- Gráficos com altura correta e `ResponsiveContainer` sem warnings.
- Formulários e modais usáveis, com modal em tela cheia ou sheet no mobile e sem overflow.
- Tabelas virando lista em telas pequenas, sem esconder dado importante.
- Sidebar no desktop e tabbar no mobile.

---

## 12. UX, ACESSIBILIDADE E INTEGRIDADE

- Contraste AA nos dois temas, foco visível em tudo e `aria-label` em botões só de ícone.
- `aria-current` na navegação e tooltips acessíveis por teclado.
- Status nunca comunicado só por cor.
- Formatação brasileira: `R$ 1.234,56`, datas `dd/mm` e `pt-BR` em gráficos e tooltips.
- Dados de outros membros aparecem apenas quando a API já os entrega (respeite `null` e `detail`).
- Nenhum texto de interface pode conter adm, admin, administrador, proprietário, fundador ou dono.
- Sem dados fictícios apresentados como reais. Estado vazio é estado vazio.

---

## 13. PROCESSO DE EXECUÇÃO

Antes de começar:
1. Crie a branch `redesign/dark-premium` a partir de `main`. Commits locais por etapa estão permitidos nessa branch. **Sem push, sem merge em `main`, sem deploy.**
2. Leia `README.md`, `docs/SEGURANCA.md`, `e2e/smoke.mjs` e, se existirem, `CLAUDE.md` e `.claude/`.
3. Verifique quais skills estão realmente disponíveis no seu ambiente. Use as pertinentes e só alegue uso das que de fato invocou: frontend-design, ui-ux-pro-max, interface-design e web-design-guidelines na revisão final; humanizer para microcopy, se houver. Se faltarem, siga os princípios deste prompt e registre isso.

Etapas:
- **A. Auditoria:** inventário de rotas, componentes, classes usadas pelo E2E, estados e dependências, e lista do que reaproveitar.
- **B. Design system:** fontes locais, tokens dark e light, reorganização do CSS e componentes base.
- **C. Layout:** sidebar, header, tabbar e grid.
- **D. Painel.**
- **E. Demais páginas, auth, modais e `TransactionForm`.**
- **F. Validação** (seção 14). Corrija e revalide até passar.

Não pare depois da auditoria nem depois do painel. O trabalho só termina com o app inteiro redesenhado.

---

## 14. TESTES E QA (relate PASS / FAIL / SKIP com motivo)

1. `npm run typecheck`, `npm run build` e `npm test` (testes do backend em PGlite: devem continuar passando, e eventuais falhas que já existiam devem ser identificadas como tal).
2. `npm run demo:seed` (se `.data/` não existir) e `npm run dev`. No navegador disponível, faça login com `lipe@demo` e com `luciana@demo.luna`, e percorra todas as rotas nos dois temas e nas larguras da seção 11.
3. Teste de verdade:
   - Criar, editar e excluir lançamento, inclusive parcelado e transferência.
   - Pagar conta.
   - Contribuir em meta.
   - Filtros e busca.
   - Trocar visão eu/família.
   - Trocar tema.
   - Exportar CSV e prévia de impressão do relatório.
   - Recolher a sidebar.
   - Abrir e fechar modais por teclado.
4. Verifique se o console está sem erros e se não há violação de CSP (fontes carregando de `'self'`).
5. `npm run e2e` (Playwright): exige `playwright` instalado e o servidor com dados de demonstração (`BASE_URL` apontando para o app). Se o Playwright não estiver disponível, marque SKIP com o motivo. Não instale dependências globais sem necessidade.
6. Tire capturas de tela do painel, de movimentações e do login (desktop e mobile). Faça uma inspeção visual de alinhamento, contraste, fontes, ícones e overflow.
7. Não declare um teste visual como feito sem ter aberto um navegador. Build verde não é prova de redesign concluído.

---

## 15. CRITÉRIOS DE ACEITE (observáveis)

- [ ] Abrindo qualquer uma das 8 rotas em dark e em light, nenhum elemento mantém o visual antigo (sem Fraunces, sem papel/dourado).
- [ ] A fonte Fontshare escolhida carrega localmente, sem erro de CSP no console, e valores monetários usam algarismos tabulares.
- [ ] O painel mostra hero de saldo, indicadores, movimentações recentes reais, coluna lateral e gráficos redesenhados, **sem nenhum card de IA ou assistente**.
- [ ] Ao trocar entre eu e família, os números mudam conforme a API, e dados de outros membros só aparecem quando autorizados.
- [ ] Em 360px e 375px não há rolagem horizontal, a `.tabbar` aparece e modais e formulários são usáveis.
- [ ] Na sidebar recolhida, cada ícone mostra tooltip e todos os itens navegam por teclado.
- [ ] Com reduced-motion ativo, não há animação e o saldo aparece direto.
- [ ] A impressão do relatório sai legível em fundo branco, e o CSV continua baixando.
- [ ] Nenhuma tela exibe adm, admin, administrador, proprietário, fundador ou dono, e a área de pessoas só aparece para o gestor.
- [ ] `typecheck` e `build` passam sem erro, `npm test` passa (ou as falhas que já existiam estão documentadas) e o E2E passa ou tem SKIP justificado.
- [ ] Não há mudança em `server/`, nas regras de negócio, nos contratos de API nem nos valores em centavos.
- [ ] `styles.css` ficou organizado em camadas, sem blocos antigos mortos ou duplicados.

---

## 16. ENTREGA E RELATÓRIO

Ao final, apresente:
1. Resumo do que mudou, por etapa.
2. Arquivos principais criados, alterados e removidos.
3. Fonte escolhida, com o porquê, a comparação feita, a licença e os pesos incluídos.
4. Componentes adaptados do React Bits e do Uiverse, com origem, licença e o que foi alterado.
5. Decisões de identidade visual (também em `docs/DESIGN.md`: tokens, escala tipográfica, uso de cor e motion).
6. Resultado de cada teste (PASS/FAIL/SKIP e motivo).
7. Capturas de tela (desktop e mobile).
8. Limitações e pendências reais.
9. Estado do Git: branch `redesign/dark-premium`, lista de commits, confirmação de que nada foi enviado ao GitHub e de que `main` e `visual-next` não foram tocadas.
