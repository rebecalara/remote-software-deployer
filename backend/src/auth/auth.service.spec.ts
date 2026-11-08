import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LdapAuthenticationError, LdapConnectionError, LdapService } from '../ldap/ldap.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';

describe('AuthService', () => {
  let service: AuthService;
  let ldapService: { bind: jest.Mock };
  let prisma: {
    user: {
      findUnique: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
    };
  };
  let jwtService: { signAsync: jest.Mock };

  const fakeUser = {
    id: 'user-1',
    username: 'lrebeca',
    displayName: 'Rebeca Lara',
    email: null,
    role: UserRole.OPERATOR,
    createdAt: new Date(),
  };

  beforeEach(() => {
    ldapService = { bind: jest.fn() };
    prisma = {
      user: {
        findUnique: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
      },
    };
    jwtService = { signAsync: jest.fn().mockResolvedValue('fake.jwt.token') };

    service = new AuthService(
      ldapService as unknown as LdapService,
      prisma as unknown as PrismaService,
      jwtService as unknown as JwtService,
    );
  });

  it('rejeita quando username ou password estão vazios', async () => {
    await expect(service.login('', 'algo')).rejects.toThrow(BadRequestException);
    await expect(service.login('lrebeca', '')).rejects.toThrow(BadRequestException);
    expect(ldapService.bind).not.toHaveBeenCalled();
  });

  it('retorna accessToken e dados do usuário quando bind e User batem', async () => {
    ldapService.bind.mockResolvedValue(undefined);
    prisma.user.findUnique.mockResolvedValue(fakeUser);

    const result = await service.login('lrebeca', 'senha-correta');

    expect(ldapService.bind).toHaveBeenCalledWith('lrebeca', 'senha-correta');
    expect(jwtService.signAsync).toHaveBeenCalledWith({
      sub: fakeUser.id,
      username: fakeUser.username,
      role: fakeUser.role,
    });
    expect(result).toEqual({
      accessToken: 'fake.jwt.token',
      user: {
        id: fakeUser.id,
        username: fakeUser.username,
        displayName: fakeUser.displayName,
        role: fakeUser.role,
      },
    });
  });

  it('retorna 401 genérico quando o bind LDAP rejeita a credencial', async () => {
    ldapService.bind.mockRejectedValue(new LdapAuthenticationError('invalid credentials'));

    await expect(service.login('lrebeca', 'senha-errada')).rejects.toThrow(
      UnauthorizedException,
    );
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('retorna o mesmo 401 genérico quando o servidor LDAP está inacessível', async () => {
    ldapService.bind.mockRejectedValue(new LdapConnectionError('ECONNREFUSED'));

    await expect(service.login('lrebeca', 'qualquer')).rejects.toThrow(UnauthorizedException);
  });

  it('provisiona automaticamente como ADMIN quando é o primeiro usuário do sistema', async () => {
    ldapService.bind.mockResolvedValue(undefined);
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.count.mockResolvedValue(0);
    prisma.user.create.mockResolvedValue({
      id: 'user-admin',
      username: 'primeiro_admin',
      displayName: 'primeiro_admin',
      email: null,
      role: UserRole.ADMIN,
      createdAt: new Date(),
    });

    const result = await service.login('primeiro_admin', 'senha-valida');

    expect(prisma.user.count).toHaveBeenCalled();
    expect(prisma.user.create).toHaveBeenCalledWith({
      data: {
        username: 'primeiro_admin',
        displayName: 'primeiro_admin',
        role: UserRole.ADMIN,
      },
    });
    expect(result.user.role).toBe(UserRole.ADMIN);
  });

  it('provisiona automaticamente como OPERATOR quando outros usuários já existem', async () => {
    ldapService.bind.mockResolvedValue(undefined);
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.user.count.mockResolvedValue(2);
    prisma.user.create.mockResolvedValue({
      id: 'user-op',
      username: 'novo_operador',
      displayName: 'novo_operador',
      email: null,
      role: UserRole.OPERATOR,
      createdAt: new Date(),
    });

    const result = await service.login('novo_operador', 'senha-valida');

    expect(prisma.user.count).toHaveBeenCalled();
    expect(prisma.user.create).toHaveBeenCalledWith({
      data: {
        username: 'novo_operador',
        displayName: 'novo_operador',
        role: UserRole.OPERATOR,
      },
    });
    expect(result.user.role).toBe(UserRole.OPERATOR);
  });

  it.each([
    ['número', 123],
    ['booleano', true],
    ['objeto', { nome: 'usuario' }],
    ['array', ['usuario']],
  ])('rejeita username do tipo %s com HTTP 400', async (_tipo, username) => {
    await expect(
      service.login(username, 'senha123'),
    ).rejects.toThrow(BadRequestException);

    expect(ldapService.bind).not.toHaveBeenCalled();
  });
  it.each([
    ['número', 123],
    ['booleano', true],
    ['objeto', { senha: '123' }],
    ['array', ['senha123']],
    ['nulo', null],
  ])('rejeita password do tipo %s com HTTP 400', async (_tipo, password) => {
    await expect(
      service.login('usuario', password),
    ).rejects.toThrow(BadRequestException);

    expect(ldapService.bind).not.toHaveBeenCalled();
  });
  it('rejeita username contendo apenas espaços', async () => {
    await expect(
      service.login('   ', 'senha123'),
    ).rejects.toThrow(BadRequestException);

    expect(ldapService.bind).not.toHaveBeenCalled();
  });
});
