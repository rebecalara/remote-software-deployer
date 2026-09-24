import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LdapAuthenticationError, LdapConnectionError, LdapService } from '../ldap/ldap.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';

describe('AuthService', () => {
  let service: AuthService;
  let ldapService: { bind: jest.Mock };
  let prisma: { user: { findUnique: jest.Mock } };
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
    prisma = { user: { findUnique: jest.fn() } };
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

  it('retorna 401 genérico (Política A) quando o bind funciona mas não há User cadastrado', async () => {
    ldapService.bind.mockResolvedValue(undefined);
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(service.login('lrebeca', 'senha-valida')).rejects.toThrow(
      UnauthorizedException,
    );
    expect(jwtService.signAsync).not.toHaveBeenCalled();
  });

  it('não distingue, na mensagem de erro, credencial inválida de usuário não cadastrado', async () => {
    ldapService.bind.mockRejectedValue(new LdapAuthenticationError('invalid credentials'));
    let messageForBadCredential = '';
    try {
      await service.login('lrebeca', 'senha-errada');
    } catch (err) {
      messageForBadCredential = (err as UnauthorizedException).message;
    }

    ldapService.bind.mockResolvedValue(undefined);
    prisma.user.findUnique.mockResolvedValue(null);
    let messageForMissingUser = '';
    try {
      await service.login('lrebeca', 'senha-valida');
    } catch (err) {
      messageForMissingUser = (err as UnauthorizedException).message;
    }

    expect(messageForBadCredential).toBe(messageForMissingUser);
  });
});
