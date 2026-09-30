import { Controller, Get, HttpCode, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { MachineListResponse, MachinesService } from './machines.service';
import { SyncResult } from './machine-sync.service';
import { MachineSyncScheduler, SyncStatus } from './machine-sync.scheduler';

@Controller('machines')
@UseGuards(JwtAuthGuard, RolesGuard)
export class MachinesController {
  constructor(
    private readonly machinesService: MachinesService,
    private readonly machineSyncScheduler: MachineSyncScheduler,
  ) {}

  @Get()
  list(@Query('search') search?: string): Promise<MachineListResponse> {
    return this.machinesService.list(search);
  }

  /** "Sincronizar agora": passa pelo scheduler, que reinicia a contagem do automático. */
  @Post('sync')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.ADMIN, UserRole.OPERATOR)
  async sync(): Promise<SyncResult & { nextRunAt: string | null }> {
    const result = await this.machineSyncScheduler.run('MANUAL');
    return { ...result, nextRunAt: this.machineSyncScheduler.getStatus().nextRunAt };
  }

  /** Leitura para qualquer usuário logado — expõe falha silenciosa da sync automática. */
  @Get('sync/status')
  syncStatus(): SyncStatus {
    return this.machineSyncScheduler.getStatus();
  }
}
