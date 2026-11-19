import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { MAX_TARGETS_PER_DEPLOYMENT } from '../deployments/deployment-validation';
import { InventoryService, InventoryState, InventorySummary, InventoryView } from './inventory.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Corpo de POST /machines/inventory-summary: de 1 a 50 ids de máquina, sem repetição. */
export function parseSummaryBody(body: unknown): string[] {
  const ids = (body as { machineIds?: unknown } | null)?.machineIds;
  const fail = (message: string) =>
    new BadRequestException({ statusCode: 400, error: 'Bad Request', message, field: 'machineIds' });
  if (!Array.isArray(ids) || ids.length === 0) throw fail('Selecione ao menos uma máquina.');
  if (ids.some((id) => typeof id !== 'string' || !UUID.test(id))) throw fail('A lista de máquinas contém um identificador inválido.');
  const unique = [...new Set((ids as string[]).map((id) => id.toLowerCase()))];
  if (unique.length > MAX_TARGETS_PER_DEPLOYMENT) throw fail(`Selecione no máximo ${MAX_TARGETS_PER_DEPLOYMENT} máquinas.`);
  return unique;
}

/** Quem consulta ao vivo: usa a conta de serviço administradora nas estações. */
export const INVENTORY_COLLECT_ROLES: UserRole[] = [UserRole.ADMIN, UserRole.OPERATOR];

// RF08. Rotas sob /machines/:id (o MachinesController não tem rotas com :id, então não
// há disputa de ordem entre os dois controllers).
@Controller('machines')
@UseGuards(JwtAuthGuard, RolesGuard)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  /**
   * Desinstalação pelo inventário (assistente): software instalado nas máquinas
   * selecionadas, agrupado, a partir da última consulta guardada de cada uma. Só leitura
   * (POST só para levar a lista de ids no corpo). ADMIN e OPERATOR, como o assistente.
   */
  @Post('inventory-summary')
  @HttpCode(HttpStatus.OK)
  @Roles(...INVENTORY_COLLECT_ROLES)
  summary(@Body() body: unknown): Promise<InventorySummary> {
    return this.inventory.summary(parseSummaryBody(body));
  }

  /** A última consulta guardada (ou null) e se a consulta ao vivo está disponível. Todos os perfis. */
  @Get(':id/inventory')
  latest(@Param('id', ParseUUIDPipe) id: string): Promise<InventoryState> {
    return this.inventory.latest(id);
  }

  /** Consulta ao vivo, síncrona (até ~2 min). Falha na máquina: 502 (504 se tempo esgotado), com `reason`. */
  @Post(':id/inventory')
  @HttpCode(HttpStatus.OK)
  @Roles(...INVENTORY_COLLECT_ROLES)
  collect(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest): Promise<InventoryView> {
    return this.inventory.collect(id, req.user!.sub, req.user!.username);
  }
}
