import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InstallType, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
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
  createdAt: string;
  updatedAt: string;
  createdBy: UserRef | null;
  updatedBy: UserRef | null;
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
export class SoftwareService {
  constructor(private readonly prisma: PrismaService) {}

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
    // O arquivo do instalador passa a ser apagado aqui na etapa do envio
    // (InstallerStorageService) — até lá nenhum software tem arquivo guardado.
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
