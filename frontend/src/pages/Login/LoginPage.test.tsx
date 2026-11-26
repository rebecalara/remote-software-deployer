import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../../context/AuthContext';
import { fakeToken, TEST_USER } from '../../test/tokens';
import { LoginPage } from './LoginPage';

// Nenhum teste chama o backend nem o AD: a resposta do POST /auth/login é simulada.
function mockLogin(status: number, body: unknown) {
  const fetch = vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

function renderLogin(state?: { from: string }) {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={[{ pathname: '/login', state }]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/dashboard" element={<p>Dashboard</p>} />
          <Route path="/history" element={<p>Histórico</p>} />
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}

async function fillAndSubmit(username = ' TestUser ', password = 'senha123') {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Usuário'), username);
  await user.type(screen.getByLabelText('Senha'), password);
  await user.click(screen.getByRole('button', { name: 'Entrar' }));
}

/** O navegador só informa o Caps Lock num evento de teclado ou mouse. */
function pressKeyWithCapsLock(on: boolean) {
  const event = new KeyboardEvent('keydown', { key: on ? 'A' : 'a' });
  Object.defineProperty(event, 'getModifierState', { value: (k: string) => k === 'CapsLock' && on });
  act(() => {
    window.dispatchEvent(event);
  });
}

describe('LoginPage', () => {
  it('envia usuário (sem espaços nas pontas) e senha, e abre o Dashboard', async () => {
    const fetch = mockLogin(200, { accessToken: fakeToken(3600), user: TEST_USER });
    renderLogin();
    await fillAndSubmit();
    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/login');
    expect(JSON.parse(String(init.body))).toEqual({ username: 'TestUser', password: 'senha123' });
    expect(sessionStorage.getItem('rsd.auth')).toContain('"username":"testuser"');
  });

  it('volta para a página guardada (sessão expirada / link direto)', async () => {
    mockLogin(200, { accessToken: fakeToken(3600), user: TEST_USER });
    renderLogin({ from: '/history' });
    await fillAndSubmit();
    expect(await screen.findByText('Histórico')).toBeInTheDocument();
  });

  it('endereço de volta para fora do sistema é ignorado: vai para o Dashboard', async () => {
    mockLogin(200, { accessToken: fakeToken(3600), user: TEST_USER });
    renderLogin({ from: '//evil.example/x' });
    await fillAndSubmit();
    expect(await screen.findByText('Dashboard')).toBeInTheDocument();
  });

  it('401: mensagem genérica, que não diz se o usuário existe', async () => {
    mockLogin(401, { message: 'qualquer coisa do servidor' });
    renderLogin();
    await fillAndSubmit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Usuário ou senha inválidos.');
    expect(sessionStorage.getItem('rsd.auth')).toBeNull();
  });

  it('resposta do login fora do formato (perfil desconhecido): mensagem e nada é gravado', async () => {
    mockLogin(200, { accessToken: fakeToken(3600), user: { ...TEST_USER, role: 'ROOT' } });
    renderLogin();
    await fillAndSubmit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Resposta de login inválida do servidor.');
    expect(sessionStorage.getItem('rsd.auth')).toBeNull();
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
  });

  it('429: mostra a mensagem do servidor com o tempo de espera', async () => {
    mockLogin(429, { message: 'Muitas tentativas de login a partir deste endereço. Tente novamente em 15 minutos.' });
    renderLogin();
    await fillAndSubmit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Tente novamente em 15 minutos.');
  });

  it('503: o AD não respondeu (não é culpa da senha)', async () => {
    mockLogin(503, { message: 'Serviço de autenticação indisponível. Tente novamente em instantes.' });
    renderLogin();
    await fillAndSubmit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Serviço de autenticação indisponível.');
  });

  it('"Entrar" desativado sem usuário ou sem senha', async () => {
    renderLogin();
    const button = screen.getByRole('button', { name: 'Entrar' });
    expect(button).toBeDisabled();
    await userEvent.setup().type(screen.getByLabelText('Usuário'), 'testuser');
    expect(button).toBeDisabled();
  });

  it('senha sem texto de exemplo e com botão para mostrar', async () => {
    renderLogin();
    const password = screen.getByLabelText('Senha');
    expect(password).not.toHaveAttribute('placeholder');
    expect(password).toHaveAttribute('type', 'password');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Mostrar senha' }));
    expect(password).toHaveAttribute('type', 'text');
  });

  it('aviso de Caps Lock aparece e some, ligado à senha para o leitor de tela', async () => {
    renderLogin();
    const warning = document.getElementById('caps-lock-warning')!;
    expect(screen.getByLabelText('Senha')).toHaveAttribute('aria-describedby', 'caps-lock-warning');
    expect(warning).toHaveAttribute('aria-live', 'polite');
    expect(warning).toBeEmptyDOMElement();

    pressKeyWithCapsLock(true);
    await waitFor(() => expect(warning).toHaveTextContent('Caps Lock ativado'));
    pressKeyWithCapsLock(false);
    await waitFor(() => expect(warning).toBeEmptyDOMElement());
  });
});
