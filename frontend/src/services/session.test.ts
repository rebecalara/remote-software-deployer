import { describe, expect, it, vi } from 'vitest';
import { fakeToken, storeSession, TEST_USER } from '../test/tokens';
import { clearSession, expireSession, getToken, isTokenExpired, loadSession, onSessionExpired, saveSession } from './session';

describe('sessão no sessionStorage', () => {
  it('guarda e lê a sessão (sobrevive ao F5 da mesma aba)', () => {
    const token = fakeToken(3600);
    saveSession({ token, user: TEST_USER });
    expect(loadSession()).toEqual({ token, user: TEST_USER });
    expect(getToken()).toBe(token);
  });

  it('token com "exp" vencido é descartado e apagado do armazenamento', () => {
    storeSession(-10);
    expect(loadSession()).toBeNull();
    expect(sessionStorage.getItem('rsd.auth')).toBeNull();
  });

  it('token ilegível conta como vencido', () => {
    expect(isTokenExpired('nao-e-um-jwt')).toBe(true);
    expect(isTokenExpired(fakeToken(60))).toBe(false);
  });

  it('conteúdo corrompido no armazenamento não derruba a tela: fica sem sessão e é apagado', () => {
    sessionStorage.setItem('rsd.auth', '{quebrado');
    expect(loadSession()).toBeNull();
    expect(sessionStorage.getItem('rsd.auth')).toBeNull();
  });
});

describe('sessão alterada no navegador (Browser Storage Poisoning) é descartada', () => {
  const valid = () => ({ token: fakeToken(3600), user: { ...TEST_USER } });
  const poison = (session: unknown) => sessionStorage.setItem('rsd.auth', JSON.stringify(session));

  it.each([
    ['perfil inexistente', { ...valid(), user: { ...TEST_USER, role: 'ROOT' } }],
    ['perfil em minúsculas', { ...valid(), user: { ...TEST_USER, role: 'admin' } }],
    ['token que não é JWT', { ...valid(), token: 'qualquer-coisa' }],
    ['token com a assinatura vazia', { ...valid(), token: fakeToken(3600).replace(/\.[^.]+$/, '.') }],
    ['token com caractere fora do base64url', { ...valid(), token: `${fakeToken(3600)}<script>` }],
    ['sem usuário', { token: fakeToken(3600) }],
    ['nome de exibição que não é texto', { ...valid(), user: { ...TEST_USER, displayName: 42 } }],
    ['id ausente', { ...valid(), user: { username: 'x', displayName: 'X', role: 'ADMIN' } }],
    ['uma lista no lugar da sessão', [fakeToken(3600)]],
  ])('%s: descarta e apaga', (_caso, session) => {
    poison(session);
    expect(loadSession()).toBeNull();
    expect(sessionStorage.getItem('rsd.auth')).toBeNull();
  });

  it('campos a mais não são lidos: só id, usuário, nome e perfil', () => {
    poison({ ...valid(), extra: 'x', user: { ...TEST_USER, isSuperAdmin: true } });
    expect(loadSession()?.user).toEqual(TEST_USER);
  });

  it('gravar uma sessão fora do formato lança erro e não grava nada', () => {
    const bad = { token: fakeToken(3600), user: { ...TEST_USER, role: 'ROOT' } } as unknown as Parameters<typeof saveSession>[0];
    expect(() => saveSession(bad)).toThrow('Resposta de login inválida do servidor.');
    expect(sessionStorage.getItem('rsd.auth')).toBeNull();
  });

  it('gravar guarda só os campos conhecidos', () => {
    saveSession({ token: fakeToken(3600), user: { ...TEST_USER, extra: 1 } as typeof TEST_USER });
    expect(JSON.parse(sessionStorage.getItem('rsd.auth')!).user).toEqual(TEST_USER);
  });
});

describe('sessão — fim da sessão', () => {

  it('"Sair" apaga a sessão', () => {
    storeSession();
    clearSession();
    expect(getToken()).toBeNull();
  });

  it('expirar (401 da API) apaga a sessão e avisa quem está ouvindo; quem saiu não é mais avisado', () => {
    storeSession();
    const listener = vi.fn();
    const stop = onSessionExpired(listener);
    expireSession();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getToken()).toBeNull();
    stop();
    expireSession();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
