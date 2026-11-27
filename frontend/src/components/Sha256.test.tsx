import { render, screen, waitFor } from '@testing-library/react';
import { setupUser } from '../test/user';
import { describe, expect, it, vi } from 'vitest';
import { Sha256 } from './Sha256';

const HASH = 'a3f1c2e4b5d6978812345678901234567890abcdef1234567890abcdef12d4e5';

describe('Sha256 — hash abreviado, inteiro na dica e botão de copiar', () => {
  it('mostra 8 primeiros…8 últimos; o valor inteiro fica na dica (leitor de tela)', () => {
    render(<Sha256 value={HASH} />);
    const short = screen.getByTestId('sha256');
    expect(short).toHaveTextContent('a3f1c2e4…ef12d4e5');
    expect(short).toHaveAccessibleDescription(HASH);
  });

  it('copia o valor INTEIRO para a área de transferência e confirma', async () => {
    const user = setupUser();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    render(<Sha256 value={HASH} />);
    expect(screen.getByRole('button', { name: 'Copiar SHA-256' })).toBeInTheDocument();
    await user.click(screen.getByTestId('copy-sha256'));
    expect(writeText).toHaveBeenCalledWith(HASH);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copiado' })).toBeInTheDocument());
  });

  it('sem permissão de área de transferência, não quebra (o valor continua na dica)', async () => {
    const user = setupUser();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('negado'));
    render(<Sha256 value={HASH} />);
    await user.click(screen.getByTestId('copy-sha256'));
    expect(screen.getByRole('button', { name: 'Copiar SHA-256' })).toBeInTheDocument();
  });
});
