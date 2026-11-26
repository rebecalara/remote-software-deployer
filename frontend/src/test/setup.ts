import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// O jsdom não implementa matchMedia (usado pelo SidePanel para decidir coluna ou sobreposto).
// Padrão: tela estreita (nenhuma media query casa); um teste pode trocar com setMatchMedia.
let mediaMatches = false;
export function setMatchMedia(matches: boolean): void {
  mediaMatches = matches;
}
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: mediaMatches,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }),
});

// Nenhum aviso no console dos testes: um aviso do React (ex.: "validateDOMNesting" — botão
// dentro de botão —, "act(...)", chave repetida) ou qualquer console.error/warn faz o teste
// falhar, com a mensagem. Um teste que espera um aviso de propósito precisa silenciá-lo.
const consoleProblems: string[] = [];
for (const level of ['error', 'warn'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    consoleProblems.push(`console.${level}: ${args.map(String).join(' ').slice(0, 300)}`);
    original(...args);
  };
}

afterEach(() => {
  const problems = consoleProblems.splice(0);
  if (problems.length > 0) throw new Error(`Aviso no console durante o teste:\n${problems.join('\n')}`);
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  mediaMatches = false;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
