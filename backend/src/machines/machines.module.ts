import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DeploymentsModule } from '../deployments/deployments.module';
import { LdapModule } from '../ldap/ldap.module';
import { MachinesController } from './machines.controller';
import { MachinesService } from './machines.service';
import { MachineSyncService } from './machine-sync.service';
import { MachineSyncScheduler } from './machine-sync.scheduler';
import { MachineReachabilityScheduler } from './machine-reachability.scheduler';

// DeploymentsModule: o PowerShellExecutor diz se há WinRM neste servidor (sem ele, a
// verificação de quais máquinas respondem fica desligada — modo demonstração).
@Module({
  imports: [AuthModule, LdapModule, DeploymentsModule],
  controllers: [MachinesController],
  providers: [MachinesService, MachineSyncService, MachineSyncScheduler, MachineReachabilityScheduler],
})
export class MachinesModule {}
