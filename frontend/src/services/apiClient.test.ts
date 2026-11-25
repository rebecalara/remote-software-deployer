import { describe, expect, it, vi } from 'vitest';
import { storeSession } from '../test/tokens';
import { ApiError, NetworkError, SessionExpiredError, apiDownload, apiFetch } from './apiClient';
import { onSessionExpired } from './session';

function mockFetch(response: Response | Error) {
  const fn = vi.fn(() => (response instanceof Error ? Promise.reject(response) : Promise.resolve(response)));
  vi.stubGlobal('fetch', fn);
  return fn;
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('apiFetch — toda chamada autenticada passa por aqui', () => {
  it('envia o token no cabeçalho Authorization e o corpo em JSON', async () => {
    const token = storeSession();
    const fetch = mockFetch(json(200, { ok: true }));
    await expect(apiFetch('/deployments', { method: 'POST', body: { a: 1 } })).resolves.toEqual({ ok: true });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/deployments');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
    expect(init.body).toBe('{"a":1}');
  });

  it('sem sessão válida, nem chama o backend: encerra a sessão', async () => {
    const fetch = mockFetch(json(200, {}));
    await expect(apiFetch('/machines')).rejects.toBeInstanceOf(SessionExpiredError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('401 do backend encerra a sessão e avisa a tela (que volta ao login)', async () => {
    storeSession();
    mockFetch(json(401, { message: 'Unauthorized' }));
    const expired = vi.fn();
    const stop = onSessionExpired(expired);
    await expect(apiFetch('/machines')).rejects.toBeInstanceOf(SessionExpiredError);
    expect(expired).toHaveBeenCalled();
    expect(sessionStorage.getItem('rsd.auth')).toBeNull();
    stop();
  });

  it('erro da API chega com a mensagem do backend e o campo com problema', async () => {
    storeSession();
    mockFetch(json(400, { statusCode: 400, message: 'Argumento inválido.', field: 'installArgs[2]' }));
    const error = (await apiFetch('/software').catch((e) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(400);
    expect(error.message).toBe('Argumento inválido.');
    expect(error.field).toBe('installArgs[2]');
  });

  it('mensagem em lista (validação do Nest) vira um texto só', async () => {
    storeSession();
    mockFetch(json(400, { message: ['Nome obrigatório.', 'Versão obrigatória.'] }));
    await expect(apiFetch('/software')).rejects.toThrow('Nome obrigatório. Versão obrigatória.');
  });

  it('backend fora do ar atrás do proxy (502 sem corpo) mostra mensagem de conexão', async () => {
    storeSession();
    mockFetch(new Response('', { status: 502 }));
    await expect(apiFetch('/dashboard')).rejects.toThrow('Não foi possível conectar ao servidor');
  });

  it('falha de rede vira NetworkError', async () => {
    storeSession();
    mockFetch(new TypeError('Failed to fetch'));
    await expect(apiFetch('/dashboard')).rejects.toBeInstanceOf(NetworkError);
  });

  it('204 sem corpo devolve undefined', async () => {
    storeSession();
    mockFetch(new Response(null, { status: 204 }));
    await expect(apiFetch('/software/1', { method: 'DELETE' })).resolves.toBeUndefined();
  });
});

describe('apiDownload — CSV do Histórico', () => {
  it('devolve o arquivo e o nome do Content-Disposition', async () => {
    storeSession();
    mockFetch(
      new Response('a;b\r\n', {
        status: 200,
        headers: { 'Content-Disposition': 'attachment; filename="rsd-historico-2026-11-25.csv"' },
      }),
    );
    const { blob, fileName } = await apiDownload('/deployments/export');
    expect(fileName).toBe('rsd-historico-2026-11-25.csv');
    expect(await blob.text()).toBe('a;b\r\n');
  });

  it('400 do limite de linhas chega com a mensagem do backend', async () => {
    storeSession();
    mockFetch(json(400, { message: 'Muitos resultados para exportar; refine os filtros.' }));
    await expect(apiDownload('/deployments/export')).rejects.toThrow('Muitos resultados para exportar; refine os filtros.');
  });

  it('401 encerra a sessão', async () => {
    storeSession();
    mockFetch(json(401, {}));
    await expect(apiDownload('/deployments/export')).rejects.toBeInstanceOf(SessionExpiredError);
  });
});
