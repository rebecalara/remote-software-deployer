import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LdapAuthenticationError, LdapConnectionError, LdapService } from '../ldap/ldap.service';
import { JwtPayload, LoginResponse } from './auth.types';

const GENERIC_AUTH_ERROR = 'Usuário ou senha inválidos.';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly ldapService: LdapService,
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async login(username: unknown, password: unknown): Promise<LoginResponse> {
    if (typeof username !== 'string' || typeof password !== 'string') {
      throw new BadRequestException(
        'Usuário e senha devem ser textos válidos.',
      );
    }

    const normalizedUsername = username.trim();

    if (!normalizedUsername || password.length === 0) {
      throw new BadRequestException(
        'Usuário e senha são obrigatórios.',
      );
    }

    await this.authenticateAgainstLdap(normalizedUsername, password);

    const existingUser = await this.prisma.user.findUnique({
      where: { username: normalizedUsername },
    });

    const user =
      existingUser ?? (await this.provisionUser(normalizedUsername));

    const payload: JwtPayload = {
      sub: user.id,
      username: user.username,
      role: user.role,
    };
    const accessToken = await this.jwtService.signAsync(payload);

    return {
      accessToken,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
      },
    };
  }

  private async provisionUser(username: string) {
    const totalUsers = await this.prisma.user.count();
    const role = totalUsers === 0 ? UserRole.ADMIN : UserRole.OPERATOR;
    const user = await this.prisma.user.create({
      data: {
        username,
        displayName: username,
        role,
      },
    });
    this.logger.log(
      `Usuário "${username}" provisionado automaticamente com perfil ${role}.`,
    );
    return user;
  }

  private async authenticateAgainstLdap(username: string, password: string): Promise<void> {
    try {
      await this.ldapService.bind(username, password);
    } catch (err) {
      if (err instanceof LdapConnectionError) {
        this.logger.error(
          `Falha de conexão com o LDAP ao autenticar "${username}": ${err.message}`,
        );
      } else if (err instanceof LdapAuthenticationError) {
        this.logger.warn(`Bind LDAP rejeitado para "${username}": ${err.message}`);
      } else {
        this.logger.error(
          `Erro inesperado ao autenticar "${username}": ${(err as Error).message}`,
        );
      }

      throw new UnauthorizedException(GENERIC_AUTH_ERROR);
    }
  }
}
