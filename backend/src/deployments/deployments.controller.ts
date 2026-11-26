import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { Response } from 'express';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { recordSecurityEvent, requestIp } from '../observability/security-events';
import { parseDeploymentListQuery, parseMaxMachines, validateDeploymentCreate } from './deployment-validation';
import {
  DeploymentLogView,
  DeploymentOverview,
  DeploymentPage,
  DeploymentsService,
  DeploymentView,
} from './deployments.service';

/** Quem pode implantar e cancelar: mesma regra da escrita no catálogo (ADMIN e OPERATOR). */
export const DEPLOYMENT_WRITE_ROLES: UserRole[] = [UserRole.ADMIN, UserRole.OPERATOR];

// O JwtAuthGuard roda antes e sempre preenche request.user.
@Controller('deployments')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DeploymentsController {
  private readonly logger = new Logger(DeploymentsController.name);
  /** Máquinas por implantação (DEPLOYMENT_MAX_MACHINES, padrão 50), lido uma vez na subida. */
  private readonly maxMachines = parseMaxMachines(process.env.DEPLOYMENT_MAX_MACHINES, (msg) => this.logger.warn(msg));

  constructor(private readonly deploymentsService: DeploymentsService) {}

  /**
   * Leitura para qualquer usuário logado. Mais recentes primeiro, paginada
   * (?page=, ?pageSize= até 100) e com filtros (?status=, ?softwareId=, ?machine=,
   * ?from= e ?to= em ISO 8601). Filtro inválido = 400 com o campo.
   * ?mine=true traz só as criadas pelo usuário logado — o id sai do token, nunca da query.
   * ?state=active|finished separa em andamento e encerradas; ?finishedFrom= (ISO 8601)
   * limita as encerradas a partir de um instante (Monitoramento: últimas 24 h).
   * ?action=INSTALL|UNINSTALL filtra por instalação ou desinstalação.
   */
  @Get()
  list(@Query() query: Record<string, unknown>, @Req() req: AuthenticatedRequest): Promise<DeploymentPage> {
    return this.deploymentsService.list(parseDeploymentListQuery(query), req.user!.sub);
  }

  /**
   * Contadores do painel de Monitoramento. Leitura para qualquer usuário logado.
   *
   * PRECISA ficar declarada ANTES de @Get(':id'): o Express testa as rotas na ordem de
   * declaração, e ':id' capturaria "summary" (o ParseUUIDPipe responderia 400) — mesma
   * lição da rota installer-limits do catálogo.
   */
  @Get('summary')
  summary(): Promise<DeploymentOverview> {
    return this.deploymentsService.summary();
  }

  /**
   * Limites que a tela precisa conhecer antes de enviar (hoje: máquinas por implantação).
   * Leitura para qualquer usuário logado. Também ANTES de @Get(':id').
   */
  @Get('limits')
  limits(): { maxMachines: number } {
    return { maxMachines: this.maxMachines };
  }

  /**
   * Histórico em CSV, com os MESMOS filtros e a mesma validação da listagem (?mine=true pelo
   * usuário do token). Leitura para qualquer usuário logado; sem login, 401 (guard da classe).
   * Uma linha por máquina; mais de 10.000 = 400. Também ANTES de @Get(':id').
   */
  @Get('export')
  async exportCsv(
    @Query() query: Record<string, unknown>,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { fileName, csv } = await this.deploymentsService.exportCsv(parseDeploymentListQuery(query), req.user!.sub);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    // StreamableFile: um Buffer devolvido direto seria serializado como JSON pelo Nest.
    return new StreamableFile(Buffer.from(csv, 'utf8'));
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
    // Validação síncrona (400 na hora); o evento só depois de criada.
    const input = validateDeploymentCreate(body, this.maxMachines);
    return Promise.resolve(this.deploymentsService.create(input, req.user!.sub)).then((view) => this.created(view, req));
  }

  private created(view: DeploymentView, req: AuthenticatedRequest): DeploymentView {
    recordSecurityEvent(() => ({
      event: 'deployment.created',
      result: 'success',
      user: req.user!.username,
      role: req.user!.role,
      ip: requestIp(req),
      details: deploymentDetails(view),
    }));
    return view;
  }

  /** Cancela só as máquinas pendentes; as em execução terminam normalmente. */
  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @Roles(...DEPLOYMENT_WRITE_ROLES)
  cancel(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest): Promise<DeploymentView> {
    return Promise.resolve(this.deploymentsService.cancel(id, req.user!.username)).then((view) => this.cancelled(view, req));
  }

  private cancelled(view: DeploymentView, req: AuthenticatedRequest): DeploymentView {
    recordSecurityEvent(() => ({
      event: 'deployment.cancelled',
      result: 'success',
      user: req.user!.username,
      role: req.user!.role,
      ip: requestIp(req),
      details: { ...deploymentDetails(view), 'deployment.cancelled_machines': view.counts.cancelled },
    }));
    return view;
  }
}

/** Atributos da implantação nos eventos de segurança (sem o comando do fabricante nem nomes de máquina). */
export function deploymentDetails(view: DeploymentView): Record<string, string | number | null> {
  return {
    'deployment.id': view.id,
    'deployment.action': view.action,
    'deployment.machines': view.targets.length,
    'software.id': view.software?.id ?? null,
    'software.name': view.software ? `${view.software.name} ${view.software.version}` : (view.product?.name ?? null),
    'product.code': view.product?.productCode ?? null,
  };
}
