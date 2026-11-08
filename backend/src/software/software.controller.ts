import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { SoftwareService, SoftwareView } from './software.service';
import { validateSoftwareCreate, validateSoftwareUpdate } from './software-validation';
import { SoftwareValidationFilter } from './software-validation.filter';

/**
 * Quem pode escrever no catálogo. ADMIN e OPERATOR de propósito — a restrição por
 * perfil foi descartada (ver DECISIONS.md). Para restringir de novo, basta mudar
 * esta linha: todas as rotas de escrita usam @CanWriteCatalog().
 */
export const CATALOG_WRITE_ROLES: UserRole[] = [UserRole.ADMIN, UserRole.OPERATOR];
export const CanWriteCatalog = () => Roles(...CATALOG_WRITE_ROLES);

@Controller('software')
@UseGuards(JwtAuthGuard, RolesGuard)
@UseFilters(SoftwareValidationFilter)
export class SoftwareController {
  constructor(private readonly softwareService: SoftwareService) {}

  /** Leitura para qualquer usuário logado. Desativados só com ?includeInactive=true. */
  @Get()
  list(@Query('includeInactive') includeInactive?: string): Promise<SoftwareView[]> {
    return this.softwareService.list({ includeInactive: includeInactive === 'true' });
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<SoftwareView> {
    return this.softwareService.get(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @CanWriteCatalog()
  create(@Body() body: unknown, @Req() req: AuthenticatedRequest): Promise<SoftwareView> {
    return this.softwareService.create(validateSoftwareCreate(body), userIdOf(req));
  }

  @Patch(':id')
  @CanWriteCatalog()
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ): Promise<SoftwareView> {
    return this.softwareService.update(id, validateSoftwareUpdate(body), userIdOf(req));
  }
}

// O JwtAuthGuard roda antes e sempre preenche request.user; o `sub` é o id do User.
function userIdOf(req: AuthenticatedRequest): string {
  return req.user!.sub;
}
