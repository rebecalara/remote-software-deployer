import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DeploymentsModule } from '../deployments/deployments.module';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

// RF08: usa o MESMO PowerShellExecutor da implantação (credencial, powershell.exe e
// filtro de senha), exportado pelo DeploymentsModule.
@Module({
  imports: [AuthModule, DeploymentsModule],
  controllers: [InventoryController],
  providers: [InventoryService],
})
export class InventoryModule {}
