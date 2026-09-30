import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { MachineSyncScheduler, parseSyncInterval } from './machine-sync.scheduler';
import { MachineSyncService, SyncResult } from './machine-sync.service';

const MIN = 60_000;

function result(total = 15): SyncResult {
  return { total, created: 0, updated: total, notSeen: 0, syncedAt: new Date().toISOString() };
}

/** Promise controlável: permite simular uma sincronização que ainda não terminou. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

describe('MachineSyncScheduler', () => {
  const ORIGINAL_ENV = process.env;
  let syncService: { sync: jest.Mock };
  let scheduler: MachineSyncScheduler;

  function createScheduler(interval?: string) {
    if (interval === undefined) delete process.env.MACHINE_SYNC_INTERVAL_MINUTES;
    else process.env.MACHINE_SYNC_INTERVAL_MINUTES = interval;
    scheduler = new MachineSyncScheduler(syncService as unknown as MachineSyncService);
    return scheduler;
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-09-25T12:00:00Z') });
    process.env = {
      ...ORIGINAL_ENV,
      LDAP_SEARCH_BIND_DN: 'cn=svc,dc=exemplo',
      LDAP_SEARCH_BIND_PASSWORD: 'x',
      LDAP_COMPUTER_BASE_DN: 'ou=computadores,dc=exemplo',
    };
    syncService = { sync: jest.fn().mockResolvedValue(result()) };
  });

  afterEach(() => {
    scheduler?.onModuleDestroy();
    jest.useRealTimers();
    process.env = ORIGINAL_ENV;
  });

  it('sincroniza ao subir e agenda o próximo ciclo para +intervalo', async () => {
    createScheduler('60').onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);

    expect(syncService.sync).toHaveBeenCalledTimes(1);
    const status = scheduler.getStatus();
    expect(status.lastTrigger).toBe('STARTUP');
    expect(status.nextRunAt).toBe('2026-09-25T13:00:00.000Z');
  });

  it('dispara automaticamente a cada intervalo', async () => {
    createScheduler('60').onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0);

    await jest.advanceTimersByTimeAsync(60 * MIN);
    expect(syncService.sync).toHaveBeenCalledTimes(2);
    expect(scheduler.getStatus().lastTrigger).toBe('AUTO');

    await jest.advanceTimersByTimeAsync(60 * MIN);
    expect(syncService.sync).toHaveBeenCalledTimes(3);
  });

  it('disparo manual no meio do ciclo reinicia a contagem (o timer antigo não dispara)', async () => {
    createScheduler('60').onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(0); // sync da subida às 12:00 → próximo às 13:00

    await jest.advanceTimersByTimeAsync(50 * MIN); // 12:50
    await scheduler.run('MANUAL');
    expect(syncService.sync).toHaveBeenCalledTimes(2);
    expect(scheduler.getStatus().nextRunAt).toBe('2026-09-25T13:50:00.000Z');

    // 13:00 — horário do timer antigo: não pode disparar
    await jest.advanceTimersByTimeAsync(10 * MIN);
    expect(syncService.sync).toHaveBeenCalledTimes(2);

    // 13:50 — novo horário
    await jest.advanceTimersByTimeAsync(50 * MIN);
    expect(syncService.sync).toHaveBeenCalledTimes(3);
    expect(scheduler.getStatus().lastTrigger).toBe('AUTO');
  });

  it('conta o intervalo a partir do FIM: sincronização lenta não empilha ciclos', async () => {
    const slow = deferred<SyncResult>();
    syncService.sync.mockReturnValueOnce(slow.promise);
    createScheduler('5').onApplicationBootstrap();

    // AD lento: a sync da subida leva 12 min (mais que o intervalo de 5)
    await jest.advanceTimersByTimeAsync(12 * MIN);
    expect(syncService.sync).toHaveBeenCalledTimes(1);
    expect(scheduler.getStatus().running).toBe(true);
    expect(scheduler.getStatus().nextRunAt).toBeNull();

    slow.resolve(result());
    await jest.advanceTimersByTimeAsync(0);
    expect(scheduler.getStatus().nextRunAt).toBe('2026-09-25T12:17:00.000Z');

    await jest.advanceTimersByTimeAsync(5 * MIN);
    expect(syncService.sync).toHaveBeenCalledTimes(2);
  });

  it('clique durante sincronização em andamento → 409 e a contagem não muda', async () => {
    const slow = deferred<SyncResult>();
    createScheduler('60');
    await scheduler.run('MANUAL'); // agenda 13:00
    const nextBefore = scheduler.getStatus().nextRunAt;

    syncService.sync.mockReturnValueOnce(slow.promise);
    await jest.advanceTimersByTimeAsync(60 * MIN); // 13:00: o automático começa e fica rodando
    expect(scheduler.getStatus().running).toBe(true);

    await expect(scheduler.run('MANUAL')).rejects.toThrow(ConflictException);
    expect(syncService.sync).toHaveBeenCalledTimes(2);

    slow.resolve(result());
    await jest.advanceTimersByTimeAsync(0);
    expect(nextBefore).toBe('2026-09-25T13:00:00.000Z');
    expect(scheduler.getStatus().nextRunAt).toBe('2026-09-25T14:00:00.000Z');
  });

  it('falha também reagenda, registra lastError e preserva o último sucesso', async () => {
    createScheduler('60');
    await scheduler.run('MANUAL');
    const lastSuccess = scheduler.getStatus().lastResult;

    syncService.sync.mockRejectedValueOnce(
      new ServiceUnavailableException('Não foi possível consultar o diretório (AD/LDAP).'),
    );
    await jest.advanceTimersByTimeAsync(60 * MIN); // automático falha, sem derrubar nada

    const status = scheduler.getStatus();
    expect(status.lastError).toBe('Não foi possível consultar o diretório (AD/LDAP).');
    expect(status.lastResult).toEqual(lastSuccess);
    expect(status.nextRunAt).toBe('2026-09-25T14:00:00.000Z');

    // Próxima tentativa com sucesso limpa o erro
    await jest.advanceTimersByTimeAsync(60 * MIN);
    expect(scheduler.getStatus().lastError).toBeNull();
  });

  it('manual propaga o erro ao cliente, mas reagenda mesmo assim', async () => {
    createScheduler('60');
    syncService.sync.mockRejectedValueOnce(new ServiceUnavailableException('fora do ar'));

    await expect(scheduler.run('MANUAL')).rejects.toThrow(ServiceUnavailableException);
    expect(scheduler.getStatus().nextRunAt).toBe('2026-09-25T13:00:00.000Z');
  });

  it('erro não-HTTP vira mensagem genérica no status (sem vazar detalhe)', async () => {
    createScheduler('60');
    syncService.sync.mockRejectedValueOnce(new Error('senha=xyz no stack'));

    await expect(scheduler.run('MANUAL')).rejects.toThrow();
    expect(scheduler.getStatus().lastError).toBe('Erro inesperado na sincronização.');
  });

  it('intervalo 0: não sincroniza ao subir nem agenda, mas o manual funciona', async () => {
    createScheduler('0').onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(24 * 60 * MIN);
    expect(syncService.sync).not.toHaveBeenCalled();

    await scheduler.run('MANUAL');
    expect(syncService.sync).toHaveBeenCalledTimes(1);
    expect(scheduler.getStatus()).toMatchObject({ autoSyncEnabled: false, nextRunAt: null });
  });

  it('sem conta de serviço configurada: não sincroniza ao subir nem agenda', async () => {
    delete process.env.LDAP_SEARCH_BIND_PASSWORD;
    createScheduler('60').onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(2 * 60 * MIN);

    expect(syncService.sync).not.toHaveBeenCalled();
    expect(scheduler.getStatus().autoSyncEnabled).toBe(false);
  });

  it('ao desligar o módulo, cancela o timer e não reagenda', async () => {
    const slow = deferred<SyncResult>();
    syncService.sync.mockReturnValueOnce(slow.promise);
    createScheduler('60').onApplicationBootstrap();

    scheduler.onModuleDestroy(); // desliga com a sync da subida ainda rodando
    slow.resolve(result());
    await jest.advanceTimersByTimeAsync(3 * 60 * MIN);

    expect(syncService.sync).toHaveBeenCalledTimes(1);
    expect(scheduler.getStatus().nextRunAt).toBeNull();
  });
});

describe('parseSyncInterval', () => {
  it.each([
    [undefined, 60],
    ['', 60],
    ['60', 60],
    ['0', 0],
    ['5', 5],
    ['1', 5], // abaixo do mínimo
    ['1440', 1440],
    ['99999', 1440], // acima do teto (setTimeout dispararia imediatamente)
    ['abc', 60],
    ['-10', 60],
    ['7.5', 60],
  ])('%p → %p', (raw, expected) => {
    expect(parseSyncInterval(raw)).toBe(expected);
  });
});
