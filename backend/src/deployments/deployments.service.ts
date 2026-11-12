import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DeploymentStatus, InstallType, Prisma } from '@prisma/client';
import { isSeenInLastSync } from '../machines/machines.service';
import { PrismaService } from '../prisma/prisma.service';
import { InstallerStorageService } from '../software/installer-storage.service';
import { DeploymentRunner } from './deployment-runner';
import { DeploymentCreateInput } from './deployment-validation';
import { PowerShellExecutor } from './powershell-executor';

export interface DeploymentTargetView {
  id: string;
  machineId: string;
  hostname: string;
  status: DeploymentStatus;
  startedAt: string | null;
  finishedAt: string | null;
  /** null = não executou, ou falhou antes de executar. */
  exitCode: number | null;
}

export interface DeploymentView {
  id: string;
  name: string;
  status: DeploymentStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  software: { id: string; name: string; version: string; installType: InstallType };
  requestedBy: { username: string; displayName: string | null };
  targets: DeploymentTargetView[];
}

export const deploymentInclude = {
  software: { select: { id: true, name: true, version: true, installType: true } },
  user: { select: { username: true, displayName: true } },
  targets: { include: { machine: { select: { hostname: true } } } },
} satisfies Prisma.DeploymentInclude;

type DeploymentWithRelations = Prisma.DeploymentGetPayload<{ include: typeof deploymentInclude }>;

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

    this.runner.enqueue(created.targets.map((t) => ({ targetId: t.id, machineId: t.machineId })));
    return toDeploymentView(created);
  }
}

export function toDeploymentView(d: DeploymentWithRelations): DeploymentView {
  return {
    id: d.id,
    name: d.name,
    status: d.status,
    createdAt: d.createdAt.toISOString(),
    startedAt: d.startedAt?.toISOString() ?? null,
    finishedAt: d.finishedAt?.toISOString() ?? null,
    software: d.software,
    requestedBy: d.user,
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
      })),
  };
}
