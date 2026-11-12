import { Logger, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SoftwareModule } from '../software/software.module';
import { DeploymentRunner } from './deployment-runner';
import { DeploymentsController } from './deployments.controller';
import { DeploymentsService } from './deployments.service';
import { PowerShellExecutor, loadPowerShellExecutorConfig } from './powershell-executor';

@Module({
  imports: [AuthModule, SoftwareModule],
  controllers: [DeploymentsController],
  providers: [
    DeploymentsService,
    DeploymentRunner,
    {
      // A configuração vem do ambiente (WINRM_*, DEPLOYMENT_INSTALL_TIMEOUT_MINUTES).
      // Problema de configuração não derruba o backend: só deixa a implantação
      // indisponível (POST /deployments responde 503 com o motivo).
      provide: PowerShellExecutor,
      useFactory: () =>
        new PowerShellExecutor(loadPowerShellExecutorConfig(process.env, new Logger(PowerShellExecutor.name))),
    },
  ],
})
export class DeploymentsModule {}
