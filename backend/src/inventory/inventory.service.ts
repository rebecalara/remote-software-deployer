import {
  BadGatewayException,
  ConflictException,
  GatewayTimeoutException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InstallType, Prisma } from '@prisma/client';
import { DeploymentRunner, MachineChangedEvent } from '../deployments/deployment-runner';
import { InventoryFailureReason, InventoryItem, PowerShellExecutor } from '../deployments/powershell-executor';
import {
  VENDOR_UNINSTALL_DISABLED,
  checkUninstallCommand,
  programId as computeProgramId,
  vendorUninstallEnabled,
} from '../deployments/vendor-uninstall';
import { isSeenInLastSync } from '../machines/machines.service';
import { PrismaService } from '../prisma/prisma.service';

// RF08: inventário de software por máquina (DECISIONS.md). Consulta AO VIVO pelo WinRM,
// com o script fixo e só de leitura inventory-target.ps1, a mesma credencial e o mesmo
// executor da implantação. A última consulta bem-sucedida fica guardada (uma linha por
// máquina, sobrescrita); a marcação "no catálogo" é calculada a cada leitura.

/** Consultas ao mesmo tempo no servidor (decisão da autora). */
export const MAX_CONCURRENT_INVENTORIES = 5;
/** Inventário "antigo" para a desinstalação pelo inventário (decisão da autora). */
export const INVENTORY_STALE_DAYS = 7;

export interface CatalogMatch {
  softwareId: string;
  name: string;
  version: string;
  active: boolean;
  uninstallAvailable: boolean;
}

/** Se o item pode ser desinstalado e, se não, por quê. */
export interface UninstallInfo {
  available: boolean;
  /** 'MSI' (ProductCode) ou 'VENDOR' (comando do fabricante, exceção controlada). */
  method: 'MSI' | 'VENDOR' | null;
  reason: string | null;
  /** Só VENDOR: id calculado no servidor (visão + subchave + comando). */
  programId: string | null;
  /** Só VENDOR: o comando exato, para a revisão mostrar o que vai rodar. */
  command: string | null;
}

export const OUTDATED_INVENTORY =
  'Consulte de novo o software instalado para saber se este programa pode ser desinstalado.';
export const NO_QUIET_UNINSTALL = 'O programa não declarou desinstalação silenciosa (QuietUninstallString).';

/**
 * MSI: sempre (pelo ProductCode). Os outros: só pelo QuietUninstallString declarado pelo
 * programa, validado, e com a exceção ligada (DEPLOYMENT_ALLOW_VENDOR_UNINSTALL).
 */
export function uninstallInfo(item: InventoryItem, enabled: boolean = vendorUninstallEnabled()): UninstallInfo {
  const no = (reason: string): UninstallInfo => ({ available: false, method: null, reason, programId: null, command: null });
  if (item.productCode) return { available: true, method: 'MSI', reason: null, programId: null, command: null };
  if (item.uninstallKey === undefined) return no(OUTDATED_INVENTORY);
  if (!item.uninstallKey || !item.quietUninstallString) return no(NO_QUIET_UNINSTALL);
  const check = checkUninstallCommand(item.quietUninstallString);
  if ('reason' in check) return no(`Comando de desinstalação recusado: ${check.reason}`);
  if (!enabled) return no(VENDOR_UNINSTALL_DISABLED);
  return {
    available: true,
    method: 'VENDOR',
    reason: null,
    programId: computeProgramId(item.arch, item.uninstallKey, item.quietUninstallString),
    command: item.quietUninstallString,
  };
}

export interface InventoryItemView extends InventoryItem {
  /** Software do catálogo com o mesmo ProductCode (só MSI); null se não houver. */
  catalog: CatalogMatch | null;
  uninstall: UninstallInfo;
}

export interface InventoryView {
  machineId: string;
  collectedAt: string;
  collectedBy: { username: string; displayName: string | null };
  items: InventoryItemView[];
}

/** Um item (ou grupo de itens iguais) do software instalado nas máquinas selecionadas. */
export interface InventoryProductGroup {
  key: string;
  /** MSI = pode ser desinstalado pelo ProductCode; OTHER = não (nunca pelo UninstallString). */
  kind: 'MSI' | 'OTHER';
  productCode: string | null;
  name: string;
  version: string | null;
  publisher: string | null;
  /** Máquinas selecionadas que têm o item, na ordem da seleção. */
  machineIds: string[];
  catalog: CatalogMatch | null;
  uninstall: UninstallInfo;
}

/** POST /machines/inventory-summary */
export interface InventorySummary {
  staleAfterDays: number;
  machines: Array<{ id: string; hostname: string; seenInLastSync: boolean; inventoryAt: string | null; stale: boolean }>;
  products: InventoryProductGroup[];
}

/** GET /machines/:id/inventory: a última consulta e se dá para consultar de novo aqui. */
export interface InventoryState {
  inventory: InventoryView | null;
  collectAvailable: boolean;
  /** Por que a consulta ao vivo está indisponível neste servidor (ex.: sem WinRM). */
  collectUnavailableReason: string | null;
}

/** Falha na máquina → HTTP: tempo esgotado = 504; indisponível = 503; o resto = 502. */
export function inventoryFailureToHttp(reason: InventoryFailureReason, message: string): HttpException {
  const body = (status: number, error: string) => ({ statusCode: status, error, message, reason });
  if (reason === 'timeout' || reason === 'watchdog-timeout') {
    return new GatewayTimeoutException(body(HttpStatus.GATEWAY_TIMEOUT, 'Gateway Timeout'));
  }
  if (reason === 'unavailable') {
    return new ServiceUnavailableException(body(HttpStatus.SERVICE_UNAVAILABLE, 'Service Unavailable'));
  }
  return new BadGatewayException(body(HttpStatus.BAD_GATEWAY, 'Bad Gateway'));
}

@Injectable()
export class InventoryService implements OnModuleInit {
  private readonly logger = new Logger(InventoryService.name);
  /** Máquinas com consulta em andamento (uma por máquina; no máximo 5 no total). */
  private readonly running = new Set<string>();
  /**
   * Consultas automáticas (depois de uma implantação) esperando vaga no limite de 5:
   * máquina → quem pediu a implantação. Uma por máquina; a mais recente vale.
   */
  private readonly refreshWaiting = new Map<string, MachineChangedEvent>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly executor: PowerShellExecutor,
    @Optional() private readonly runner?: DeploymentRunner,
  ) {}

  onModuleInit(): void {
    this.runner?.onMachineChanged((event) => this.refreshAfterDeployment(event));
  }

  /**
   * Refaz a consulta da máquina depois de uma implantação, em segundo plano: não atrasa
   * nem muda o resultado da implantação. Respeita a trava por máquina (com consulta em
   * andamento, não duplica) e o limite de consultas simultâneas (sem vaga, espera a
   * próxima). Falha só vai para o log do servidor, e a última foto boa continua.
   * Sem consulta remota neste servidor (modo demonstração), não faz nada.
   */
  refreshAfterDeployment(event: MachineChangedEvent): void {
    if (!this.executor.isInventoryAvailable) return;
    if (this.running.has(event.machineId)) return;
    if (this.running.size >= MAX_CONCURRENT_INVENTORIES) {
      this.refreshWaiting.set(event.machineId, event);
      return;
    }
    void this.runRefresh(event);
  }

  /** Para testes: resolve quando nenhuma consulta automática está rodando nem esperando. */
  async whenRefreshIdle(): Promise<void> {
    while (this.running.size > 0 || this.refreshWaiting.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  private async runRefresh(event: MachineChangedEvent): Promise<void> {
    this.running.add(event.machineId);
    try {
      const result = await this.executor.inventory(event.hostname);
      if ('reason' in result) {
        this.logger.warn(
          `Inventário automático de ${event.hostname} (depois da implantação) falhou: ${result.reason} — ${result.message}`,
        );
        return;
      }
      await this.save(event.machineId, event.userId, result.items);
      this.logger.log(`Inventário de ${event.hostname} atualizado depois da implantação: ${result.items.length} itens.`);
    } catch (err) {
      this.logger.warn(`Inventário automático de ${event.hostname} falhou: ${(err as Error).message}`);
    } finally {
      this.running.delete(event.machineId);
      this.startWaitingRefresh();
    }
  }

  /** Libera a próxima consulta automática que esperava vaga (pulando máquina já em consulta). */
  private startWaitingRefresh(): void {
    for (const [machineId, event] of this.refreshWaiting) {
      if (this.running.size >= MAX_CONCURRENT_INVENTORIES) return;
      if (this.running.has(machineId)) continue;
      this.refreshWaiting.delete(machineId);
      void this.runRefresh(event);
    }
  }

  private save(machineId: string, userId: string, items: InventoryItem[]) {
    const collectedAt = new Date();
    const json = items as unknown as Prisma.InputJsonValue;
    return this.prisma.machineInventory.upsert({
      where: { machineId },
      create: { machineId, collectedAt, collectedById: userId, items: json },
      update: { collectedAt, collectedById: userId, items: json },
      include: { collectedBy: { select: { username: true, displayName: true } } },
    });
  }

  async latest(machineId: string): Promise<InventoryState> {
    const machine = await this.prisma.machine.findUnique({ where: { id: machineId }, select: { id: true } });
    if (!machine) throw new NotFoundException('Máquina não encontrada.');
    const row = await this.prisma.machineInventory.findUnique({
      where: { machineId },
      include: { collectedBy: { select: { username: true, displayName: true } } },
    });
    return {
      inventory: row ? await this.toView(row) : null,
      collectAvailable: this.executor.isInventoryAvailable,
      collectUnavailableReason: this.executor.isInventoryAvailable ? null : this.executor.inventoryUnavailableReason,
    };
  }

  /** Consulta ao vivo (síncrona). Só grava se der certo: uma falha não apaga a última foto. */
  async collect(machineId: string, userId: string, username: string): Promise<InventoryView> {
    if (!this.executor.isInventoryAvailable) {
      throw new ServiceUnavailableException(
        `A consulta remota está indisponível neste servidor: ${this.executor.inventoryUnavailableReason}`,
      );
    }
    const [machine, aggregate] = await Promise.all([
      this.prisma.machine.findUnique({ where: { id: machineId } }),
      this.prisma.machine.aggregate({ _max: { lastSync: true } }),
    ]);
    if (!machine) throw new NotFoundException('Máquina não encontrada.');
    if (!isSeenInLastSync(machine.lastSync, aggregate._max.lastSync)) {
      throw new ConflictException('Esta máquina não apareceu na última sincronização com o AD.');
    }
    if (this.running.has(machineId)) {
      throw new ConflictException('Já existe uma consulta em andamento para esta máquina. Aguarde o resultado.');
    }
    if (this.running.size >= MAX_CONCURRENT_INVENTORIES) {
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          error: 'Too Many Requests',
          message: `Já há ${MAX_CONCURRENT_INVENTORIES} consultas em andamento no servidor. Tente de novo em instantes.`,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // A consulta manual vale pela automática que esperava vaga para a mesma máquina.
    this.refreshWaiting.delete(machineId);
    this.running.add(machineId);
    let result: Awaited<ReturnType<PowerShellExecutor['inventory']>>;
    try {
      result = await this.executor.inventory(machine.hostname);
    } finally {
      this.running.delete(machineId);
      this.startWaitingRefresh();
    }
    if ('reason' in result) {
      this.logger.warn(`Inventário de ${machine.hostname} (por ${username}) falhou: ${result.reason} — ${result.message}`);
      throw inventoryFailureToHttp(result.reason, result.message);
    }

    const row = await this.save(machineId, userId, result.items);
    this.logger.log(`Inventário de ${machine.hostname} consultado por ${username}: ${result.items.length} itens.`);
    return this.toView(row);
  }

  private async toView(row: {
    machineId: string;
    collectedAt: Date;
    items: Prisma.JsonValue;
    collectedBy: { username: string; displayName: string | null };
  }): Promise<InventoryView> {
    const items = (Array.isArray(row.items) ? row.items : []) as unknown as InventoryItem[];
    const byCode = await this.catalogByCode(items.map((i) => i.productCode));
    return {
      machineId: row.machineId,
      collectedAt: row.collectedAt.toISOString(),
      collectedBy: row.collectedBy,
      items: items.map((i) => ({ ...i, catalog: i.productCode ? (byCode.get(i.productCode) ?? null) : null, uninstall: uninstallInfo(i) })),
    };
  }

  /**
   * Software MSI do catálogo por ProductCode. Mais de um cadastro com o mesmo pacote: o
   * ativo primeiro, depois o mais antigo (a mesma regra da desinstalação por ProductCode).
   */
  private async catalogByCode(codes: Array<string | null>): Promise<Map<string, CatalogMatch>> {
    const unique = [...new Set(codes.filter((c): c is string => !!c))];
    const software = unique.length
      ? await this.prisma.software.findMany({
          where: { installType: InstallType.MSI, msiProductCode: { in: unique } },
          select: { id: true, name: true, version: true, active: true, msiProductCode: true },
          orderBy: [{ active: 'desc' }, { createdAt: 'asc' }],
        })
      : [];
    const byCode = new Map<string, CatalogMatch>();
    for (const s of software) {
      if (s.msiProductCode && !byCode.has(s.msiProductCode)) {
        byCode.set(s.msiProductCode, { softwareId: s.id, name: s.name, version: s.version, active: s.active, uninstallAvailable: true });
      }
    }
    return byCode;
  }

  /**
   * Desinstalação pelo inventário: o software instalado nas máquinas selecionadas,
   * agrupado (MSI pelo ProductCode; o resto por nome e versão), com quantas delas têm
   * cada item, a partir da ÚLTIMA consulta guardada de cada máquina. Também: máquinas sem
   * inventário ou com inventário antigo (mais de INVENTORY_STALE_DAYS dias). Só o que o
   * inventário encontrou, como no painel da máquina (decisão da autora). Só leitura —
   * nada é consultado ao vivo aqui.
   */
  async summary(machineIds: string[], now: Date = new Date()): Promise<InventorySummary> {
    const [machines, aggregate, inventories] = await Promise.all([
      this.prisma.machine.findMany({ where: { id: { in: machineIds } }, select: { id: true, hostname: true, lastSync: true } }),
      this.prisma.machine.aggregate({ _max: { lastSync: true } }),
      this.prisma.machineInventory.findMany({
        where: { machineId: { in: machineIds } },
        orderBy: { collectedAt: 'desc' },
        select: { machineId: true, collectedAt: true, items: true },
      }),
    ]);
    if (machines.length !== machineIds.length) {
      throw new NotFoundException('Uma ou mais máquinas selecionadas não existem mais. Atualize a lista.');
    }
    const staleBefore = now.getTime() - INVENTORY_STALE_DAYS * 24 * 60 * 60 * 1000;
    const invByMachine = new Map(inventories.map((i) => [i.machineId, i]));

    // A consulta mais recente vem primeiro: o nome/versão do grupo é o dela.
    const groups = new Map<string, InventoryProductGroup & { machineSet: Set<string> }>();
    for (const inv of inventories) {
      const items = (Array.isArray(inv.items) ? inv.items : []) as unknown as InventoryItem[];
      for (const item of items) {
        // Programa desinstalável por comando do fabricante: um grupo por programId (só
        // juntam máquinas com o MESMO comando). Os outros "Outro": por nome e versão.
        const info = uninstallInfo(item);
        const key = item.productCode
          ? `MSI|${item.productCode}`
          : info.programId
            ? `PROG|${info.programId}`
            : `OTHER|${item.name.toLowerCase()}|${item.version ?? ''}`;
        let g = groups.get(key);
        if (!g) {
          g = {
            key,
            kind: item.productCode ? 'MSI' : 'OTHER',
            productCode: item.productCode,
            name: item.name,
            version: item.version,
            publisher: item.publisher,
            machineIds: [],
            catalog: null,
            uninstall: info,
            machineSet: new Set(),
          };
          groups.set(key, g);
        }
        g.machineSet.add(inv.machineId);
      }
    }
    const byCode = await this.catalogByCode([...groups.values()].map((g) => g.productCode));
    const products: InventoryProductGroup[] = [...groups.values()]
      .map(({ machineSet, ...g }) => ({
        ...g,
        machineIds: machineIds.filter((id) => machineSet.has(id)),
        catalog: g.productCode ? (byCode.get(g.productCode) ?? null) : null,
      }))
      .sort((a, b) => b.machineIds.length - a.machineIds.length || a.name.localeCompare(b.name, 'pt-BR'));


    return {
      staleAfterDays: INVENTORY_STALE_DAYS,
      machines: machines
        .map((m) => {
          const inv = invByMachine.get(m.id);
          return {
            id: m.id,
            hostname: m.hostname,
            seenInLastSync: isSeenInLastSync(m.lastSync, aggregate._max.lastSync),
            inventoryAt: inv ? inv.collectedAt.toISOString() : null,
            stale: inv ? inv.collectedAt.getTime() < staleBefore : false,
          };
        })
        .sort((a, b) => a.hostname.localeCompare(b.hostname)),
      products,
    };
  }
}
