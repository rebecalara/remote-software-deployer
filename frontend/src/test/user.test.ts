import { describe, expect, it } from 'vitest';

// Garante que os testes usam o setupUser() (userEvent sem pausa entre as teclas; ver user.ts).
// Chamar o userEvent.setup() direto trazia de volta a lentidão que estourava os 5 s do Vitest
// de vez em quando na suíte inteira.
const sources = import.meta.glob<string>(['../**/*.test.ts', '../**/*.test.tsx'], { query: '?raw', import: 'default', eager: true });

describe('setupUser — testes sem pausa entre as teclas', () => {
  it('a varredura encontra os testes do frontend', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(20);
    expect(Object.keys(sources)).toEqual(expect.arrayContaining(['../pages/Login/LoginPage.test.tsx']));
  });

  it('nenhum teste chama o userEvent.setup() direto', () => {
    const offenders = Object.entries(sources)
      .filter(([, text]) => /userEvent\.setup\(/.test(text.replace(/\/\/.*$/gm, '')))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});
