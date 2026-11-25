import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DeploymentAction, DeploymentStatus, InstallType, LogLevel, Prisma, Software } from '@prisma/client';
import { isSeenInLastSync } from '../machines/machines.service';
import { PrismaService } from '../prisma/prisma.service';
import { InstallerStorageService } from '../software/installer-storage.service';
import { SoftwareService } from '../software/software.service';
import {
  CsvValue,
  DEPLOYMENT_STATUS_LABEL,
  EXPORT_MAX_ROWS,
  EXPORT_TOO_MANY,
  exportFileName,
  formatDateTimeSaoPaulo,
  formatDurationText,
  targetResultLabel,
  toCsv,
} from './deployment-export';
import { DeploymentDisplayStatus, PARTIAL, displayStatus } from './deployment-outcome';
import { DeploymentRunner } from './deployment-runner';
import { DeploymentCreateInput, DeploymentListQuery, OUTSIDE_CATALOG } from './deployment-validation';
import { InventoryItem, PowerShellExecutor } from './powershell-executor';
import { VENDOR_UNINSTALL_DISABLED, checkUninstallCommand, programId as computeProgramId, vendorUninstallEnabled } from './vendor-uninstall';

export const SUMMARY_WINDOW_HOURS = 24;

/** Por que um EXE não tem desinstalação (409; a tela mostra o mesmo texto). */
export const EXE_UNINSTALL_UNAVAILABLE =
  'A desinstalação remota está disponível só para MSI: um EXE não traz um código de produto confiável, ' +
  'e cada família de instalador desinstala de um jeito.';
export const MISSING_PRODUCT_CODE =
  'Não foi possível obter o ProductCode deste MSI, necessário para desinstalar. Envie o instalador de novo ' +
  'ou confira o log do servidor.';

/** GET /deployments/summary — contadores do painel de Monitoramento. */
export interface DeploymentOverview {
  /** Implantações ainda não encerradas. */
  activeDeployments: number;
  /** Máquinas instalando agora e máquinas na fila (de todas as implantações). */
  runningTargets: number;
  pendingTargets: number;
  windowHours: number;
  /** Implantações encerradas na janela, por status final. */
  /** failed = nenhuma máquina concluiu; partial = alguma concluiu e alguma falhou. */
  finishedInWindow: { succeeded: number; partial: number; failed: number; cancelled: number };
}

export interface DeploymentLogView {
  timestamp: string;
  level: LogLevel;
  message: string;
}

export interface DeploymentTargetView {
  id: string;
  machineId: string;
  hostname: string;
  status: DeploymentStatus;
  startedAt: string | null;
  finishedAt: string | null;
  /** null = não executou, ou falhou antes de executar. */
  exitCode: number | null;
  /** Último passo registrado (fase atual, enquanto executa). */
  lastLog: DeploymentLogView | null;
}

export interface DeploymentCounts {
  total: number;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

/** Cópia do produto gravada na desinstalação (do catálogo ou do inventário). */
interface ProductSnapshot {
  /** null = programa que não é MSI (comando do fabricante). */
  code: string | null;
  name: string;
  version: string | null;
  publisher: string | null;
  /** Só comando do fabricante: como estava no inventário guardado. */
  vendor?: { key: string; arch: '64' | '32'; command: string };
}

interface DeploymentBase {
  id: string;
  name: string;
  /** Instalação ou desinstalação. */
  action: DeploymentAction;
  /** Calculado: PARTIAL = FAILED com alguma máquina concluída (ver `displayStatus`). */
  status: DeploymentDisplayStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** null = desinstalação de um MSI fora do catálogo (ver `product`). */
  software: { id: string; name: string; version: string; installType: InstallType } | null;
  /** Desinstalação: o produto removido (cópia do momento da criação). null na instalação. */
  product: { productCode: string | null; name: string; version: string | null; publisher: string | null } | null;
  /** Desinstalação por comando do fabricante: o comando exato executado (auditoria). */
  vendorCommand: string | null;
  requestedBy: { username: string; displayName: string | null };
  counts: DeploymentCounts;
}

/** Item da lista: sem as máquinas, só a contagem por status. */
export type DeploymentSummaryView = DeploymentBase;

/** GET /deployments — uma página da lista, com o total para a paginação. */
export interface DeploymentPage {
  items: DeploymentSummaryView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DeploymentView extends DeploymentBase {
  targets: DeploymentTargetView[];
}

const summaryInclude = {
  software: { select: { id: true, name: true, version: true, installType: true } },
  user: { select: { username: true, displayName: true } },
} satisfies Prisma.DeploymentInclude;

export const deploymentInclude = {
  ...summaryInclude,
  targets: {
    include: {
      machine: { select: { hostname: true } },
      logs: { orderBy: { timestamp: 'desc' }, take: 1 },
    },
  },
} satisfies Prisma.DeploymentInclude;

type DeploymentWithRelations = Prisma.DeploymentGetPayload<{ include: typeof deploymentInclude }>;
type DeploymentSummaryRow = Prisma.DeploymentGetPayload<{
  include: typeof summaryInclude & { targets: { select: { status: true } } };
}>;

@Injectable()
export class DeploymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly executor: PowerShellExecutor,
    private readonly storage: InstallerStorageService,
    private readonly runner: DeploymentRunner,
    private readonly softwareService?: SoftwareService,
  ) {}

  /**
   * Confere tudo o que dá para conferir antes de executar, cria a implantação e os
   * alvos como PENDING e devolve na hora. A execução segue em segundo plano.
   */
  async create(input: DeploymentCreateInput, userId: string): Promise<DeploymentView> {
    if (!this.executor.isAvailable) {
      throw new ServiceUnavailableException(
        `A implantação remota está indisponível neste servidor: ${this.executor.unavailableReason}`,
      );
    }

    const uninstall = input.action === DeploymentAction.UNINSTALL;
    // Primeiro as máquinas: a desinstalação por ProductCode depende do inventário delas.
    const machines = await this.checkMachines(input.machineIds);

    let software: Software | null = null;
    let product: ProductSnapshot | null = null;
    if (input.programId) {
      // Programa que não é MSI: comando do fabricante (exceção controlada, desligada por
      // padrão). Comando, subchave e nome vêm do inventário guardado, no servidor.
      if (!vendorUninstallEnabled()) throw new ConflictException(VENDOR_UNINSTALL_DISABLED);
      product = await this.programFromInventory(input.programId, input.machineIds);
    } else if (input.productCode) {
      // Desinstalação pelo inventário (pode estar fora do catálogo). O ProductCode precisa
      // aparecer na última consulta guardada de pelo menos uma das máquinas; nome, versão
      // e fabricante vêm desse inventário, no servidor (decisão da autora).
      product = await this.productFromInventory(input.productCode, input.machineIds);
      // Se o mesmo pacote estiver no catálogo, a implantação fica ligada a ele (ativo
      // primeiro, depois o mais antigo — a mesma regra da marcação do inventário).
      software = await this.prisma.software.findFirst({
        where: { installType: InstallType.MSI, msiProductCode: input.productCode },
        orderBy: [{ active: 'desc' }, { createdAt: 'asc' }],
      });
    } else {
      software = await this.prisma.software.findUnique({ where: { id: input.softwareId! } });
      if (!software) throw new NotFoundException('Software não encontrado.');
    }

    if (uninstall && !input.productCode && !input.programId) {
      // Desinstalação de um software do catálogo: só MSI e só o ProductCode — o
      // instalador não é copiado, então não precisa estar na pasta. Software desativado
      // PODE ser desinstalado (decisão da autora).
      if (software!.installType !== InstallType.MSI) throw new ConflictException(EXE_UNINSTALL_UNAVAILABLE);
      const code = software!.msiProductCode ?? (await this.softwareService?.ensureMsiProductCode(software!.id)) ?? null;
      if (!code) throw new ConflictException(MISSING_PRODUCT_CODE);
      product = { code, name: software!.name, version: software!.version, publisher: software!.vendor };
    } else if (!uninstall) {
      if (!software!.active) {
        throw new ConflictException('Este software está desativado e não pode ser implantado.');
      }
      if (!software!.installerFileName) {
        throw new ConflictException('Este software ainda não tem instalador enviado.');
      }
      if (!this.storage.isAvailable) {
        throw new ServiceUnavailableException('Armazenamento de instaladores não configurado no servidor.');
      }
      if (!(await this.storage.exists(software!.installerFileName))) {
        throw new ConflictException(
          'O arquivo do instalador deste software não foi encontrado na pasta de instaladores do servidor.',
        );
      }
    }
    void machines;

    const count = input.machineIds.length;
    const label = product ? `${product.name}${product.version ? ` ${product.version}` : ''}` : `${software!.name} ${software!.version}`;
    const name =
      input.name ?? `${uninstall ? 'Desinstalar ' : ''}${label} — ${count} ${count === 1 ? 'máquina' : 'máquinas'}`;

    // "A mesma implantação": mesma ação e o mesmo alvo — o software do catálogo (instalação),
    // o ProductCode (desinstalação de MSI, pelo catálogo ou pelo inventário) ou a chave do
    // programa no registro (desinstalação pelo comando do fabricante).
    const sameDeployment: Prisma.DeploymentWhereInput = !uninstall
      ? { action: input.action, softwareId: software!.id }
      : product?.vendor
        ? { action: input.action, uninstallKey: product.vendor.key, uninstallArch: product.vendor.arch }
        : { action: input.action, productCode: product!.code };

    // Checagem e criação juntas, sob uma trava do Postgres que só é solta no fim da transação:
    // dois pedidos iguais ao mesmo tempo (clique duplo, duas abas) não passam os dois — o
    // segundo espera o primeiro gravar e então o enxerga. Vale também com mais de uma
    // instância do backend (a trava é do banco, não do processo). Sem mudança de schema.
    const created = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('rsd:deployments:create'))`;
        const busy = await tx.deploymentTarget.findMany({
          where: {
            machineId: { in: input.machineIds },
            status: { in: [DeploymentStatus.PENDING, DeploymentStatus.RUNNING] },
            deployment: sameDeployment,
          },
          select: { machine: { select: { hostname: true } } },
        });
        if (busy.length > 0) {
          const hosts = [...new Set(busy.map((t) => t.machine.hostname))].sort((a, b) => a.localeCompare(b));
          throw new ConflictException(`Já existe uma implantação igual em andamento em: ${hosts.join(', ')}.`);
        }
        return this.createRecord(tx, input, userId, name, software, product);
      },
      // A espera pela trava conta no tempo da transação; criar é rápido, mas dá folga.
      { maxWait: 10_000, timeout: 20_000 },
    );

    // Na ordem da seleção: o Prisma não garante a ordem dos alvos criados.
    const targetByMachine = new Map(created.targets.map((t) => [t.machineId, t.id]));
    this.runner.enqueue(input.machineIds.map((machineId) => ({ targetId: targetByMachine.get(machineId)!, machineId })));
    return toDeploymentView(created);
  }

  private createRecord(
    tx: Prisma.TransactionClient,
    input: DeploymentCreateInput,
    userId: string,
    name: string,
    software: Software | null,
    product: ProductSnapshot | null,
  ) {
    return tx.deployment.create({
      data: {
        name,
        action: input.action,
        user: { connect: { id: userId } },
        ...(software ? { software: { connect: { id: software.id } } } : {}),
        ...(product
          ? { productCode: product.code, productName: product.name, productVersion: product.version, productPublisher: product.publisher }
          : {}),
        ...(product?.vendor
          ? { uninstallKey: product.vendor.key, uninstallArch: product.vendor.arch, uninstallCommand: product.vendor.command }
          : {}),
        targets: { create: input.machineIds.map((machineId) => ({ machine: { connect: { id: machineId } } })) },
      },
      include: deploymentInclude,
    });
  }

  /**
   * Programa (não MSI) com este id na consulta MAIS RECENTE entre as máquinas selecionadas
   * que o têm; o comando é validado de novo. 409 se não aparecer em nenhuma.
   */
  private async programFromInventory(programId: string, machineIds: string[]): Promise<ProductSnapshot> {
    const inventories = await this.prisma.machineInventory.findMany({
      where: { machineId: { in: machineIds } },
      orderBy: { collectedAt: 'desc' },
      select: { items: true },
    });
    for (const inv of inventories) {
      const items = (Array.isArray(inv.items) ? inv.items : []) as unknown as InventoryItem[];
      for (const item of items) {
        if (item.productCode || !item.uninstallKey || !item.quietUninstallString) continue;
        if (computeProgramId(item.arch, item.uninstallKey, item.quietUninstallString) !== programId) continue;
        const check = checkUninstallCommand(item.quietUninstallString);
        if ('reason' in check) throw new ConflictException(`O comando de desinstalação deste programa foi recusado: ${check.reason}`);
        return {
          code: null,
          name: item.name,
          version: item.version,
          publisher: item.publisher,
          vendor: { key: item.uninstallKey, arch: item.arch, command: item.quietUninstallString },
        };
      }
    }
    throw new ConflictException(
      'Este programa não aparece no software instalado guardado de nenhuma das máquinas selecionadas. ' +
        'Consulte o software instalado delas e tente de novo.',
    );
  }

  /** Máquinas existentes e presentes na última sincronização com o AD (400/409). */
  private async checkMachines(machineIds: string[]) {
    const [machines, aggregate] = await Promise.all([
      this.prisma.machine.findMany({ where: { id: { in: machineIds } } }),
      this.prisma.machine.aggregate({ _max: { lastSync: true } }),
    ]);
    if (machines.length !== machineIds.length) {
      const missing = machineIds.length - machines.length;
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: `${missing} máquina(s) selecionada(s) não existe(m) mais. Atualize a lista e selecione de novo.`,
        field: 'machineIds',
      });
    }
    const lastSyncAt = aggregate._max.lastSync;
    const notInAd = machines.filter((m) => !isSeenInLastSync(m.lastSync, lastSyncAt)).map((m) => m.hostname);
    if (notInAd.length > 0) {
      throw new ConflictException(
        `Máquina(s) não encontrada(s) no AD na última sincronização: ${notInAd.sort().join(', ')}.`,
      );
    }
    return machines;
  }

  /**
   * O produto (MSI) com este ProductCode, como aparece na consulta MAIS RECENTE entre as
   * máquinas selecionadas que o têm. 409 se não aparecer em nenhuma.
   */
  private async productFromInventory(productCode: string, machineIds: string[]): Promise<ProductSnapshot> {
    const inventories = await this.prisma.machineInventory.findMany({
      where: { machineId: { in: machineIds } },
      orderBy: { collectedAt: 'desc' },
      select: { items: true },
    });
    for (const inv of inventories) {
      const items = (Array.isArray(inv.items) ? inv.items : []) as Array<Record<string, unknown>>;
      const hit = items.find((i) => i.productCode === productCode);
      if (hit && typeof hit.name === 'string') {
        const text = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : null);
        return { code: productCode, name: hit.name, version: text(hit.version), publisher: text(hit.publisher) };
      }
    }
    throw new ConflictException(
      'Este ProductCode não aparece no software instalado guardado de nenhuma das máquinas selecionadas. ' +
        'Consulte o software instalado delas e tente de novo.',
    );
  }

  /**
   * Mais recentes primeiro, com filtros (Histórico, Bloco 6): período de criação,
   * status, software, parte do nome de uma das máquinas e "minhas" (criadas por
   * `requesterId`, que vem do token). O total vem na mesma transação de leitura da página.
   */
  async list(query: DeploymentListQuery, requesterId: string): Promise<DeploymentPage> {
    const where = deploymentListWhere(query, requesterId);
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.deployment.count({ where }),
      this.prisma.deployment.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { ...summaryInclude, targets: { select: { status: true } } },
      }),
    ]);
    return { items: rows.map(toSummaryView), total, page: query.page, pageSize: query.pageSize };
  }

  /**
   * Histórico em CSV (Excel em português): as implantações que a listagem mostraria com os
   * mesmos filtros (mesmo `deploymentListWhere`, inclusive "Minhas" pelo usuário do token),
   * TODAS as páginas, uma linha por máquina, sem logs. Mais de EXPORT_MAX_ROWS linhas = 400:
   * a contagem vem antes, para não ler as implantações à toa.
   */
  async exportCsv(query: DeploymentListQuery, requesterId: string, now: Date = new Date()): Promise<{ fileName: string; csv: string }> {
    const where = deploymentListWhere(query, requesterId);
    const rows = await this.prisma.deploymentTarget.count({ where: { deployment: where } });
    if (rows > EXPORT_MAX_ROWS) {
      throw new BadRequestException({ statusCode: 400, error: 'Bad Request', message: EXPORT_TOO_MANY });
    }
    const deployments = await this.prisma.deployment.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        software: { select: { name: true, version: true } },
        user: { select: { username: true, displayName: true } },
        targets: {
          include: {
            machine: { select: { hostname: true } },
            // Só o último passo, para o "Resultado na máquina" ("Já estava instalado"…).
            logs: { orderBy: { timestamp: 'desc' }, take: 1, select: { message: true } },
          },
        },
      },
    });

    const lines: CsvValue[][] = [];
    for (const d of deployments) {
      const counts = countStatuses(d.targets.map((t) => t.status));
      const status = DEPLOYMENT_STATUS_LABEL[displayStatus(d.status, counts)];
      const software = d.software?.name ?? d.productName ?? d.productCode ?? '—';
      const version = d.software ? d.software.version : (d.productVersion ?? '');
      const targets = [...d.targets].sort((a, b) => a.machine.hostname.localeCompare(b.machine.hostname));
      for (const t of targets) {
        lines.push([
          software,
          version,
          d.action === DeploymentAction.UNINSTALL ? 'Desinstalação' : 'Instalação',
          d.software ? 'Não' : 'Sim',
          status,
          t.machine.hostname,
          targetResultLabel({ status: t.status, exitCode: t.exitCode, lastMessage: t.logs[0]?.message ?? null }),
          t.exitCode,
          d.user.displayName || d.user.username,
          formatDateTimeSaoPaulo(d.createdAt),
          formatDateTimeSaoPaulo(t.startedAt),
          formatDateTimeSaoPaulo(t.finishedAt),
          formatDurationText(t.startedAt, t.finishedAt),
        ]);
      }
    }
    return { fileName: exportFileName(now), csv: toCsv(lines) };
  }

  /**
   * Contadores do painel de Monitoramento (Bloco 5), sobre TODAS as implantações — não
   * só as que aparecem na lista. "Agora": implantações não encerradas e máquinas em
   * execução ou na fila. Encerradas: nas últimas 24 h, para o painel refletir o dia de
   * trabalho em vez de crescer para sempre (o total histórico fica no Histórico).
   */
  async summary(now: Date = new Date()): Promise<DeploymentOverview> {
    const since = new Date(now.getTime() - SUMMARY_WINDOW_HOURS * 3600 * 1000);
    const [active, targetGroups, finishedGroups, partial] = await Promise.all([
      this.prisma.deployment.count({ where: { finishedAt: null } }),
      this.prisma.deploymentTarget.groupBy({
        by: ['status'],
        where: { status: { in: [DeploymentStatus.PENDING, DeploymentStatus.RUNNING] } },
        _count: { _all: true },
      }),
      this.prisma.deployment.groupBy({
        by: ['status'],
        where: { finishedAt: { gte: since } },
        _count: { _all: true },
      }),
      this.prisma.deployment.count({
        where: { finishedAt: { gte: since }, status: DeploymentStatus.FAILED, targets: PARTIAL_TARGETS },
      }),
    ]);
    const targets = (s: DeploymentStatus) => targetGroups.find((g) => g.status === s)?._count._all ?? 0;
    const finished = (s: DeploymentStatus) => finishedGroups.find((g) => g.status === s)?._count._all ?? 0;
    return {
      activeDeployments: active,
      runningTargets: targets(DeploymentStatus.RUNNING),
      pendingTargets: targets(DeploymentStatus.PENDING),
      windowHours: SUMMARY_WINDOW_HOURS,
      finishedInWindow: {
        succeeded: finished(DeploymentStatus.SUCCEEDED),
        partial,
        failed: finished(DeploymentStatus.FAILED) - partial,
        cancelled: finished(DeploymentStatus.CANCELLED),
      },
    };
  }

  async get(id: string): Promise<DeploymentView> {
    const deployment = await this.prisma.deployment.findUnique({ where: { id }, include: deploymentInclude });
    if (!deployment) throw new NotFoundException('Implantação não encontrada.');
    return toDeploymentView(deployment);
  }

  /** Todos os passos de uma máquina, em ordem (inclusive DEBUG; a tela decide o que mostrar). */
  async logs(deploymentId: string, targetId: string): Promise<DeploymentLogView[]> {
    const target = await this.prisma.deploymentTarget.findFirst({
      where: { id: targetId, deploymentId },
      select: { id: true },
    });
    if (!target) throw new NotFoundException('Máquina não encontrada nesta implantação.');
    const logs = await this.prisma.deploymentLog.findMany({
      where: { deploymentTargetId: targetId },
      orderBy: { timestamp: 'asc' },
    });
    return logs.map(toLogView);
  }

  /**
   * Cancela só as máquinas que ainda estão PENDING (decisão aprovada): interromper
   * uma instalação em curso pode deixar a máquina quebrada. As que estão em execução
   * terminam normalmente. Cada cancelada ganha um log com quem cancelou.
   *
   * Uma máquina por vez, com a condição PENDING no próprio UPDATE: se a fila pegar
   * uma delas no meio do cancelamento, ela segue executando e não ganha log de
   * cancelada (o Prisma 5.22 não devolve as linhas afetadas por um updateMany).
   */
  async cancel(id: string, username: string): Promise<DeploymentView> {
    const deployment = await this.prisma.deployment.findUnique({
      where: { id },
      include: { targets: { select: { id: true, status: true } } },
    });
    if (!deployment) throw new NotFoundException('Implantação não encontrada.');
    if (deployment.finishedAt) throw new ConflictException('Esta implantação já terminou.');

    const now = new Date();
    const cancelled: string[] = [];
    for (const target of deployment.targets.filter((t) => t.status === DeploymentStatus.PENDING)) {
      const { count } = await this.prisma.deploymentTarget.updateMany({
        where: { id: target.id, status: DeploymentStatus.PENDING },
        data: { status: DeploymentStatus.CANCELLED, finishedAt: now },
      });
      if (count === 1) cancelled.push(target.id);
    }
    if (cancelled.length === 0) {
      throw new ConflictException(
        'Não há máquinas pendentes para cancelar. As que estão em execução não podem ser interrompidas.',
      );
    }

    await this.prisma.deploymentLog.createMany({
      data: cancelled.map((deploymentTargetId) => ({
        deploymentTargetId,
        timestamp: now,
        level: LogLevel.WARN,
        message: `Cancelada por ${username} antes de executar.`,
      })),
    });
    await this.runner.finalizeDeployment(id);
    return this.get(id);
  }
}

/** Máquinas de uma implantação "Parcial": pelo menos uma concluída (com status FAILED). */
const PARTIAL_TARGETS = { some: { status: DeploymentStatus.SUCCEEDED } } satisfies Prisma.DeploymentTargetListRelationFilter;

function countStatuses(statuses: DeploymentStatus[]): DeploymentCounts {
  const count = (s: DeploymentStatus) => statuses.filter((x) => x === s).length;
  return {
    total: statuses.length,
    pending: count(DeploymentStatus.PENDING),
    running: count(DeploymentStatus.RUNNING),
    succeeded: count(DeploymentStatus.SUCCEEDED),
    failed: count(DeploymentStatus.FAILED),
    cancelled: count(DeploymentStatus.CANCELLED),
  };
}

function toLogView(l: { timestamp: Date; level: LogLevel; message: string }): DeploymentLogView {
  return { timestamp: l.timestamp.toISOString(), level: l.level, message: l.message };
}

function toBase(d: DeploymentSummaryRow | DeploymentWithRelations): DeploymentBase {
  const counts = countStatuses(d.targets.map((t) => t.status));
  return {
    id: d.id,
    name: d.name,
    action: d.action,
    status: displayStatus(d.status, counts),
    createdAt: d.createdAt.toISOString(),
    startedAt: d.startedAt?.toISOString() ?? null,
    finishedAt: d.finishedAt?.toISOString() ?? null,
    software: d.software ?? null,
    product:
      d.productCode || d.uninstallCommand
        ? { productCode: d.productCode, name: d.productName ?? d.productCode ?? '—', version: d.productVersion, publisher: d.productPublisher }
        : null,
    vendorCommand: d.uninstallCommand ?? null,
    requestedBy: d.user,
    counts,
  };
}

export function toSummaryView(d: DeploymentSummaryRow): DeploymentSummaryView {
  return toBase(d);
}

export function toDeploymentView(d: DeploymentWithRelations): DeploymentView {
  return {
    ...toBase(d),
    targets: [...d.targets]
      .sort((a, b) => a.machine.hostname.localeCompare(b.machine.hostname))
      .map((t) => ({
        id: t.id,
        machineId: t.machineId,
        hostname: t.machine.hostname,
        status: t.status,
        startedAt: t.startedAt?.toISOString() ?? null,
        finishedAt: t.finishedAt?.toISOString() ?? null,
        exitCode: t.exitCode,
        lastLog: t.logs.length > 0 ? toLogView(t.logs[0]) : null,
      })),
  };
}

/** Filtros da lista → WHERE do Prisma (exportado para teste). */
export function deploymentListWhere(query: DeploymentListQuery, requesterId: string): Prisma.DeploymentWhereInput {
  const where: Prisma.DeploymentWhereInput = {};
  if (query.mine) where.userId = requesterId;
  if (query.state === 'active') where.finishedAt = null;
  if (query.state === 'finished' || query.finishedFrom) {
    where.finishedAt = { not: null, ...(query.finishedFrom ? { gte: query.finishedFrom } : {}) };
  }
  if (query.action) where.action = query.action;
  // "Falhou" e "Parcial" são o mesmo FAILED no banco, separados pelas máquinas: com alguma
  // concluída é Parcial. Em AND, para não apagar o filtro por nome de máquina (targets).
  if (query.status === PARTIAL) {
    where.status = DeploymentStatus.FAILED;
    where.AND = [{ targets: PARTIAL_TARGETS }];
  } else if (query.status === DeploymentStatus.FAILED) {
    // "Nenhuma concluída": o Prisma gera NOT IN (subconsulta), que o Postgres não transforma
    // em anti-join — com a subconsulta sobre TODOS os alvos concluídos, ele passa a conferir
    // linha a linha (medido: > 20 s com 100 mil implantações). Restrita aos alvos de
    // implantações FAILED (o mesmo resultado), a subconsulta fica pequena.
    where.status = DeploymentStatus.FAILED;
    where.AND = [
      { targets: { none: { status: DeploymentStatus.SUCCEEDED, deployment: { is: { status: DeploymentStatus.FAILED } } } } },
    ];
  } else if (query.status) {
    where.status = query.status;
  }
  if (query.softwareId) where.softwareId = query.softwareId === OUTSIDE_CATALOG ? null : query.softwareId;
  if (query.from || query.to) {
    where.createdAt = { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lt: query.to } : {}) };
  }
  if (query.machine) {
    where.targets = { some: { machine: { hostname: { contains: query.machine, mode: 'insensitive' } } } };
  }
  return where;
}
