-- O login converte o usuário para minúsculas antes de consultar a tabela User
-- ("Rebeca" = "rebeca"). O banco recusa um cadastro manual com maiúsculas, que nunca
-- conseguiria entrar. Escrita à mão: o Prisma 5.22 não declara CHECK no schema.
ALTER TABLE "User" ADD CONSTRAINT "User_username_lowercase_check" CHECK ("username" = lower("username"));
