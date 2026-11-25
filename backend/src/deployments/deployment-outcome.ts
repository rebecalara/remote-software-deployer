import { DeploymentAction, DeploymentStatus, InstallType, LogLevel } from '@prisma/client';
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
export function interpretResult(
  result: DeployResult,
  installType: InstallType,
  action: DeploymentAction = DeploymentAction.INSTALL,
): TargetOutcome {
  // Falhas primeiro: a do comando do fabricante pode trazer o código de saída.
  if ('message' in result) {
    return { status: DeploymentStatus.FAILED, level: LogLevel.ERROR, message: result.message, exitCode: result.exitCode ?? null };
  }
  // Comando do fabricante: sucesso confirmado pelo registro (a chave saiu); o código de
  // saída só informa (decisão da autora).
  if ('removed' in result) {
    return {
      status: DeploymentStatus.SUCCEEDED,
      level: LogLevel.INFO,
      message: `Desinstalação concluída: o programa saiu do registro da máquina (o desinstalador terminou com o código ${result.exitCode}).`,
      exitCode: result.exitCode,
    };
  }
  if ('exitCode' in result) {
    return { ...interpretExitCode(result.exitCode, installType, action), exitCode: result.exitCode };
  }
  if ('notInstalled' in result) {
    return {
      status: DeploymentStatus.SUCCEEDED,
      level: LogLevel.WARN,
      message: result.productCode
        ? `Não estava instalado: o produto (ProductCode ${result.productCode}) não está instalado na máquina. ` +
          'A desinstalação não foi executada.'
        : 'Não estava instalado: o programa não está mais registrado na máquina. A desinstalação não foi executada.',
      exitCode: null,
    };
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
  // Todos os formatos já foram tratados; isto só protege contra um resultado novo esquecido.
  return { status: DeploymentStatus.FAILED, level: LogLevel.ERROR, message: 'Resultado desconhecido do executor.', exitCode: null };
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

/**
 * Desinstalação (só MSI, msiexec /x). 1605 ("produto desconhecido") só acontece se o
 * produto sumiu entre a conferência e a execução: é sucesso com o aviso "não estava
 * instalado" (decisão da autora), não falha.
 */
const UNINSTALL_NOT_INSTALLED_1605 =
  'Não estava instalado: o Windows Installer não reconhece o produto na máquina (código 1605). Nada foi removido.';
const UNINSTALL_FAILURES: Record<number, string> = {
  1602: 'A desinstalação foi cancelada na máquina (código 1602).',
  1603: 'Erro fatal durante a desinstalação (código 1603).',
  1612:
    'A origem da instalação não está disponível na máquina (código 1612): o pacote em cache do Windows ' +
    'Installer pode ter sido apagado. A desinstalação não foi concluída.',
  1618: 'Outra instalação estava em andamento na máquina (código 1618). Tente de novo mais tarde.',
  1625: 'A desinstalação foi bloqueada por uma política da máquina (código 1625).',
};
const UNINSTALL_SUCCESS_WITH_REBOOT: Record<number, string> = {
  3010:
    'Desinstalação concluída. A máquina precisa ser reiniciada para concluí-la (código 3010) — ' +
    'o sistema não reinicia a máquina.',
  1641: 'Desinstalação concluída. O desinstalador iniciou o reinício da máquina (código 1641).',
};

export function interpretExitCode(
  exitCode: number,
  installType: InstallType,
  action: DeploymentAction = DeploymentAction.INSTALL,
): ExitCodeOutcome {
  if (action === DeploymentAction.UNINSTALL) {
    if (exitCode === 0) {
      return { status: DeploymentStatus.SUCCEEDED, level: LogLevel.INFO, message: 'Desinstalação concluída (código 0).' };
    }
    if (exitCode in UNINSTALL_SUCCESS_WITH_REBOOT) {
      return { status: DeploymentStatus.SUCCEEDED, level: LogLevel.WARN, message: UNINSTALL_SUCCESS_WITH_REBOOT[exitCode] };
    }
    if (exitCode === 1605) {
      return { status: DeploymentStatus.SUCCEEDED, level: LogLevel.WARN, message: UNINSTALL_NOT_INSTALLED_1605 };
    }
    return {
      status: DeploymentStatus.FAILED,
      level: LogLevel.ERROR,
      message: UNINSTALL_FAILURES[exitCode] ?? `O desinstalador terminou com o código ${exitCode}, que indica falha.`,
    };
  }
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
 * Status da implantação a partir dos alvos, como fica no BANCO. null = ainda há alvo
 * pendente ou em execução. Basta uma falha para FAILED; sem falha, qualquer cancelado
 * deixa CANCELLED. "Parcial" não é gravado: é calculado na leitura (`displayStatus`).
 */
export function aggregateDeploymentStatus(targetStatuses: DeploymentStatus[]): DeploymentStatus | null {
  if (targetStatuses.some((s) => !FINAL_STATUSES.includes(s))) return null;
  if (targetStatuses.includes(DeploymentStatus.FAILED)) return DeploymentStatus.FAILED;
  if (targetStatuses.includes(DeploymentStatus.CANCELLED)) return DeploymentStatus.CANCELLED;
  return DeploymentStatus.SUCCEEDED;
}

/**
 * Status mostrado (API e telas): o do banco, mais PARTIAL — calculado, sem status novo no
 * enum. PARTIAL = FAILED em que pelo menos uma máquina concluiu; FAILED = nenhuma concluiu.
 */
export type DeploymentDisplayStatus = DeploymentStatus | 'PARTIAL';
export const PARTIAL = 'PARTIAL' as const;

export function displayStatus(status: DeploymentStatus, counts: { succeeded: number }): DeploymentDisplayStatus {
  return status === DeploymentStatus.FAILED && counts.succeeded > 0 ? PARTIAL : status;
}
