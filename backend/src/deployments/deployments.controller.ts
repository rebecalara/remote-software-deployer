import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { validateDeploymentCreate } from './deployment-validation';
import {
  DeploymentLogView,
  DeploymentSummaryView,
  DeploymentsService,
  DeploymentView,
  parseListLimit,
} from './deployments.service';

/** Quem pode implantar e cancelar: mesma regra da escrita no catálogo (ADMIN e OPERATOR). */
export const DEPLOYMENT_WRITE_ROLES: UserRole[] = [UserRole.ADMIN, UserRole.OPERATOR];

// O JwtAuthGuard roda antes e sempre preenche request.user.
@Controller('deployments')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DeploymentsController {
  constructor(private readonly deploymentsService: DeploymentsService) {}

  /** Leitura para qualquer usuário logado. Mais recentes primeiro (?limit=, padrão 50, máx. 200). */
  @Get()
  list(@Query('limit') limit?: unknown): Promise<DeploymentSummaryView[]> {
    return this.deploymentsService.list(parseListLimit(limit));
  }

  /** Leitura para qualquer usuário logado. A tela de acompanhamento consulta esta rota. */
  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<DeploymentView> {
    return this.deploymentsService.get(id);
  }

  /** Leitura para qualquer usuário logado. */
  @Get(':id/targets/:targetId/logs')
  logs(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('targetId', ParseUUIDPipe) targetId: string,
  ): Promise<DeploymentLogView[]> {
    return this.deploymentsService.logs(id, targetId);
  }

  /** Cria e enfileira; responde na hora (201) com as máquinas como PENDING. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles(...DEPLOYMENT_WRITE_ROLES)
  create(@Body() body: unknown, @Req() req: AuthenticatedRequest): Promise<DeploymentView> {
    return this.deploymentsService.create(validateDeploymentCreate(body), req.user!.sub);
  }

  /** Cancela só as máquinas pendentes; as em execução terminam normalmente. */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @Roles(...DEPLOYMENT_WRITE_ROLES)
  cancel(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest): Promise<DeploymentView> {
    return this.deploymentsService.cancel(id, req.user!.username);
  }
}
