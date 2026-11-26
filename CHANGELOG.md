# Changelog

Mudanças relevantes do Remote Software Deployer (RSD). Formato baseado em
[Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); versões no
[Versionamento Semântico](https://semver.org/lang/pt-BR/).

## [1.0.0] - 2026-11-26

Primeira versão: implantação remota de software em estações Windows, com as máquinas vindas
do Active Directory e a execução pelo WinRM/PowerShell.

### Funcionalidades
- Login pela conta de rede (bind LDAP/Active Directory), sem senha guardada no sistema;
  perfis Administrador, Operador e Visualizador.
- Máquinas sincronizadas com o AD, automaticamente e por "Sincronizar com o AD", com busca,
  filtro por setor e painel de detalhes.
- Verificação de quais máquinas respondem na porta do WinRM (5985), automática e por
  "Verificar WinRM".
- Catálogo de software com envio do instalador MSI ou EXE, SHA-256 calculado pelo servidor,
  argumentos de instalação silenciosa e desativação; edição em painel lateral.
- Implantação remota pelo WinRM: fila com até 10 máquinas em paralelo, uma instalação por
  máquina de cada vez, código de saída por máquina e cancelamento das que estão na fila.
- MSI já instalado na máquina não é executado de novo.
- Nova Implantação em 3 passos: Máquinas, Software e Revisar.
- Desinstalação remota de MSI pelo ProductCode, inclusive de produto fora do catálogo,
  escolhido pelo inventário.
- Desinstalação de programa que não é MSI pelo comando silencioso declarado pelo fabricante
  (desligada por padrão).
- Inventário do software instalado em cada máquina, consultado ao vivo e atualizado depois
  de cada implantação.
- Dashboard com contadores, atividade recente e status do sistema.
- Monitoramento das implantações em andamento e Histórico com filtros, paginação e
  "Minhas implantações".
- Status "Parcial" para implantação com resultado misto.
- Exportação do Histórico em CSV.
- Implantação igual já em andamento é recusada; limite de máquinas por implantação
  configurável (`DEPLOYMENT_MAX_MACHINES`).
- Envio de instalador com disco cheio no servidor responde 507, com mensagem clara.
- Login com aviso de Caps Lock e volta para a página anterior depois de entrar.
- Identidade visual própria do RSD.

### Segurança
- Limite de tentativas de login por endereço IP.
- Backend escuta só em 127.0.0.1 por padrão (`HOST` e `PORT` configuráveis).
- `JWT_SECRET` com pelo menos 32 caracteres e algoritmo HS256 fixo.
- Usuário do login convertido para minúsculas e restrito a caracteres permitidos; suporte a
  LDAPS e aviso para `ldap://` sem criptografia.
- Pasta temporária do instalador protegida na máquina de destino
  (`C:\ProgramData\RSD`, só SYSTEM e Administradores).
- MSI nunca reinicia a máquina (`REBOOT=ReallySuppress` sempre por último); a tela Revisar
  avisa que um instalador EXE pode reiniciar sozinho.
- Sessão guardada no navegador validada ao ler e ao gravar.
- Validação da entrada do login e do parâmetro de busca de máquinas.

### Desempenho
- Índices no banco para o Histórico, e filtro "Falhou" que não degrada com o volume.
- Paginação na tela e busca adiada em Máquinas e na Nova Implantação.
- Limite de 500 linhas de log por máquina.

### Acessibilidade
- Dicas acessíveis pelo mouse, pelo teclado e pelo leitor de tela, com o gatilho num botão
  nativo.
- Fundos escuros de diálogos e painéis sem papel interativo; a gaveta do menu fecha com Esc.
- Escala tipográfica única e respeito à preferência "reduzir movimento".

### Qualidade e CI
- Testes automatizados com cobertura no backend (Jest) e no frontend (Vitest e Testing
  Library).
- Integração contínua no GitHub Actions (testes, cobertura e build) e análise estática no
  SonarCloud.
- Correções apontadas pelo SonarCloud.
- Testes estáveis fora do Windows e independentes da velocidade da máquina.
- Dependências atualizadas: vite 7.3.8 e source-map-js 1.2.2.
- Contribuições de colegas revisadas e incorporadas por pull request: #2 (máquina repetida na
  mesma implantação), #3 (enums, índices e regras de exclusão no banco), #6 (validação da
  entrada do login) e #10 (validação da busca de máquinas).

### Documentação
- README com arquitetura, decisões de segurança, como rodar localmente e integração contínua.
- `.env.example` com todas as variáveis comentadas.

### Limitações conhecidas
- Ver a seção [Limitações conhecidas](README.md#limitações-conhecidas) do README.

[1.0.0]: https://github.com/rebecalara/remote-software-deployer/releases/tag/v1.0.0
