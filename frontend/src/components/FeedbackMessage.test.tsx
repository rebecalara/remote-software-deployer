import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FEEDBACK_AUTO_DISMISS_MS, FeedbackMessage } from './FeedbackMessage';

// Relógio simulado: os 4 s passam na hora, sem esperar de verdade.
describe('FeedbackMessage — mensagem de resultado de uma ação', () => {
  it('sucesso some sozinho em 4 s', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<FeedbackMessage feedback={{ kind: 'success', text: 'Software salvo.' }} onDismiss={onDismiss} />);
    expect(screen.getByRole('status')).toHaveTextContent('Software salvo.');
    act(() => vi.advanceTimersByTime(FEEDBACK_AUTO_DISMISS_MS - 1));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('informação ("já em andamento") também some sozinha', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<FeedbackMessage feedback={{ kind: 'info', text: 'Sincronização com o AD já em andamento.' }} onDismiss={onDismiss} />);
    act(() => vi.advanceTimersByTime(FEEDBACK_AUTO_DISMISS_MS));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('erro fica na tela (role=alert) até a pessoa fechar', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<FeedbackMessage feedback={{ kind: 'error', text: 'Sem espaço em disco no servidor.' }} onDismiss={onDismiss} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Sem espaço em disco no servidor.');
    act(() => vi.advanceTimersByTime(60_000));
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Fechar mensagem' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('com o mouse em cima, a contagem para (quem está lendo não perde o texto); ao sair, recomeça', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<FeedbackMessage feedback={{ kind: 'success', text: 'Salvo.' }} onDismiss={onDismiss} />);
    const message = screen.getByTestId('feedback');
    act(() => vi.advanceTimersByTime(3000));
    fireEvent.mouseEnter(message);
    act(() => vi.advanceTimersByTime(10_000));
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.mouseLeave(message);
    act(() => vi.advanceTimersByTime(FEEDBACK_AUTO_DISMISS_MS));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('com o foco do teclado na mensagem (no X), também para', () => {
    vi.useFakeTimers();
    const onDismiss = vi.fn();
    render(<FeedbackMessage feedback={{ kind: 'success', text: 'Salvo.' }} onDismiss={onDismiss} />);
    fireEvent.focus(screen.getByRole('button', { name: 'Fechar mensagem' }));
    act(() => vi.advanceTimersByTime(10_000));
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
