import { DeploymentStatus, InstallType, LogLevel } from '@prisma/client';
import type { DeployResult } from './powershell-executor';

// Regras de resultado (DECISIONS.md, Bloco 4: "códigos de saída, reinício e
// cancelamento"). Funções puras — o executor só devolve o número; aqui se decide o
// que ele significa.

export interface ExitCodeOutcome {
  status: typeof DeploymentStatus.SUCCEEDED | typeof DeploymentStatus.FAILED;
  level: LogLevel;
  message: string;
}

export interface TargetOutcome extends ExitCodeOutcome {
  /** O que vai para DeploymentTarget.exitCode: null quando nada foi executado. */
  exitCode: number | null;
}

/**
 * Resultado do executor → status, log final e código gravado no alvo.
 * (`'x' in result` em vez de `result.ok`: sem strictNullChecks — tsconfig com
 * strict: false — o TypeScript não estreita a união pelo campo booleano.)
 */
export function interpretResult(result: DeployResult, installType: InstallType): TargetOutcome {
  if ('exitCode' in result) {
    return { ...interpretExitCode(result.exitCode, installType), exitCode: result.exitCode };
  }
  if ('alreadyInstalled' in result) {
    return {
      status: DeploymentStatus.SUCCEEDED,
      level: LogLevel.WARN,
      message:
        `Já instalado: o produto deste pacote (ProductCode ${result.productCode}) já está instalado na ` +
        'máquina. A instalação não foi executada.',
      exitCode: null,
    };
  }
  return { status: DeploymentStatus.FAILED, level: LogLevel.ERROR, message: result.message, exitCode: null };
}

/** Sucesso com reinício pendente ou iniciado: vale para MSI e EXE. */
const SUCCESS_WITH_REBOOT: Record<number, string> = {
  3010:
    'Instalação concluída. A máquina precisa ser reiniciada para concluí-la (código 3010) — ' +
    'o sistema não reinicia a máquina.',
  1641: 'Instalação concluída. O instalador iniciou o reinício da máquina (código 1641).',
};

/**
 * Códigos do Windows Installer. Só se aplicam a MSI: um EXE (Inno Setup, NSIS…) usa
 * códigos próprios, e dar a eles o significado do msiexec seria inventar diagnóstico.
 */
const MSI_FAILURES: Record<number, string> = {
  1602: 'A instalação foi cancelada na máquina (código 1602).',
  1603:
    'Erro fatal durante a instalação (código 1603). O produto pode já estar instalado na máquina ' +
    'ou ter uma instalação anterior incompleta.',
  1618: 'Outra instalação estava em andamento na máquina (código 1618). Tente de novo mais tarde.',
  1619: 'O pacote de instalação não pôde ser aberto na máquina (código 1619).',
  1625: 'A instalação foi bloqueada por uma política da máquina (código 1625).',
  1638: 'Outra versão deste produto já está instalada na máquina (código 1638).',
};

export function interpretExitCode(exitCode: number, installType: InstallType): ExitCodeOutcome {
  if (exitCode === 0) {
    return { status: DeploymentStatus.SUCCEEDED, level: LogLevel.INFO, message: 'Instalação concluída (código 0).' };
  }
  if (exitCode in SUCCESS_WITH_REBOOT) {
    return { status: DeploymentStatus.SUCCEEDED, level: LogLevel.WARN, message: SUCCESS_WITH_REBOOT[exitCode] };
  }
  const known = installType === InstallType.MSI ? MSI_FAILURES[exitCode] : undefined;
  return {
    status: DeploymentStatus.FAILED,
    level: LogLevel.ERROR,
    message: known ?? `O instalador terminou com o código ${exitCode}, que indica falha.`,
  };
}

export const FINAL_STATUSES: readonly DeploymentStatus[] = [
  DeploymentStatus.SUCCEEDED,
  DeploymentStatus.FAILED,
  DeploymentStatus.CANCELLED,
];

/**
 * Status da implantação a partir dos alvos. null = ainda há alvo pendente ou em
 * execução. Sem status PARTIAL (decisão aprovada): basta uma falha para FAILED; a
 * tela mostra a contagem. Sem falha, qualquer cancelado deixa CANCELLED.
 */
export function aggregateDeploymentStatus(targetStatuses: DeploymentStatus[]): DeploymentStatus | null {
  if (targetStatuses.some((s) => !FINAL_STATUSES.includes(s))) return null;
  if (targetStatuses.includes(DeploymentStatus.FAILED)) return DeploymentStatus.FAILED;
  if (targetStatuses.includes(DeploymentStatus.CANCELLED)) return DeploymentStatus.CANCELLED;
  return DeploymentStatus.SUCCEEDED;
}
