import { Injectable } from '@nestjs/common';
import { MachineStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface MachineView {
  id: string;
  hostname: string;
  ipAddress: string | null;
  operatingSystem: string | null;
  department: string | null;
  status: MachineStatus;
  lastSync: string | null;
  /** false = a máquina não apareceu na sincronização mais recente (saiu do AD). */
  seenInLastSync: boolean;
}

export interface MachineListResponse {
  machines: MachineView[];
  lastSyncAt: string | null;
}

@Injectable()
export class MachinesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Lê só do banco — o frontend nunca dispara busca no LDAP por aqui. */
  async list(search?: string): Promise<MachineListResponse> {
    const term = search?.trim();
    const where: Prisma.MachineWhereInput = term
      ? {
          OR: [
            { hostname: { contains: term, mode: 'insensitive' } },
            { department: { contains: term, mode: 'insensitive' } },
            { operatingSystem: { contains: term, mode: 'insensitive' } },
          ],
        }
      : {};

    // Toda sincronização grava o mesmo lastSync em todas as máquinas que encontrou,
    // então o maior lastSync do banco é o momento da última sincronização.
    const [machines, aggregate] = await Promise.all([
      this.prisma.machine.findMany({ where, orderBy: { hostname: 'asc' } }),
      this.prisma.machine.aggregate({ _max: { lastSync: true } }),
    ]);
    const lastSyncAt = aggregate._max.lastSync;

    return {
      lastSyncAt: lastSyncAt?.toISOString() ?? null,
      machines: machines.map((m) => ({
        id: m.id,
        hostname: m.hostname,
        ipAddress: m.ipAddress,
        operatingSystem: m.operatingSystem,
        department: m.department,
        status: m.status,
        lastSync: m.lastSync?.toISOString() ?? null,
        seenInLastSync:
          lastSyncAt !== null && m.lastSync !== null && m.lastSync.getTime() === lastSyncAt.getTime(),
      })),
    };
  }
}
