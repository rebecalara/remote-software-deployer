import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LdapModule } from '../ldap/ldap.module';
import { MachinesController } from './machines.controller';
import { MachinesService } from './machines.service';
import { MachineSyncService } from './machine-sync.service';
import { MachineSyncScheduler } from './machine-sync.scheduler';

@Module({
  imports: [AuthModule, LdapModule],
  controllers: [MachinesController],
  providers: [MachinesService, MachineSyncService, MachineSyncScheduler],
})
export class MachinesModule {}
