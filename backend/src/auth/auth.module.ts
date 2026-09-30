import { Module } from '@nestjs/common';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LdapModule } from '../ldap/ldap.module';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';

const JWT_SIGN_OPTIONS = {
  expiresIn: process.env.JWT_EXPIRES_IN || '8h',
} as JwtModuleOptions['signOptions'];

@Module({
  imports: [
    LdapModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET,
      signOptions: JWT_SIGN_OPTIONS,
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtAuthGuard, RolesGuard],
  // JwtModule exportado para que os guards funcionem nos módulos que importarem o AuthModule.
  exports: [JwtModule, JwtAuthGuard, RolesGuard],
})
export class AuthModule {}
