import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DeploymentsModule } from '../deployments/deployments.module';
import { LdapModule } from '../ldap/ldap.module';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

@Module({
  imports: [AuthModule, DeploymentsModule, LdapModule],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}
