import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LdapModule } from '../ldap/ldap.module';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';
import { LoginRateLimiter } from './login-rate-limiter';
import { buildJwtModuleOptions } from './jwt.config';

@Module({
  imports: [
    LdapModule,
    // Lido na subida: JWT_SECRET ausente ou com menos de 32 caracteres impede o backend de
    // subir; HS256 fixo na assinatura e na verificação (jwt.config.ts).
    JwtModule.registerAsync({ useFactory: () => buildJwtModuleOptions(process.env) }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, RolesGuard, LoginRateLimiter],
  // JwtModule exportado para que os guards funcionem nos módulos que importarem o AuthModule.
  exports: [JwtModule, JwtAuthGuard, RolesGuard],
})
export class AuthModule {}
