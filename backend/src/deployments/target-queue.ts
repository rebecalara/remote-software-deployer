// Fila em memória das máquinas a instalar (DECISIONS.md, Bloco 4: "execução em fila
// na memória, 10 em paralelo, trava por máquina"). Não sabe nada de banco nem de
// PowerShell: recebe itens e uma função que processa um item.
//
// - No máximo `maxParallel` itens ao mesmo tempo.
// - Nunca dois itens da MESMA máquina ao mesmo tempo (o msiexec responderia 1618):
//   o item espera, e os de outras máquinas passam à frente.
// - Ordem de chegada entre os itens que podem rodar.
// - Um erro do worker não para a fila (quem chama trata e registra os próprios erros).

export interface QueueItem {
  targetId: string;
  machineId: string;
}

export const DEFAULT_MAX_PARALLEL = 10;
export const MAX_PARALLEL_CEILING = 20;

export class TargetQueue {
  private readonly waiting: QueueItem[] = [];
  private readonly busyMachines = new Set<string>();
  private running = 0;
  private idleResolvers: Array<() => void> = [];

  constructor(
    private readonly maxParallel: number,
    private readonly worker: (item: QueueItem) => Promise<void>,
  ) {}

  enqueue(items: QueueItem[]): void {
    this.waiting.push(...items);
    this.pump();
  }

  get stats(): { running: number; waiting: number } {
    return { running: this.running, waiting: this.waiting.length };
  }

  /** Resolve quando não há nada rodando nem esperando (para testes e encerramento). */
  whenIdle(): Promise<void> {
    if (this.running === 0 && this.waiting.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleResolvers.push(resolve));
  }

  private pump(): void {
    while (this.running < this.maxParallel) {
      const index = this.waiting.findIndex((item) => !this.busyMachines.has(item.machineId));
      if (index === -1) break;
      const [item] = this.waiting.splice(index, 1);
      this.start(item);
    }
    if (this.running === 0 && this.waiting.length === 0) {
      const resolvers = this.idleResolvers;
      this.idleResolvers = [];
      resolvers.forEach((resolve) => resolve());
    }
  }

  private start(item: QueueItem): void {
    this.running++;
    this.busyMachines.add(item.machineId);
    // Promise.resolve().then: o worker nunca roda dentro do enqueue() de quem chamou,
    // e um throw síncrono vira rejeição como qualquer outra.
    Promise.resolve()
      .then(() => this.worker(item))
      .catch(() => undefined)
      .finally(() => {
        this.running--;
        this.busyMachines.delete(item.machineId);
        this.pump();
      });
  }
}

export function parseMaxParallel(raw: string | undefined, warn?: (msg: string) => void): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_PARALLEL;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    warn?.(`DEPLOYMENT_MAX_PARALLEL inválido ("${raw}"); usando ${DEFAULT_MAX_PARALLEL}.`);
    return DEFAULT_MAX_PARALLEL;
  }
  if (value > MAX_PARALLEL_CEILING) {
    warn?.(`DEPLOYMENT_MAX_PARALLEL=${value} acima do teto; usando ${MAX_PARALLEL_CEILING}.`);
    return MAX_PARALLEL_CEILING;
  }
  return value;
}
