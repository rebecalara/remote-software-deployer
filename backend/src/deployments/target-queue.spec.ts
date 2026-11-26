import {
  DEFAULT_MAX_PARALLEL,
  MAX_PARALLEL_CEILING,
  QueueItem,
  TargetQueue,
  parseMaxParallel,
} from './target-queue';

/** Worker controlado pelo teste: cada item só termina quando o teste manda. */
function controlledWorker() {
  const started: string[] = [];
  const pending = new Map<string, { resolve: () => void; reject: (e: Error) => void }>();
  let active = 0;
  let maxActive = 0;
  const worker = (item: QueueItem) =>
    new Promise<void>((resolve, reject) => {
      started.push(item.targetId);
      active++;
      maxActive = Math.max(maxActive, active);
      pending.set(item.targetId, {
        resolve: () => {
          active--;
          resolve();
        },
        reject: (e) => {
          active--;
          reject(e);
        },
      });
    });
  return {
    worker,
    started,
    get maxActive() {
      return maxActive;
    },
    finish: async (id: string) => {
      pending.get(id)!.resolve();
      await flush();
    },
    fail: async (id: string) => {
      pending.get(id)!.reject(new Error('falhou'));
      await flush();
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const item = (targetId: string, machineId: string): QueueItem => ({ targetId, machineId });

describe('TargetQueue', () => {
  it('nunca passa do limite de paralelismo', async () => {
    const w = controlledWorker();
    const queue = new TargetQueue(3, w.worker);
    queue.enqueue(Array.from({ length: 10 }, (_, i) => item(`t${i}`, `m${i}`)));
    await flush();

    expect(w.started).toEqual(['t0', 't1', 't2']);
    expect(queue.stats).toEqual({ running: 3, waiting: 7 });

    await w.finish('t1');
    expect(w.started).toEqual(['t0', 't1', 't2', 't3']);
    expect(w.maxActive).toBe(3);
  });

  it('nunca roda duas vezes a mesma máquina ao mesmo tempo, e as outras passam à frente', async () => {
    const w = controlledWorker();
    const queue = new TargetQueue(5, w.worker);
    queue.enqueue([item('a1', 'A'), item('a2', 'A'), item('b1', 'B'), item('a3', 'A'), item('c1', 'C')]);
    await flush();

    expect(w.started).toEqual(['a1', 'b1', 'c1']);
    await w.finish('a1');
    expect(w.started).toEqual(['a1', 'b1', 'c1', 'a2']);
    await w.finish('a2');
    expect(w.started).toEqual(['a1', 'b1', 'c1', 'a2', 'a3']);
  });

  it('uma falha do worker não para a fila', async () => {
    const w = controlledWorker();
    const queue = new TargetQueue(1, w.worker);
    queue.enqueue([item('t1', 'A'), item('t2', 'B')]);
    await flush();
    await w.fail('t1');
    expect(w.started).toEqual(['t1', 't2']);
  });

  it('um throw síncrono do worker também não para a fila', async () => {
    const seen: string[] = [];
    const queue = new TargetQueue(1, (i) => {
      seen.push(i.targetId);
      if (i.targetId === 't1') throw new Error('síncrono');
      return Promise.resolve();
    });
    queue.enqueue([item('t1', 'A'), item('t2', 'B')]);
    await queue.whenIdle();
    expect(seen).toEqual(['t1', 't2']);
  });

  it('whenIdle resolve quando tudo termina (e na hora, se já está vazia)', async () => {
    const w = controlledWorker();
    const queue = new TargetQueue(2, w.worker);
    await expect(queue.whenIdle()).resolves.toBeUndefined();

    queue.enqueue([item('t1', 'A'), item('t2', 'B')]);
    await flush();
    let idle = false;
    void queue.whenIdle().then(() => (idle = true));
    await w.finish('t1');
    expect(idle).toBe(false);
    await w.finish('t2');
    expect(idle).toBe(true);
  });
});

describe('parseMaxParallel', () => {
  it.each([
    [undefined, DEFAULT_MAX_PARALLEL],
    ['', DEFAULT_MAX_PARALLEL],
    ['4', 4],
    ['0', DEFAULT_MAX_PARALLEL],
    ['x', DEFAULT_MAX_PARALLEL],
    ['50', MAX_PARALLEL_CEILING],
  ])('%p → %p', (raw, expected) => {
    expect(parseMaxParallel(raw)).toBe(expected);
  });
});
