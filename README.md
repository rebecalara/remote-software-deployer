# Remote Software Deployer

## Descrição

O Remote Software Deployer é uma plataforma web para gerenciamento e implantação
remota de softwares em computadores corporativos, desenvolvida como Trabalho de
Conclusão de Curso em Engenharia de Software.

O projeto nasceu de uma necessidade real observada na Prefeitura Municipal de
Joinville: centralizar e simplificar o processo de instalação de softwares em
múltiplas máquinas da rede, hoje realizado de forma manual ou com ferramentas
que não cobrem todos os cenários do dia a dia da equipe de TI.

A plataforma permite consultar máquinas via Active Directory, selecionar
softwares de um catálogo próprio, e executar instalações remotamente através
de WinRM e PowerShell — sem exigir nenhum agente instalado previamente nas
máquinas clientes.

## Stack

- **Banco:** PostgreSQL
- **ORM:** Prisma 5

## Como rodar

### 1. Criar o banco

**Opção A — via Docker (recomendado):**
```bash
docker run --name rsd-db -e POSTGRES_PASSWORD=sua_senha -e POSTGRES_DB=remote_software_deployer -p 5432:5432 -d postgres
```

**Opção B — PostgreSQL já instalado localmente:**
```sql
CREATE DATABASE remote_software_deployer;
```

### 2. Instalar as dependências

```bash
cd backend
npm install
```

### 3. Configurar a conexão

```bash
cp .env.example .env
```

Preencha `DATABASE_URL` com os dados do seu PostgreSQL local.

### 4. Aplicar as migrations

```bash
npm run db:deploy
```

Cria as seis tabelas: `User`, `Machine`, `Software`, `Deployment`,
`DeploymentTarget` e `DeploymentLog`.

Para inspecionar os dados pelo navegador: `npm run db:studio`.