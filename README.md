# Remote Software Deployer

Descrição


## Stack

- **Banco:** PostgreSQL
- **ORM:** Prisma 5

## Como rodar

### 1. Criar o banco

```sql
CREATE DATABASE deployer;
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