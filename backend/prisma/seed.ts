import { PrismaClient, UserRole } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const adminUsername = process.env.INITIAL_ADMIN_USERNAME || 'admin';
  const adminDisplayName = process.env.INITIAL_ADMIN_DISPLAY_NAME || 'Administrador do Sistema';

  const user = await prisma.user.upsert({
    where: { username: adminUsername },
    update: {},
    create: {
      username: adminUsername,
      displayName: adminDisplayName,
      role: UserRole.ADMIN,
    },
  });

  console.log(`Seed executado com sucesso: usuário "${user.username}" (${user.role}) configurado.`);
}

main()
  .catch((e) => {
    console.error('Erro ao executar seed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

