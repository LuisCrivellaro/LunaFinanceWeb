# Luna Finance — design system

Redesign "noite clara" (branch `redesign/dark-premium`). Este documento registra as decisões de identidade visual e onde cada coisa mora no código.

## Conceito

Um painel noturno e calmo para as finanças da família. O **roxo/lavanda** é a identidade e marca foco e seleção. **Verde e vermelho** só carregam significado: receita/despesa e estados (em dia, atrasado). A **logo** é o husky no círculo roxo (`web/public/brand/`: `logo-160.webp` para a marca na interface, `logo-512.webp` na tela de acesso, favicons e `apple-touch-icon.png`), sempre via `LunaMark` em `components/Layout.tsx`. A lua continua presente de forma abstrata: no arco do card de saldo, nos anéis da tela de acesso e nas **fases da lua** das metas.

O **dark é a experiência principal** e o tema padrão. O claro tem tokens próprios (não é uma inversão), e a opção "Automático" segue o sistema operacional.

## Arquivos

| Arquivo | Conteúdo |
|---|---|
| `web/src/styles/tokens.css` | `@font-face`, tokens de cor (dark e claro), tipografia, espaço, raios, alturas, sombras, camadas, movimento, layout e breakpoints (documentados no topo) |
| `web/src/styles/base.css` | reset, escala tipográfica, `.num`/`.tnum`, utilitários de grade |
| `web/src/styles/layout.css` | shell, sidebar (expandida/recolhida + tooltip), topo, cabeçalho de página, tabbar e FAB no mobile |
| `web/src/styles/components.css` | cartões, KPIs, botões, campos, interruptor, segmentado, chips, listas, tabelas, barras, skeleton, vazio, alertas, toasts, modal, menu suspenso, gráficos |
| `web/src/styles/pages.css` | painel, movimentações, contas, metas, configurações, acesso |
| `web/src/styles/print.css` | `prefers-reduced-motion` e impressão (papel branco, sem navegação) |
| `web/src/styles/index.css` | importa as camadas na ordem acima |

## Cores (dark)

| Token | Valor | Uso |
|---|---|---|
| `--bg` / `--bg-2` | `#0b0b0f` / `#111115` | fundo / sidebar e campos |
| `--surface` / `-2` / `-3` | `#17171c` / `#1e1e24` / `#26262d` | cartões / hover e elevado / ativo |
| `--line` / `--line-strong` | `#24242b` / `#34343d` | bordas de 1px |
| `--text` / `-2` / `-3` | `#f5f4f7` / `#a9a7b1` / `#8a8894` | texto (todos ≥ 4,5:1 sobre `--surface`) |
| `--primary` | `#c48aff` | identidade, foco, item ativo, botão principal (texto `#17092a`) |
| `--primary-soft` | `rgba(196,138,255,.10)` | fundo do item ativo e das seleções |
| `--income` / `--expense` | `#64d6aa` / `#f0787a` | receita / despesa, estados ok / ruim |
| `--warn` | `#f2b85b` | vencimento próximo, pendente |
| `--lime` | `#a8fa65` | destaque raro (meta atingida) |

O tema claro usa os mesmos nomes, com valores ajustados para contraste sobre branco. Por exemplo, `--primary` vira `#7d43d4`, com texto branco.

Regras:
- Gradiente roxo só no card de saldo e na tela de acesso.
- Sem neon, e sem sombra grande em cartões: a separação vem da borda e do tom. A sombra fica para menus, modais e toasts.
- Desfoque de fundo (blur) só no topo fixo, na tabbar e no fundo de modais.
- Status nunca depende só da cor: há sempre texto ("Atrasado", "vence em 3 dias", "Pago").

## Tipografia

**Satoshi** (Indian Type Foundry, via Fontshare), uma única família no arquivo variável (300–900).

Comparada com General Sans e Switzer, foi a única das três com tabela **`tnum` (algarismos tabulares)**, essencial para valores e tabelas. Também é a que fica mais firme nos saldos grandes.

| Papel | Tamanho | Peso | Tracking |
|---|---|---|---|
| Saldo (display) | `clamp(40px, 5vw, 60px)` | 700 | −0,035em |
| H1 da página | `clamp(24px, 2.4vw, 30px)` | 700 | −0,02em |
| H2 (título de card) | 16px | 650 | −0,01em |
| H3 | 14px | 650 | 0 |
| Corpo | 14,5px | 450 | 0 |
| Pequeno / legenda | 13px / 12px | 450–600 | 0 |
| Eyebrow (rótulo) | 11,5px, caixa alta | 600 | 0,09em |
| KPI | `clamp(20px, 2vw, 26px)` | 650 | −0,025em |

Todo valor monetário usa `.num` (`tabular-nums` + `tnum`).

### Licença e por que a fonte não está no git

A **ITF Free Font License** permite uso comercial e **auto-hospedagem no próprio site/app**. Ela **proíbe** disponibilizar o arquivo em repositórios ou servidores públicos para terceiros, e este repositório é público.

Por isso `web/public/fonts/` está no `.gitignore`, e `web/scripts/fetch-fonts.mjs` baixa o WOFF2 oficial do Fontshare antes de `dev:web` e `build:web` (também em `npm run fonts`). O arquivo é servido pelo nosso próprio servidor, o que a CSP exige (`font-src 'self'`).

Sem rede, o app continua funcionando com as fontes do sistema.

## Espaço, raios e alturas

- **Espaço:** escala de 4px (`--s-1` … `--s-12`).
- **Raios:** 6 / 10 / 14 / 20 / 26px (`--r-xs` … `--r-xl`). Cartões usam 20px, o card de saldo e os modais 26px, controles 10px.
- **Alturas de controle:** 32 / 40 / 48px.

## Movimento

Entre 150 e 300ms, com `--ease-out`, em hover, foco, abertura de modal e menu e entrada escalonada dos blocos. Não há animação contínua nem efeito que siga o cursor pela página.

Com `prefers-reduced-motion: reduce`, transições e animações são desligadas, o saldo aparece direto e o spotlight e as animações dos gráficos (Recharts) são desativados.

## Componentes adaptados (origem e licença)

| Peça | Origem | O que mudou |
|---|---|---|
| `useSpotlight` + `.spotlight` (brilho que segue o ponteiro no card de saldo) | Ideia do **Spotlight Card** do [React Bits](https://reactbits.dev), licença MIT + Commons Clause | Reescrito do zero: um handler que escreve `--mx`/`--my` e um `radial-gradient` em `::before`. Só com mouse, desligado em telas touch e com reduced motion |
| `useCountUp` (contagem do saldo, uma vez por sessão) | Ideia do **Count Up** do React Bits | O original depende de `motion`. Aqui usa `requestAnimationFrame` + easing exponencial, sem dependências, com o valor final para leitores de tela |
| `.reveal` (entrada escalonada) | Equivalente leve ao **Animated Content** do React Bits | O original usa GSAP + ScrollTrigger. Aqui é só CSS (`@keyframes rise`, atrasos de 40ms) |
| Interruptor, caixa de seleção, segmentado | Padrões comuns em [Uiverse](https://uiverse.io) (MIT) | Escritos sobre os tokens, com `input` nativo (`role="switch"`), foco visível e estado desabilitado |

Nenhuma biblioteca nova foi instalada. As fontes `@fontsource-variable/fraunces` e `hanken-grotesk` foram removidas.

## Ganchos que não podem mudar

O teste `e2e/smoke.mjs` depende destas classes e textos:
- Classes: `.btn-primary`, `.hero .balance`, `.sidebar .btn-primary`, `.tabbar`, `.list-item`, `.toast`, `.modal`, `.modal-foot .btn-primary`, `.modal-foot .btn-danger`, `.money-input`, `#contas`.
- Placeholders: "Pesquisar…", "Ex.: Supermercado" e "Ex.: Nubank".
- Textos: "Transferências recentes" (uma única vez), "Nova conta" e "Transferir entre contas".
- O primeiro `select` do formulário de movimentação é a categoria.
- Nenhum texto da interface pode conter adm, admin, administrador, proprietário, fundador ou dono.
