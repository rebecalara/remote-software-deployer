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
  ['Conectando a', 'Conectando'],
  ['Sessão WinRM aberta', 'Conectando'],
  ['Copiando o instalador', 'Copiando o instalador'],
  ['SHA-256 conferido', 'Conferindo o hash'],
  ['Produto ainda não instalado', 'Conferindo se já está instalado'],
  ['Não foi possível conferir se o produto', 'Conferindo se já está instalado'],
  ['Executando o instalador', 'Instalando'],
  ['O instalador terminou', 'Finalizando'],
  ['Arquivos temporários apagados', 'Finalizando'],
  ['Não foi possível apagar', 'Finalizando'],
];

export function phaseOf(target: Pick<DeploymentTarget, 'status' | 'lastLog' | 'exitCode'>): Phase {
  const message = target.lastLog?.message ?? '';
  switch (target.status) {
    case 'PENDING':
      return { label: 'Aguardando na fila', tone: 'waiting' };
    case 'RUNNING': {
      const match = RUNNING_PHASES.find(([prefix]) => message.startsWith(prefix));
      return { label: match ? match[1] : 'Em execução', tone: 'running' };
    }
    case 'SUCCEEDED':
      if (message.startsWith('Já instalado')) return { label: 'Já estava instalado', tone: 'success' };
      if (target.exitCode === 3010 || target.exitCode === 1641) return { label: 'Concluído, reinício pendente', tone: 'warning' };
      return { label: 'Concluído', tone: 'success' };
    case 'FAILED':
      return { label: 'Falhou', tone: 'danger' };
    case 'CANCELLED':
      return { label: 'Cancelado', tone: 'muted' };
  }
}
