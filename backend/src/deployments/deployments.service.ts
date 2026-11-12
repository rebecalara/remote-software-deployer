import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DeploymentStatus, InstallType, LogLevel, Prisma } from '@prisma/client';
import { isSeenInLastSync } from '../machines/machines.service';
import { PrismaService } from '../prisma/prisma.service';
import { InstallerStorageService } from '../software/installer-storage.service';
import { DeploymentRunner } from './deployment-runner';
import { DeploymentCreateInput } from './deployment-validation';
import { PowerShellExecutor } from './powershell-executor';

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

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

interface DeploymentBase {
  id: string;
  name: string;
  status: DeploymentStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  software: { id: string; name: string; version: string; installType: InstallType };
  requestedBy: { username: string; displayName: string | null };
  counts: DeploymentCounts;
}

/** Item da lista: sem as máquinas, só a contagem por status. */
export type DeploymentSummaryView = DeploymentBase;

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

    const software = await this.prisma.software.findUnique({ where: { id: input.softwareId } });
    if (!software) throw new NotFoundException('Software não encontrado.');
    if (!software.active) {
      throw new ConflictException('Este software está desativado e não pode ser implantado.');
    }
    if (!software.installerFileName) {
      throw new ConflictException('Este software ainda não tem instalador enviado.');
    }
    if (!this.storage.isAvailable) {
      throw new ServiceUnavailableException('Armazenamento de instaladores não configurado no servidor.');
    }
    if (!(await this.storage.exists(software.installerFileName))) {
      throw new ConflictException(
        'O arquivo do instalador deste software não foi encontrado na pasta de instaladores do servidor.',
      );
    }

    const [machines, aggregate] = await Promise.all([
      this.prisma.machine.findMany({ where: { id: { in: input.machineIds } } }),
      this.prisma.machine.aggregate({ _max: { lastSync: true } }),
    ]);
    if (machines.length !== input.machineIds.length) {
      const missing = input.machineIds.length - machines.length;
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

    const count = input.machineIds.length;
    const name =
      input.name ?? `${software.name} ${software.version} — ${count} ${count === 1 ? 'máquina' : 'máquinas'}`;

    const created = await this.prisma.deployment.create({
      data: {
        name,
        user: { connect: { id: userId } },
        software: { connect: { id: software.id } },
        targets: { create: input.machineIds.map((machineId) => ({ machine: { connect: { id: machineId } } })) },
      },
      include: deploymentInclude,
    });

    // Na ordem da seleção: o Prisma não garante a ordem dos alvos criados.
    const targetByMachine = new Map(created.targets.map((t) => [t.machineId, t.id]));
    this.runner.enqueue(input.machineIds.map((machineId) => ({ targetId: targetByMachine.get(machineId)!, machineId })));
    return toDeploymentView(created);
  }

  /** Mais recentes primeiro. Filtros e paginação ficam para o Histórico (Bloco 6). */
  async list(limit: number = DEFAULT_LIST_LIMIT): Promise<DeploymentSummaryView[]> {
    const rows = await this.prisma.deployment.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { ...summaryInclude, targets: { select: { status: true } } },
    });
    return rows.map(toSummaryView);
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
  return {
    id: d.id,
    name: d.name,
    status: d.status,
    createdAt: d.createdAt.toISOString(),
    startedAt: d.startedAt?.toISOString() ?? null,
    finishedAt: d.finishedAt?.toISOString() ?? null,
    software: d.software,
    requestedBy: d.user,
    counts: countStatuses(d.targets.map((t) => t.status)),
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

/** ?limit= da lista: inteiro de 1 a 200; qualquer outra coisa usa o padrão. */
export function parseListLimit(raw: unknown): number {
  const value = typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isInteger(value) || value < 1) return DEFAULT_LIST_LIMIT;
  return Math.min(value, MAX_LIST_LIMIT);
}
