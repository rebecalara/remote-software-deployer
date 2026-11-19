import { Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { InventoryService, InventoryState, InventoryView } from './inventory.service';

/** Quem consulta ao vivo: usa a conta de serviço administradora nas estações. */
export const INVENTORY_COLLECT_ROLES: UserRole[] = [UserRole.ADMIN, UserRole.OPERATOR];

// RF08. Rotas sob /machines/:id (o MachinesController não tem rotas com :id, então não
// há disputa de ordem entre os dois controllers).
@Controller('machines')
@UseGuards(JwtAuthGuard, RolesGuard)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

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
