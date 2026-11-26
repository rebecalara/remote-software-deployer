import type { DeploymentTarget } from '../../types/deployment';

// Fase atual de uma máquina, no lugar de uma porcentagem (o msiexec não informa
// progresso). Vem do status do alvo e do ÚLTIMO passo registrado (lastLog). Os prefixos
// abaixo são as mensagens de backend/scripts/deploy-target.ps1 e de
// backend/src/deployments/deployment-runner.ts — manter em sincronia com elas. Uma
// mensagem que não casar com nenhum prefixo cai em "Em execução", sem quebrar a tela.

export type PhaseTone = 'waiting' | 'running' | 'success' | 'warning' | 'danger' | 'muted';

export interface Phase {
  label: string;
  tone: PhaseTone;
}

const RUNNING_PHASES: Array<[prefix: string, label: string]> = [
  ['Iniciando a instalação', 'Iniciando'],
  ['Iniciando a desinstalação', 'Iniciando'],
  ['Conectando a', 'Conectando'],
  ['Sessão WinRM aberta', 'Conectando'],
  ['Copiando o instalador', 'Copiando o instalador'],
  ['SHA-256 conferido', 'Conferindo o hash'],
  ['Produto ainda não instalado', 'Conferindo se já está instalado'],
  ['Não foi possível conferir se o produto', 'Conferindo se já está instalado'],
  ['Executando o instalador', 'Instalando'],
  ['O instalador terminou', 'Finalizando'],
  // Desinstalação (só MSI): nada é copiado.
  ['Produto instalado na máquina', 'Conferindo se está instalado'],
  ['Executando a desinstalação', 'Desinstalando'],
  // Comando do fabricante (programa que não é MSI).
  ['Comando de desinstalação conferido', 'Conferindo o comando'],
  ['Assinatura do executável', 'Conferindo o comando'],
  ['Executando o desinstalador do fabricante', 'Desinstalando'],
  ['O desinstalador terminou', 'Finalizando'],
  ['Arquivos temporários apagados', 'Finalizando'],
  ['Não foi possível apagar', 'Finalizando'],
];

export function phaseOf(target: Pick<DeploymentTarget, 'status' | 'lastLog' | 'exitCode'>): Phase {
  const message = target.lastLog?.message ?? '';
  switch (target.status) {
    case 'PENDING':
      return { label: 'Aguardando na fila', tone: 'waiting' };
    case 'RUNNING': {
      // Comando do fabricante: depois que o processo termina, espera a chave sair do registro.
      if (message.includes('Conferindo se o programa saiu do registro')) return { label: 'Confirmando a remoção', tone: 'running' };
      const match = RUNNING_PHASES.find(([prefix]) => message.startsWith(prefix));
      return { label: match ? match[1] : 'Em execução', tone: 'running' };
    }
    case 'SUCCEEDED':
      if (message.startsWith('Já instalado')) return { label: 'Já estava instalado', tone: 'success' };
      if (message.startsWith('Não estava instalado')) return { label: 'Não estava instalado', tone: 'success' };
      if (target.exitCode === 3010 || target.exitCode === 1641) return { label: 'Concluído, reinício pendente', tone: 'warning' };
      return { label: 'Concluído', tone: 'success' };
    case 'FAILED':
      return { label: 'Falhou', tone: 'danger' };
    case 'CANCELLED':
      return { label: 'Cancelado', tone: 'muted' };
  }
}
