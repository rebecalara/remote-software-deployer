# Identidade visual do RSD

Marca própria do Remote Software Deployer. A Prefeitura aparece como cliente para quem o
sistema foi construído (rodapé do login), não como marca do produto.

## Conceito

- **Símbolo:** grade 3×3 de máquinas. O quadrado do canto (azul) é o servidor; os outros
  mostram os mesmos estados da interface: verde = ok, âmbar = instalando, cinza = na fila.
- **Nome:** `>rsd_`, no estilo terminal (JetBrains Mono 500). O `>` e o `_` ficam na cor da marca.
- **Login:** o servidor "acende" as máquinas uma a uma, a barra enche e o cursor pisca.
  Respeita "reduzir movimento" do sistema (`prefers-reduced-motion`): com ele ligado, a marca
  fica parada — a grade no mesmo estado do símbolo estático, a barra cheia e o cursor visível,
  sem piscar.

## Onde a marca aparece no sistema

| Lugar | Como fica |
|---|---|
| Login (computador) | Grade animada sozinha (ciclo de 4,8 s), `>rsd_` com cursor piscando, barra de progresso e "Remote Software Deployer". Com "reduzir movimento": tudo parado (grade como o símbolo, barra cheia, cursor fixo). Rodapé: desenvolvido para a TI da Prefeitura de Joinville |
| Login (celular) | Símbolo + `>rsd_` + "Remote Software Deployer", parados |
| Menu lateral aberto (240 px) | Símbolo de 32 px + `>rsd_`, alinhados à esquerda com os ícones do menu; ☰ à direita |
| Menu lateral recolhido (72 px) | Só o símbolo, com o ☰ embaixo |
| Logo do menu (aberto ou recolhido) | Ao passar o mouse ou focar com Tab, as máquinas acendem em onda (ciclo de 2,4 s; parada com "reduzir movimento"); clique leva ao Dashboard (no celular, fecha o menu) |
| Aba do navegador | Favicon 2×2 (SVG + PNG 32 px + ícone de 180 px para a tela inicial do iPhone) |

## Cores

| Papel | Tailwind | Hex |
|---|---|---|
| Marca (fundo claro) | `blue-600` | `#2563EB` |
| Marca (fundo escuro) | `blue-500` / texto `blue-400` | `#3B82F6` / `#60A5FA` |
| Ok | `emerald-600` (claro) / `emerald-500` (escuro) | `#059669` / `#10B981` |
| Instalando | `amber-500` | `#F59E0B` |
| Na fila | `slate-300` (claro) / `slate-700` (escuro) | `#CBD5E1` / `#334155` |
| Texto | `slate-900` | `#0F172A` |
| Fundo escuro | `slate-950` | `#020617` |

## Fontes

- Inter 400, 500 e 600: interface (o 700 não é carregado; a escala tipográfica só usa esses três)
- JetBrains Mono 500: só o nome `>rsd_` (classe `font-brand`; o `font-mono` do sistema não muda)

As fontes são servidas pelo próprio sistema, sem Google Fonts: pacotes `@fontsource/inter` e
`@fontsource/jetbrains-mono` (versão exata 5.3.0, licença OFL incluída no pacote), importados em
`frontend/src/main.tsx` só nos pesos acima. Funcionam sem internet (rede interna, demonstração).

## Arquivos

| Uso | Arquivo |
|---|---|
| Aba do navegador | `svg/rsd-favicon.svg` (grade 2×2; a 3×3 não lê em 16 px) |
| Símbolo | `svg/rsd-simbolo.svg`, `svg/rsd-simbolo-escuro.svg` |
| Nome | `svg/rsd-wordmark.svg`, `svg/rsd-wordmark-escuro.svg` |
| Cabeçalhos, documentos | `svg/rsd-horizontal.svg`, `svg/rsd-horizontal-escuro.svg` |
| Capa do TCC, slides | `svg/rsd-capa-clara.svg`, `svg/rsd-capa-escura.svg` |
| Ícones internos | `svg/rsd-icone-pacote.svg`, `svg/rsd-icone-instalando.svg` |

Os SVGs têm o texto convertido em curvas: abrem iguais em qualquer computador, sem a fonte
instalada. Os PNGs em `png/` são para Word, PowerPoint e pôster (até 3200 px).

## No código

| O quê | Arquivo |
|---|---|
| Símbolo (estático; `animateOnHover` para o menu) | `frontend/src/components/brand/RsdMark.tsx` |
| Nome `>rsd_` (fonte `font-brand`) | `frontend/src/components/brand/RsdWordmark.tsx` |
| Marca animada do login | `frontend/src/components/brand/RsdLoginBrand.tsx` |
| Animações e fonte da marca | `frontend/src/index.css` (`rsd-deploy`, `rsd-deploy-fill`, `rsd-fill`, `rsd-blink`, `--font-brand`) |
| Arquivos das fontes | `frontend/src/main.tsx` (imports do `@fontsource`) |
| Logo do menu (link + hover) | `frontend/src/components/layout/Sidebar.tsx` |
| Largura do menu (240 px) | `frontend/src/components/layout/AppLayout.tsx` |
| Login | `frontend/src/pages/Login/LoginPage.tsx` |
| Favicon | `frontend/index.html`, `frontend/public/` |

Os antigos `frontend/public/Logotipo_Prefeitura.png` e `frontend/src/assets/logo.png` não eram
mais usados e foram removidos (24/11/2026). Se a logo da Prefeitura precisar voltar, os dois estão
no histórico do git (commit `3795333d`).
