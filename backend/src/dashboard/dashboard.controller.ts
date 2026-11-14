import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { DashboardService, DashboardView } from './dashboard.service';

@Controller('dashboard')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  /** Leitura para qualquer usuário logado. */
  @Get()
  overview(): Promise<DashboardView> {
    return this.dashboardService.overview();
  }
}
