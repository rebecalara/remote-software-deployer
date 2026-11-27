import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';
import { LdapAuthenticationError, LdapConnectionError, LdapService } from '../ldap/ldap.service';
import { JwtPayload, LoginResponse } from './auth.types';
import { userForLogs } from '../observability/security-events';

const GENERIC_AUTH_ERROR = 'Usuário ou senha inválidos.';
/** AD fora do ar ou sem resposta: 503, e não conta no limite de tentativas de login. */
export const AUTH_UNAVAILABLE_ERROR = 'Serviço de autenticação indisponível. Tente novamente em instantes.';

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

    // Usuário sem diferenciar maiúsculas: "Rebeca" = "rebeca" no LDAP (que já não diferencia)
    // e na tabela User (gravada sempre em minúsculas). A senha não muda.
    const normalizedUsername = username.trim().toLowerCase();

    if (!normalizedUsername || password.length === 0) {
      throw new BadRequestException(
        'Usuário e senha são obrigatórios.',
      );
    }

    await this.authenticateAgainstLdap(normalizedUsername, password);

    const user = await this.prisma.user.findUnique({
      where: { username: normalizedUsername },
    });

    if (!user) {
      this.logger.warn(
        `Bind LDAP ok para ${userForLogs(normalizedUsername)}, mas não há User cadastrado no sistema.`,
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
          `Falha de conexão com o LDAP ao autenticar ${userForLogs(username)}: ${err.message}`,
        );
        // Não é erro de credencial: a pessoa não errou nada, e o 401 a faria tentar de
        // novo (e gastar o limite de tentativas) com a senha certa.
        throw new ServiceUnavailableException(AUTH_UNAVAILABLE_ERROR);
      } else if (err instanceof LdapAuthenticationError) {
        // userForLogs: entre aspas (sem forjar linhas) ou, com SECURITY_EVENTS_INCLUDE_PII=false, o
        // mesmo pseudônimo do evento de segurança.
        this.logger.warn(`Bind LDAP rejeitado para ${userForLogs(username)}: ${err.message}`);
      } else {
        this.logger.error(
          `Erro inesperado ao autenticar ${userForLogs(username)}: ${(err as Error).message}`,
        );
      }

      throw new UnauthorizedException(GENERIC_AUTH_ERROR);
    }
  }
}
