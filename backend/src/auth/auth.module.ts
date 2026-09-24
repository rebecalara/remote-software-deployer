import { Module } from '@nestjs/common';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LdapModule } from '../ldap/ldap.module';

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
  providers: [AuthService],
})
export class AuthModule {}
