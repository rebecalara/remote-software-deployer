import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { IncomingMessage } from 'node:http';
import { PassThrough, type Readable } from 'node:stream';
import { JwtPayload } from '../auth/auth.types';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { SoftwareService, SoftwareView } from './software.service';
import { validateSoftwareCreate, validateSoftwareUpdate } from './software-validation';
import { parseInstallerUploadHeaders } from './installer-upload-headers';
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

  /** Some da seleção de novas implantações; continua no histórico. */
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @CanWriteCatalog()
  deactivate(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest): Promise<SoftwareView> {
    return this.softwareService.setActive(id, false, userIdOf(req));
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @CanWriteCatalog()
  activate(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest): Promise<SoftwareView> {
    return this.softwareService.setActive(id, true, userIdOf(req));
  }

  /**
   * Envia (ou troca) o instalador: corpo binário em stream, nome original em
   * X-File-Name. Os cabeçalhos são conferidos antes de ler o corpo (413 pelo
   * Content-Length, 415 se não for octet-stream). O arquivo nunca é devolvido.
   *
   * Recusa com o cliente ainda enviando: o servidor responde e DESCARTA o resto do
   * corpo, em vez de fechar a conexão. Fechar a conexão (ou destruir a requisição)
   * faz o cliente, que ainda está escrevendo, levar um reset e nunca ler a resposta
   * — o usuário veria "erro de rede" em vez de "o instalador excede 500 MB"
   * (encontrado no teste ao vivo; ver DECISIONS.md). Por isso o corpo passa por um
   * PassThrough: quando a gravação aborta, quem é destruído é ele, não a conexão.
   */
  @Put(':id/installer')
  @HttpCode(HttpStatus.OK)
  @CanWriteCatalog()
  async uploadInstaller(@Param('id', ParseUUIDPipe) id: string, @Req() req: UploadRequest): Promise<SoftwareView> {
    const maxBytes = this.softwareService.maxInstallerSizeBytes;
    const body = new PassThrough();
    try {
      const originalName = parseInstallerUploadHeaders(req.headers, maxBytes);
      // pipe() não repassa erro nem cancelamento do cliente: sem isto a gravação
      // ficaria esperando para sempre e o .part não seria apagado.
      req.on('close', () => {
        if (!req.complete) body.destroy(new Error('Envio interrompido pelo cliente.'));
      });
      req.on('error', (err) => body.destroy(err));
      req.pipe(body);
      return await this.softwareService.uploadInstaller(id, body, originalName, userIdOf(req));
    } catch (err) {
      req.unpipe(body);
      body.destroy();
      discardRemainingBody(req, discardLimit(req.headers['content-length'], maxBytes));
      throw err;
    }
  }

  /** Só software nunca implantado (corrigir cadastro errado); senão 409 → desativar. */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @CanWriteCatalog()
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.softwareService.remove(id);
  }
}

// A própria requisição do Node é o stream do corpo (o Nest não interpreta
// application/octet-stream, então os bytes chegam intactos).
type UploadRequest = IncomingMessage & { user?: JwtPayload };

/**
 * Lê e joga fora o resto do corpo, para o cliente terminar de enviar e ler a
 * resposta de erro. Passou do teto, fecha a conexão (e o requestTimeout limita o
 * tempo de qualquer forma).
 */
export function discardRemainingBody(req: Readable, maxBytes: number): void {
  let discarded = 0;
  req.on('data', (chunk: Buffer) => {
    discarded += chunk.length;
    if (discarded > maxBytes) req.destroy();
  });
  req.resume();
}

/**
 * Teto do descarte: com Content-Length, o tamanho declarado (finito, e é o que o
 * cliente vai enviar — cortar antes faria ele levar reset e não ler o 413); sem
 * ele (envio em partes), o limite de tamanho.
 */
export function discardLimit(contentLength: string | undefined, maxBytes: number): number {
  const declared = Number(contentLength);
  return Number.isInteger(declared) && declared > 0 ? declared : maxBytes;
}

// O JwtAuthGuard roda antes e sempre preenche request.user; o `sub` é o id do User.
function userIdOf(req: AuthenticatedRequest): string {
  return req.user!.sub;
}
