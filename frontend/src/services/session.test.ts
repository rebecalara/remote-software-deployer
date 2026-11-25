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

  it('conteúdo corrompido no armazenamento não derruba a tela: fica sem sessão', () => {
    sessionStorage.setItem('rsd.auth', '{quebrado');
    expect(loadSession()).toBeNull();
  });

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
