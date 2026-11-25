import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { storeSession } from '../test/tokens';
import { ProtectedRoute } from './ProtectedRoute';

/** Mostra para onde o login voltaria (o `from` guardado no estado da navegação). */
function LoginProbe() {
  const state = useLocation().state as { from?: string } | null;
  return <p>Tela de login — voltar para: {state?.from ?? '(Dashboard)'}</p>;
}

function renderAt(path: string) {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/login" element={<LoginProbe />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/history" element={<p>Histórico</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

describe('ProtectedRoute — guarda das páginas internas', () => {
  it('com sessão válida, mostra a página', () => {
    storeSession();
    renderAt('/history');
    expect(screen.getByText('Histórico')).toBeInTheDocument();
  });

  it('sem sessão, vai para o login guardando a página com a busca e a âncora', () => {
    renderAt('/history?status=FAILED#topo');
    expect(screen.getByText('Tela de login — voltar para: /history?status=FAILED#topo')).toBeInTheDocument();
    expect(screen.queryByText('Histórico')).not.toBeInTheDocument();
  });

  it('sessão vencida conta como sem sessão', () => {
    storeSession(-60);
    renderAt('/history');
    expect(screen.getByText(/Tela de login/)).toBeInTheDocument();
  });
});
