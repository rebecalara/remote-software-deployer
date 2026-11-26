import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InstallType, Prisma } from '@prisma/client';
import type { Readable } from 'node:stream';
import { PrismaService } from '../prisma/prisma.service';
import {
  InstallerStorageService,
  InstallerStorageUnavailableError,
  InstallerTooLargeError,
  InvalidInstallerHeaderError,
} from './installer-storage.service';
import { MsiInfoReader } from './msi-info-reader';
import { SoftwareCreateInput, SoftwareUpdateInput, validateInstallArgs } from './software-validation';

export interface UserRef {
  username: string;
  displayName: string;
}

export interface InstallerInfo {
  originalName: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  uploadedAt: string | null;
}

/** O que a API devolve. installerFileName (nome interno em disco) nunca sai daqui. */
export interface SoftwareView {
  id: string;
  name: string;
  version: string;
  vendor: string | null;
  installType: InstallType;
  installArgs: string[];
  active: boolean;
  /** null = ainda sem instalador enviado. */
  installer: InstallerInfo | null;
  /** Contagem real de implantações (0 até o Bloco 4). */
  deploymentCount: number;
  /** ProductCode do MSI, lido pelo servidor do pacote no envio. null para EXE. */
  msiProductCode: string | null;
  /** Desinstalação remota possível: só MSI com ProductCode conhecido. */
  uninstallAvailable: boolean;
  createdAt: string;
  updatedAt: string;
  createdBy: UserRef | null;
  updatedBy: UserRef | null;
}

export interface InstallerLimits {
  /** Tamanho máximo de um instalador, em bytes (INSTALLER_MAX_SIZE_MB). */
  maxSizeBytes: number;
  /** false = pasta de instaladores não configurada: o envio responde 503. */
  storageAvailable: boolean;
}

// Campos que definem O QUE é instalado. Depois da primeira implantação, mudá-los
// faria o histórico dizer que "7-Zip 23.01" instalou outra coisa — cadastra-se uma
// nova versão em vez disso. name e vendor continuam editáveis.
const EXECUTION_FIELDS = ['version', 'installType', 'installArgs'] as const;

const userSelect = { select: { username: true, displayName: true } } as const;
const softwareInclude = {
  _count: { select: { deployments: true } },
  createdBy: userSelect,
  updatedBy: userSelect,
} satisfies Prisma.SoftwareInclude;

type SoftwareWithRelations = Prisma.SoftwareGetPayload<{ include: typeof softwareInclude }>;

@Injectable()
export class SoftwareService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SoftwareService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: InstallerStorageService,
    private readonly msiReader: MsiInfoReader,
  ) {}

  /** Limite de tamanho do instalador, para o controller recusar pelo Content-Length. */
  get maxInstallerSizeBytes(): number {
    return this.storage.maxSizeBytes;
  }

  /**
   * Para a tela conferir o arquivo ANTES de enviar (evita transferir à toa um
   * arquivo que seria recusado) e avisar se o envio está desativado no servidor.
   */
  getInstallerLimits(): InstallerLimits {
    return { maxSizeBytes: this.storage.maxSizeBytes, storageAvailable: this.storage.isAvailable };
  }

  async list(options: { includeInactive?: boolean } = {}): Promise<SoftwareView[]> {
    const rows = await this.prisma.software.findMany({
      where: options.includeInactive ? {} : { active: true },
      include: softwareInclude,
      orderBy: [{ name: 'asc' }, { version: 'asc' }],
    });
    return rows.map(toView);
  }

  async get(id: string): Promise<SoftwareView> {
    return toView(await this.findOrThrow(id));
  }

  async create(input: SoftwareCreateInput, userId: string): Promise<SoftwareView> {
    await this.assertUnique(input.name, input.version);
    try {
      const created = await this.prisma.software.create({
        data: { ...input, createdById: userId, updatedById: userId },
        include: softwareInclude,
      });
      return toView(created);
    } catch (err) {
      throw translateUniqueViolation(err, input.name, input.version);
    }
  }

  async update(id: string, input: SoftwareUpdateInput, userId: string): Promise<SoftwareView> {
    const current = await this.findOrThrow(id);

    const changedExecution = EXECUTION_FIELDS.filter(
      (field) => field in input && !sameValue(input[field], current[field]),
    );
    if (changedExecution.length > 0 && current._count.deployments > 0) {
      throw new ConflictException(
        `Este software já foi implantado: ${changedExecution.join(', ')} não pode mais ser alterado. ` +
          'Cadastre uma nova versão.',
      );
    }

    // O arquivo guardado tem a extensão do tipo (<uuid>.msi | <uuid>.exe) e o
    // cabeçalho foi conferido contra ele no envio: trocar o tipo invalidaria isso.
    const nextType = input.installType ?? current.installType;
    if (nextType !== current.installType && current.installerFileName) {
      throw new ConflictException(
        'O tipo do instalador não pode mudar depois que o arquivo foi enviado. ' +
          'Envie o instalador do novo tipo ou cadastre outro software.',
      );
    }

    // installArgs é sempre conferido contra o tipo que vai valer depois da edição:
    // os enviados agora, ou os já salvos quando só o tipo mudou.
    const data: Prisma.SoftwareUpdateInput = { ...input };
    if (input.installArgs !== undefined || input.installType !== undefined) {
      data.installArgs = validateInstallArgs(input.installArgs ?? current.installArgs, nextType);
    }

    const nextName = input.name ?? current.name;
    const nextVersion = input.version ?? current.version;
    if (nextName !== current.name || nextVersion !== current.version) {
      await this.assertUnique(nextName, nextVersion, id);
    }

    try {
      const updated = await this.prisma.software.update({
        where: { id },
        data: { ...data, updatedBy: { connect: { id: userId } } },
        include: softwareInclude,
      });
      return toView(updated);
    } catch (err) {
      throw translateUniqueViolation(err, nextName, nextVersion);
    }
  }

  /**
   * Desativa (some da seleção de novas implantações, continua no histórico) ou
   * reativa. Idempotente: desativar o que já está desativado só devolve o estado.
   */
  async setActive(id: string, active: boolean, userId: string): Promise<SoftwareView> {
    const current = await this.findOrThrow(id);
    if (current.active === active) return toView(current);
    const updated = await this.prisma.software.update({
      where: { id },
      data: { active, updatedBy: { connect: { id: userId } } },
      include: softwareInclude,
    });
    return toView(updated);
  }

  /**
   * Apaga só software NUNCA implantado — existe para corrigir cadastro errado.
   * Com implantações, a resposta é 409 e o caminho é desativar.
   */
  async remove(id: string): Promise<void> {
    const current = await this.findOrThrow(id);
    if (current._count.deployments > 0) throw cannotDeleteDeployed();

    try {
      await this.prisma.software.delete({ where: { id } });
    } catch (err) {
      // Corrida rara: uma implantação criada entre a checagem acima e o delete.
      // O banco recusa (Deployment → Software é RESTRICT); aqui só se garante 409.
      if (isForeignKeyRestriction(err)) throw cannotDeleteDeployed();
      throw err;
    }
    // Registro apagado primeiro: se apagar o arquivo falhar, sobra um órfão no disco
    // (avisado na próxima subida), nunca um registro apontando para arquivo sumido.
    if (current.installerFileName) await this.deleteFileQuietly(current.installerFileName);
  }

  /**
   * Recebe o instalador (corpo binário, em stream) e o associa ao software. Também
   * serve para TROCAR o arquivo — só antes da primeira implantação.
   *
   * Ordem que impede arquivo órfão e registro quebrado: grava o arquivo novo →
   * atualiza o registro SÓ se ele ainda aponta para o arquivo de antes (detecta
   * envio simultâneo) → apaga o arquivo antigo. Se o registro não for atualizado,
   * o arquivo novo é apagado.
   */
  async uploadInstaller(
    id: string,
    source: Readable,
    originalName: string,
    userId: string,
  ): Promise<SoftwareView> {
    if (!this.storage.isAvailable) {
      throw new ServiceUnavailableException(
        'Envio de instaladores indisponível: armazenamento não configurado no servidor.',
      );
    }
    const current = await this.findOrThrow(id);
    if (current._count.deployments > 0) {
      throw new ConflictException(
        'Este software já foi implantado: o instalador não pode mais ser trocado. Cadastre uma nova versão.',
      );
    }

    const saved = await this.storage.save(source, current.installType).catch((err) => {
      if (isDiskFull(err)) {
        // O .part já foi apagado pelo armazenamento; quem administra o servidor precisa saber.
        const code = (err as NodeJS.ErrnoException).code;
        this.logger.error(`Disco cheio ao gravar instalador (${code}): ${(err as Error).message}`);
      }
      throw toHttpUploadError(err);
    });
    // MSI: o ProductCode é lido do próprio pacote, aqui no servidor, para a
    // desinstalação não precisar copiar o instalador para a máquina. Se a leitura
    // falhar, o envio continua valendo — o software só fica sem desinstalação.
    const msiProductCode =
      current.installType === InstallType.MSI ? await this.readProductCode(saved.fileName) : null;

    let updated: Prisma.BatchPayload;
    try {
      updated = await this.prisma.software.updateMany({
        where: { id, installerFileName: current.installerFileName },
        data: {
          installerFileName: saved.fileName,
          installerOriginalName: originalName,
          installerSizeBytes: saved.sizeBytes,
          installerSha256: saved.sha256,
          installerUploadedAt: new Date(),
          msiProductCode,
          updatedById: userId,
        },
      });
    } catch (err) {
      await this.deleteFileQuietly(saved.fileName);
      throw err;
    }
    if (updated.count === 0) {
      // Outro envio trocou o arquivo (ou o software foi apagado) enquanto este gravava.
      await this.deleteFileQuietly(saved.fileName);
      throw new ConflictException('O instalador foi alterado por outro envio ao mesmo tempo. Tente de novo.');
    }

    if (current.installerFileName) await this.deleteFileQuietly(current.installerFileName);
    return this.get(id);
  }

  /**
   * Na subida, confere a pasta contra o banco — só AVISA, nunca apaga (decisão da
   * autora): arquivo sem registro (órfão) e registro sem arquivo (instalador sumiu
   * do disco; implantar esse software falharia no Bloco 4).
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.storage.isAvailable) return;
    const [files, rows] = await Promise.all([
      this.storage.listFiles(),
      this.prisma.software.findMany({
        where: { installerFileName: { not: null } },
        select: { name: true, version: true, installerFileName: true },
      }),
    ]);
    const referenced = new Set(rows.map((r) => r.installerFileName));
    const onDisk = new Set(files);

    const orphans = files.filter((f) => !referenced.has(f));
    if (orphans.length > 0) {
      this.logger.warn(
        `${orphans.length} instalador(es) na pasta sem registro no banco (não apagados): ${orphans.join(', ')}`,
      );
    }
    for (const row of rows.filter((r) => !onDisk.has(r.installerFileName!))) {
      this.logger.warn(`Instalador de "${row.name} ${row.version}" não encontrado na pasta: ${row.installerFileName}`);
    }

    // MSI enviado antes da desinstalação existir (ou cuja leitura falhou): tenta ler o
    // ProductCode agora. Só preenche — nunca altera um código já gravado.
    if (!this.msiReader.isAvailable) return;
    const missing = await this.prisma.software.findMany({
      where: { installType: InstallType.MSI, msiProductCode: null, installerFileName: { not: null } },
      select: { id: true, installerFileName: true },
    });
    for (const s of missing.filter((m) => onDisk.has(m.installerFileName!))) {
      await this.ensureMsiProductCode(s.id);
    }
  }

  /**
   * ProductCode de um MSI que ainda não o tem: lido do arquivo guardado e gravado.
   * null = não é MSI, não tem instalador ou a leitura falhou (o motivo vai ao log).
   * Só grava se o arquivo ainda for o mesmo (um envio simultâneo pode tê-lo trocado).
   */
  async ensureMsiProductCode(id: string): Promise<string | null> {
    const s = await this.prisma.software.findUnique({
      where: { id },
      select: { installType: true, msiProductCode: true, installerFileName: true },
    });
    if (!s || s.installType !== InstallType.MSI || !s.installerFileName) return null;
    if (s.msiProductCode) return s.msiProductCode;
    const code = await this.readProductCode(s.installerFileName);
    if (!code) return null;
    await this.prisma.software.updateMany({
      where: { id, installerFileName: s.installerFileName, msiProductCode: null },
      data: { msiProductCode: code },
    });
    this.logger.log(`ProductCode ${code} lido do instalador do software ${id}.`);
    return code;
  }

  private async readProductCode(fileName: string): Promise<string | null> {
    const result = await this.msiReader.read(this.storage.localPath(fileName));
    return result.ok ? result.info.productCode : null;
  }

  private async deleteFileQuietly(fileName: string): Promise<void> {
    try {
      await this.storage.delete(fileName);
    } catch (err) {
      this.logger.warn(`Não foi possível apagar o instalador ${fileName}: ${(err as Error).message}`);
    }
  }

  private async findOrThrow(id: string): Promise<SoftwareWithRelations> {
    const software = await this.prisma.software.findUnique({ where: { id }, include: softwareInclude });
    if (!software) throw new NotFoundException('Software não encontrado.');
    return software;
  }

  /**
   * O @@unique do banco diferencia maiúsculas ("7-Zip" ≠ "7-zip"); para quem usa,
   * é o mesmo software. Por isso a checagem aqui ignora maiúsculas.
   */
  private async assertUnique(name: string, version: string, exceptId?: string): Promise<void> {
    const existing = await this.prisma.software.findFirst({
      where: {
        name: { equals: name, mode: 'insensitive' },
        version: { equals: version, mode: 'insensitive' },
        ...(exceptId ? { NOT: { id: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (existing) throw duplicateError(name, version);
  }
}

function toView(s: SoftwareWithRelations): SoftwareView {
  return {
    id: s.id,
    name: s.name,
    version: s.version,
    vendor: s.vendor,
    installType: s.installType,
    installArgs: s.installArgs,
    active: s.active,
    installer: s.installerFileName
      ? {
          originalName: s.installerOriginalName,
          sizeBytes: s.installerSizeBytes,
          sha256: s.installerSha256,
          uploadedAt: s.installerUploadedAt?.toISOString() ?? null,
        }
      : null,
    deploymentCount: s._count.deployments,
    msiProductCode: s.msiProductCode,
    uninstallAvailable: s.installType === InstallType.MSI && s.msiProductCode !== null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    createdBy: s.createdBy,
    updatedBy: s.updatedBy,
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function duplicateError(name: string, version: string): ConflictException {
  return new ConflictException(`Já existe um software "${name}" na versão "${version}".`);
}

export const DISK_FULL_MESSAGE = 'Sem espaço em disco no servidor para guardar o instalador.';

/** Disco cheio (ENOSPC) ou cota de disco esgotada (EDQUOT, comum em volume de nuvem/Linux). */
function isDiskFull(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOSPC' || code === 'EDQUOT';
}

/** Erros do armazenamento → resposta HTTP. Outros (ex.: conexão caída) seguem como estão. */
function toHttpUploadError(err: unknown): unknown {
  if (err instanceof InstallerTooLargeError) return new PayloadTooLargeException(err.message);
  // 507 Insufficient Storage: sem isto, chegava ao navegador como 500 "Internal server error".
  if (isDiskFull(err)) {
    const status = HttpStatus.INSUFFICIENT_STORAGE;
    return new HttpException({ statusCode: status, message: DISK_FULL_MESSAGE }, status);
  }
  if (err instanceof InvalidInstallerHeaderError) return new BadRequestException(err.message);
  if (err instanceof InstallerStorageUnavailableError) return new ServiceUnavailableException(err.message);
  return err;
}

function cannotDeleteDeployed(): ConflictException {
  return new ConflictException(
    'Este software já foi implantado e não pode ser apagado, para preservar o histórico. ' +
      'Desative-o em vez de apagar.',
  );
}

/**
 * Exclusão recusada por chave estrangeira. Com onDelete: Restrict, o Postgres
 * responde 23001 (restrict_violation), que o Prisma 5.22 NÃO mapeia para P2003 —
 * chega como PrismaClientUnknownRequestError, só identificável pela mensagem
 * (verificado contra o banco real; ver DECISIONS.md). O P2003 (23503, NO ACTION)
 * fica tratado também, caso a relação mude.
 */
export function isForeignKeyRestriction(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) return err.code === 'P2003';
  if (err instanceof Prisma.PrismaClientUnknownRequestError) {
    return err.message.includes('code: "23001"') || err.message.includes('violates RESTRICT setting');
  }
  return false;
}

// Duas requisições simultâneas podem passar pela checagem e colidir no @@unique.
function translateUniqueViolation(err: unknown, name: string, version: string): unknown {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    return duplicateError(name, version);
  }
  return err;
}
