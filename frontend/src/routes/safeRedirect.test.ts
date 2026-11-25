import { describe, expect, it } from 'vitest';
import { DEFAULT_AFTER_LOGIN, safeRedirectPath } from './safeRedirect';

describe('safeRedirectPath — para onde voltar depois do login (sem open redirect)', () => {
  it.each([
    ['/history?status=FAILED', 'página com filtros'],
    ['/monitoring?open=abc#log', 'com busca e âncora'],
    ['/software', 'caminho simples'],
  ])('aceita caminho interno: %s (%s)', (path) => {
    expect(safeRedirectPath(path)).toBe(path);
  });

  it.each([
    ['//evil.example/x', 'dois "/" = outro site'],
    ['/\\evil.example', 'o navegador trata "/\\" como "//"'],
    ['https://evil.example', 'endereço absoluto'],
    ['javascript:alert(1)', 'não começa com "/"'],
    ['/history\nSet-Cookie: x', 'caractere de controle'],
    ['/login', 'a própria tela de login'],
    ['/login?x=1', 'login com busca'],
    ['/' + 'a'.repeat(2048), 'mais de 2048 caracteres'],
    ['', 'vazio'],
  ])('recusa %j e vai para o Dashboard (%s)', (value) => {
    expect(safeRedirectPath(value)).toBe(DEFAULT_AFTER_LOGIN);
  });

  it('valor que não é texto (estado da navegação adulterado) vai para o Dashboard', () => {
    expect(safeRedirectPath({ pathname: '/history' })).toBe('/dashboard');
    expect(safeRedirectPath(undefined)).toBe('/dashboard');
  });
});
