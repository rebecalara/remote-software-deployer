import { DeploymentStatus, InstallType, LogLevel } from '@prisma/client';

// Prisma em memória, só com as operações que o DeploymentRunner usa — para os testes
// exercitarem as transições de status com as mesmas condições de WHERE do código
// real (ex.: "só marca RUNNING se ainda está PENDING"). Não é um Prisma genérico.

export interface TargetRow {
  id: string;
  deploymentId: string;
  machineId: string;
  status: DeploymentStatus;
  startedAt: Date | null;
  finishedAt: Date | null;
  exitCode: number | null;
}

export interface DeploymentRow {
  id: string;
  softwareId: string;
  status: DeploymentStatus;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface LogRow {
  deploymentTargetId: string;
  timestamp: Date;
  level: LogLevel;
  message: string;
}

export interface SoftwareRow {
  id: string;
  name: string;
  version: string;
  installType: InstallType;
  installArgs: string[];
  installerFileName: string | null;
  installerSizeBytes: number | null;
  installerSha256: string | null;
}

type Where = Record<string, unknown>;

function matches(row: Record<string, unknown>, where: Where): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (expected !== null && typeof expected === 'object' && 'in' in (expected as object)) {
      return ((expected as { in: unknown[] }).in).includes(row[key]);
    }
    return row[key] === expected;
  });
}

export function createInMemoryPrisma() {
  const targets = new Map<string, TargetRow>();
  const deployments = new Map<string, DeploymentRow>();
  const machines = new Map<string, { id: string; hostname: string }>();
  const software = new Map<string, SoftwareRow>();
  const logs: LogRow[] = [];

  const prisma = {
    deploymentTarget: {
      findUniqueOrThrow: jest.fn(async ({ where }: { where: { id: string } }) => {
        const t = targets.get(where.id);
        if (!t) throw new Error('No DeploymentTarget found');
        const d = deployments.get(t.deploymentId)!;
        return { ...t, machine: machines.get(t.machineId)!, deployment: { ...d, software: software.get(d.softwareId)! } };
      }),
      findMany: jest.fn(async ({ where }: { where: Where }) =>
        [...targets.values()].filter((t) => matches(t as never, where)).map((t) => ({ ...t })),
      ),
      updateMany: jest.fn(async ({ where, data }: { where: Where; data: Partial<TargetRow> }) => {
        const hit = [...targets.values()].filter((t) => matches(t as never, where));
        hit.forEach((t) => Object.assign(t, data));
        return { count: hit.length };
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<TargetRow> }) => {
        const t = targets.get(where.id);
        if (!t) throw new Error('No DeploymentTarget found');
        return Object.assign(t, data);
      }),
    },
    deployment: {
      updateMany: jest.fn(async ({ where, data }: { where: Where; data: Partial<DeploymentRow> }) => {
        const hit = [...deployments.values()].filter((d) => matches(d as never, where));
        hit.forEach((d) => Object.assign(d, data));
        return { count: hit.length };
      }),
    },
    deploymentLog: {
      create: jest.fn(async ({ data }: { data: LogRow }) => {
        logs.push({ ...data });
        return data;
      }),
      createMany: jest.fn(async ({ data }: { data: LogRow[] }) => {
        logs.push(...data.map((l) => ({ ...l })));
        return { count: data.length };
      }),
    },
    $transaction: jest.fn(async (operations: Promise<unknown>[]) => Promise.all(operations)),
  };

  return { prisma, targets, deployments, machines, software, logs };
}
