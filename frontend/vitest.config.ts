import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

// Testes do frontend: mesma configuração do Vite (plugins do React e do Tailwind), com o
// navegador simulado pelo jsdom. Nenhum teste chama o backend: fetch e serviços são simulados.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
      restoreMocks: true,
      coverage: {
        provider: 'v8',
        // TODO o src entra na conta, inclusive os arquivos sem teste (contam 0%). Fora só o
        // ponto de entrada, os tipos (sem código) e o próprio material de teste.
        include: ['src/**/*.{ts,tsx}'],
        exclude: ['src/main.tsx', 'src/types/**', 'src/**/*.d.ts', 'src/test/**', 'src/**/*.test.{ts,tsx}'],
        // lcov: lido pelo SonarCloud no CI.
        reporter: ['text-summary', 'text', 'html', 'lcov'],
        reportsDirectory: './coverage',
      },
    },
  }),
);
