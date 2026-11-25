import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MissingFromAdBadge, StatusBadge, machineStatusHint } from './MachineBadges';

describe('StatusBadge — resultado da verificação da porta do WinRM', () => {
  it.each([
    ['ONLINE', 'Respondendo no WinRM', 'emerald'],
    ['OFFLINE', 'Sem resposta', 'slate'],
    ['UNKNOWN', 'Não verificado', 'slate'],
  ] as const)('%s → "%s" (nome honesto, nunca "online"), em %s', (status, label, color) => {
    render(<StatusBadge status={status} />);
    const badge = screen.getByTestId('machine-status');
    expect(badge).toHaveTextContent(label);
    expect(badge.className).toContain(`text-${color}-`);
  });

  it('máquina desligada não é erro: "Sem resposta" nunca é vermelho', () => {
    render(<StatusBadge status="OFFLINE" />);
    expect(screen.getByTestId('machine-status').className).not.toMatch(/red/);
  });

  it('com a verificação desligada (modo demonstração), tudo "Não verificado", mesmo com resultado antigo no banco', () => {
    render(<StatusBadge status="ONLINE" checkedAt="2026-11-25T10:00:00.000Z" verificationOff />);
    const badge = screen.getByTestId('machine-status');
    expect(badge).toHaveAttribute('data-status', 'UNKNOWN');
    expect(badge).toHaveAttribute('title', 'Verificação do WinRM desligada neste servidor');
  });

  it('dentro de um Tooltip não repete o title nativo', () => {
    render(<StatusBadge status="ONLINE" nativeTitle={false} />);
    expect(screen.getByTestId('machine-status')).not.toHaveAttribute('title');
  });
});

describe('machineStatusHint — texto da dica do selo', () => {
  it('nunca verificada', () => {
    expect(machineStatusHint('UNKNOWN', null, false)).toBe('A porta do WinRM (5985) ainda não foi verificada');
  });

  it('com a data e o tempo relativo', () => {
    const now = new Date(2026, 10, 25, 12, 0).getTime();
    const checked = new Date(2026, 10, 25, 11, 45).toISOString();
    expect(machineStatusHint('ONLINE', checked, false, now)).toBe('Porta do WinRM (5985) verificada há 15 min (25/11/2026 11:45)');
  });
});

describe('MissingFromAdBadge', () => {
  it('máquina que saiu do AD aparece em amarelo', () => {
    render(<MissingFromAdBadge />);
    const badge = screen.getByText('Não encontrada no AD');
    expect(badge.className).toContain('amber');
  });
});
