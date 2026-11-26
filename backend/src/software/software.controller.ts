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
import { recordSecurityEvent, requestIp, SecurityDetail, SecurityEventName } from '../observability/security-events';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { InstallerLimits, SoftwareService, SoftwareView } from './software.service';
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

  /**
   * Limites do envio do instalador, para a tela conferir o arquivo antes de enviar.
   * Leitura para qualquer usuário logado.
   *
   * PRECISA ficar declarada ANTES de @Get(':id'): o Express testa as rotas na ordem
   * de declaração, e ':id' capturaria "installer-limits" (o ParseUUIDPipe
   * responderia 400).
   */
  @Get('installer-limits')
  installerLimits(): InstallerLimits {
    return this.softwareService.getInstallerLimits();
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string): Promise<SoftwareView> {
    return this.softwareService.get(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @CanWriteCatalog()
  create(@Body() body: unknown, @Req() req: AuthenticatedRequest): Promise<SoftwareView> {
    // Validação síncrona (400 na hora); o evento só depois de gravado.
    const input = validateSoftwareCreate(body);
    return Promise.resolve(this.softwareService.create(input, userIdOf(req))).then((view) => {
      catalogEvent('catalog.software.created', req, () => softwareDetails(view));
      return view;
    });
  }

  @Patch(':id')
  @CanWriteCatalog()
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: AuthenticatedRequest,
  ): Promise<SoftwareView> {
    const input = validateSoftwareUpdate(body);
    return Promise.resolve(this.softwareService.update(id, input, userIdOf(req))).then((view) => {
      // Só os NOMES dos campos alterados (os valores ficam na auditoria do próprio software).
      catalogEvent('catalog.software.updated', req, () => ({ ...softwareDetails(view), 'software.fields': Object.keys(input).sort((a, b) => a.localeCompare(b)).join(',') }));
      return view;
    });
  }

  /** Some da seleção de novas implantações; continua no histórico. */
  @Post(':id/deactivate')
  @HttpCode(HttpStatus.OK)
  @CanWriteCatalog()
  async deactivate(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest): Promise<SoftwareView> {
    const view = await this.softwareService.setActive(id, false, userIdOf(req));
    catalogEvent('catalog.software.deactivated', req, () => softwareDetails(view));
    return view;
  }

  @Post(':id/activate')
  @HttpCode(HttpStatus.OK)
  @CanWriteCatalog()
  async activate(@Param('id', ParseUUIDPipe) id: string, @Req() req: AuthenticatedRequest): Promise<SoftwareView> {
    const view = await this.softwareService.setActive(id, true, userIdOf(req));
    catalogEvent('catalog.software.activated', req, () => softwareDetails(view));
    return view;
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
      const view = await this.softwareService.uploadInstaller(id, body, originalName, userIdOf(req));
      catalogEvent('catalog.software.installer_uploaded', req, () => ({
        ...softwareDetails(view),
        'installer.sha256': view.installer?.sha256 ?? null,
        'installer.size_bytes': view.installer?.sizeBytes ?? null,
      }));
      return view;
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
  async remove(@Param('id', ParseUUIDPipe) id: string, @Req() req?: AuthenticatedRequest): Promise<void> {
    await this.softwareService.remove(id);
    catalogEvent('catalog.software.deleted', req, () => ({ 'software.id': id }));
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
 * Quanto o descarte aceita ler no máximo, em múltiplos do limite de tamanho. Sem
 * teto fixo, quem declarasse 100 GB faria o servidor ler e jogar fora 100 GB
 * (limitado só pelo requestTimeout). Com 2×: um arquivo um pouco acima do limite
 * (ex.: 600 MB com limite de 500) ainda recebe o 413 com a mensagem; acima de
 * 2×, a conexão é fechada e o cliente leva reset — o frontend nunca chega lá,
 * porque confere o tamanho antes de enviar. Ver DECISIONS.md.
 */
export const DISCARD_CEILING_FACTOR = 2;

/**
 * Teto do descarte: com Content-Length, o tamanho declarado (é o que o cliente vai
 * enviar — cortar antes faria ele levar reset e não ler o 413), mas nunca acima de
 * 2× o limite; sem Content-Length (envio em partes), o limite de tamanho.
 */
export function discardLimit(contentLength: string | undefined, maxBytes: number): number {
  const declared = Number(contentLength);
  const wanted = Number.isInteger(declared) && declared > 0 ? declared : maxBytes;
  return Math.min(wanted, maxBytes * DISCARD_CEILING_FACTOR);
}

/** Evento de segurança de mudança no catálogo, com quem fez e de onde. */
function catalogEvent(
  event: SecurityEventName,
  req: AuthenticatedRequest | UploadRequest | undefined,
  details: () => Record<string, SecurityDetail>,
): void {
  recordSecurityEvent(() => ({ event, result: 'success', user: req?.user?.username, role: req?.user?.role, ip: requestIp(req), details: details() }));
}

export function softwareDetails(view: SoftwareView): Record<string, string> {
  return { 'software.id': view.id, 'software.name': `${view.name} ${view.version}`, 'software.type': view.installType };
}

// O JwtAuthGuard roda antes e sempre preenche request.user; o `sub` é o id do User.
function userIdOf(req: AuthenticatedRequest): string {
  return req.user!.sub;
}
