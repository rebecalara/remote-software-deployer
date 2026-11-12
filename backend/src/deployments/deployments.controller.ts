import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { validateDeploymentCreate } from './deployment-validation';
import { DeploymentsService, DeploymentView } from './deployments.service';

/** Quem pode implantar: mesma regra da escrita no catálogo (ADMIN e OPERATOR). */
export const DEPLOYMENT_WRITE_ROLES: UserRole[] = [UserRole.ADMIN, UserRole.OPERATOR];

@Controller('deployments')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DeploymentsController {
  constructor(private readonly deploymentsService: DeploymentsService) {}

  /** Cria e enfileira; responde na hora (201) com as máquinas como PENDING. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Roles(...DEPLOYMENT_WRITE_ROLES)
  create(@Body() body: unknown, @Req() req: AuthenticatedRequest): Promise<DeploymentView> {
    // O JwtAuthGuard roda antes e sempre preenche request.user; o `sub` é o id do User.
    return this.deploymentsService.create(validateDeploymentCreate(body), req.user!.sub);
  }
}
