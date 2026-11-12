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

/**
 * A máquina apareceu na sincronização mais recente? Toda sincronização grava o mesmo
 * lastSync em todas as máquinas que encontrou, então "vista" = lastSync igual ao
 * maior lastSync do banco. Usado também pela implantação (Bloco 4), que só aceita
 * máquinas presentes no AD.
 */
export function isSeenInLastSync(lastSync: Date | null, lastSyncAt: Date | null): boolean {
  return lastSyncAt !== null && lastSync !== null && lastSync.getTime() === lastSyncAt.getTime();
}

@Injectable()
export class MachinesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Lê só do banco — o frontend nunca dispara busca no LDAP por aqui. */
  async list(search?: unknown): Promise<MachineListResponse> {
    // A query não é validada em tempo de execução, e o Express 5 entrega um
    // parâmetro repetido (?search=a&search=b) como array. Sem checar o tipo,
    // .trim() lança TypeError e a listagem responde 500 em vez de ignorar o
    // parâmetro. Mesmo motivo da correção feita em AuthService.login.
    const term = typeof search === 'string' ? search.trim() : undefined;
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
        seenInLastSync: isSeenInLastSync(m.lastSync, lastSyncAt),
      })),
    };
  }
}
