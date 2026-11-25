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

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  mediaMatches = false;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
