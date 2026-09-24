import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
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

  async login(username: string, password: string): Promise<LoginResponse> {
    const normalizedUsername = username?.trim();
    if (!normalizedUsername || !password) {
      throw new BadRequestException('Usuário e senha são obrigatórios.');
    }

    await this.authenticateAgainstLdap(normalizedUsername, password);

    const user = await this.prisma.user.findUnique({
      where: { username: normalizedUsername },
    });

    if (!user) {
      this.logger.warn(
        `Bind LDAP ok para "${normalizedUsername}", mas não há User cadastrado no sistema.`,
      );
      throw new UnauthorizedException(GENERIC_AUTH_ERROR);
    }

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
