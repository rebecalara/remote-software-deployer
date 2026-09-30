import { ConflictException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { MachineStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { LdapAuthenticationError, LdapConnectionError, LdapService } from '../ldap/ldap.service';
import { MappedComputer, mapComputerEntry } from './computer-mapper';

export interface SyncResult {
  total: number;
  created: number;
  updated: number;
  notSeen: number;
  syncedAt: string;
}

const UPSERT_BATCH_SIZE = 200;

@Injectable()
export class MachineSyncService {
  private readonly logger = new Logger(MachineSyncService.name);
  private running = false;

  constructor(
    private readonly ldapService: LdapService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Busca os computadores no LDAP e faz upsert em Machine pelo hostname.
   * Nunca apaga máquina (histórico de implantações é RESTRICT) e nunca mexe no
   * status — o AD não sabe se a máquina está ligada. Máquina que sumiu do AD
   * fica com lastSync anterior a esta sincronização ("não vista").
   */
  async sync(): Promise<SyncResult> {
    if (this.running) {
      throw new ConflictException('Já existe uma sincronização em andamento.');
    }
    this.running = true;
    try {
      return await this.runSync();
    } finally {
      this.running = false;
    }
  }

  private async runSync(): Promise<SyncResult> {
    const syncedAt = new Date();
    const computers = await this.fetchComputers();

    const existing = await this.prisma.machine.findMany({ select: { hostname: true } });
    const existingHostnames = new Set(existing.map((m) => m.hostname));

    for (let i = 0; i < computers.length; i += UPSERT_BATCH_SIZE) {
      const batch = computers.slice(i, i + UPSERT_BATCH_SIZE);
      await this.prisma.$transaction(
        batch.map((computer) =>
          this.prisma.machine.upsert({
            where: { hostname: computer.hostname },
            create: { ...computer, status: MachineStatus.UNKNOWN, lastSync: syncedAt },
            update: {
              operatingSystem: computer.operatingSystem,
              department: computer.department,
              lastSync: syncedAt,
            },
          }),
        ),
      );
    }

    const created = computers.filter((c) => !existingHostnames.has(c.hostname)).length;
    const notSeen = await this.prisma.machine.count({
      where: { OR: [{ lastSync: null }, { lastSync: { lt: syncedAt } }] },
    });

    const result: SyncResult = {
      total: computers.length,
      created,
      updated: computers.length - created,
      notSeen,
      syncedAt: syncedAt.toISOString(),
    };
    this.logger.log(
      `Sincronização concluída: ${result.total} no diretório, ${result.created} novas, ` +
        `${result.updated} atualizadas, ${result.notSeen} não vistas.`,
    );
    return result;
  }

  private async fetchComputers(): Promise<MappedComputer[]> {
    let entries;
    try {
      entries = await this.ldapService.searchComputers();
    } catch (err) {
      if (err instanceof LdapAuthenticationError) {
        this.logger.error(`Conta de serviço LDAP recusada: ${err.message}`);
      } else if (err instanceof LdapConnectionError) {
        this.logger.error(`Falha ao buscar computadores no LDAP: ${err.message}`);
      } else {
        this.logger.error(`Erro inesperado ao buscar computadores: ${(err as Error).message}`);
      }
      // Detalhe fica no log do servidor; o cliente recebe mensagem genérica.
      throw new ServiceUnavailableException(
        'Não foi possível consultar o diretório (AD/LDAP). Tente novamente mais tarde.',
      );
    }

    const osAttribute = process.env.LDAP_COMPUTER_OS_ATTRIBUTE || 'operatingSystem';
    const byHostname = new Map<string, MappedComputer>();
    for (const entry of entries) {
      const computer = mapComputerEntry(entry, { osAttribute });
      if (!computer) {
        this.logger.warn(`Entrada LDAP ignorada (sem hostname identificável): ${entry.dn}`);
        continue;
      }
      if (byHostname.has(computer.hostname)) {
        this.logger.warn(`Hostname duplicado no diretório, mantida a primeira: ${computer.hostname}`);
        continue;
      }
      byHostname.set(computer.hostname, computer);
    }
    return [...byHostname.values()];
  }
}
