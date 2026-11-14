import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { DeploymentStatus, LogLevel } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InstallerStorageService } from '../software/installer-storage.service';
import { aggregateDeploymentStatus, interpretResult } from './deployment-outcome';
import { DeployResult, PowerShellExecutor } from './powershell-executor';
import { QueueItem, TargetQueue, parseMaxParallel } from './target-queue';

export const RESTART_MESSAGE_RUNNING =
  'Interrompida pela reinicialização do servidor durante a execução. Não é possível saber se o ' +
  'instalador terminou — confira a máquina.';
export const RESTART_MESSAGE_PENDING =
  'Não executada: o servidor foi reiniciado antes de chegar a vez desta máquina.';

/**
 * Executa as implantações em segundo plano (DECISIONS.md, Bloco 4). Cada máquina é um
 * item da fila em memória; para cada uma: marca RUNNING, roda o executor, grava cada
 * passo como DeploymentLog, interpreta o código de saída, grava o status final e, quando
 * todas as máquinas terminaram, o status da implantação.
 *
 * Fila por processo: com mais de uma instância do backend no mesmo banco, a
 * recuperação da subida de uma marcaria como falha o que a outra está executando.
 * Uma instância só (limitação registrada no DECISIONS.md).
 */
@Injectable()
export class DeploymentRunner implements OnApplicationBootstrap {
  private readonly logger = new Logger(DeploymentRunner.name);
  private readonly queue: TargetQueue;

  constructor(
    private readonly prisma: PrismaService,
    private readonly executor: PowerShellExecutor,
    private readonly storage: InstallerStorageService,
  ) {
    const maxParallel = parseMaxParallel(process.env.DEPLOYMENT_MAX_PARALLEL, (msg) => this.logger.warn(msg));
    this.queue = new TargetQueue(maxParallel, (item) => this.runTarget(item));
    this.logger.log(`Implantações: até ${maxParallel} máquinas em paralelo.`);
  }

  enqueue(items: QueueItem[]): void {
    this.queue.enqueue(items);
  }

  /** Para testes: resolve quando a fila esvazia. */
  whenIdle(): Promise<void> {
    return this.queue.whenIdle();
  }

  /**
   * Na subida, a fila está vazia: todo alvo PENDING ou RUNNING é resto de uma execução
   * interrompida. Vira FAILED (não há como saber se o instalador terminou), com o
   * motivo no log, e a implantação recebe o status final.
   */
  async onApplicationBootstrap(): Promise<void> {
    const orphans = await this.prisma.deploymentTarget.findMany({
      where: { status: { in: [DeploymentStatus.PENDING, DeploymentStatus.RUNNING] } },
      select: { id: true, status: true, deploymentId: true },
    });
    if (orphans.length === 0) return;

    const now = new Date();
    await this.prisma.$transaction([
      ...orphans.map((t) =>
        this.prisma.deploymentTarget.update({
          where: { id: t.id },
          data: { status: DeploymentStatus.FAILED, finishedAt: now },
        }),
      ),
      this.prisma.deploymentLog.createMany({
        data: orphans.map((t) => ({
          deploymentTargetId: t.id,
          timestamp: now,
          level: LogLevel.ERROR,
          message: t.status === DeploymentStatus.RUNNING ? RESTART_MESSAGE_RUNNING : RESTART_MESSAGE_PENDING,
        })),
      }),
    ]);
    for (const deploymentId of new Set(orphans.map((t) => t.deploymentId))) {
      await this.finalizeDeployment(deploymentId);
    }
    this.logger.warn(
      `${orphans.length} máquina(s) de implantações interrompidas pela reinicialização marcadas como falha.`,
    );
  }

  /** Processa uma máquina. Nunca lança: falha inesperada vira FAILED com log. */
  async runTarget({ targetId }: QueueItem): Promise<void> {
    let deploymentId: string | null = null;
    const log = new TargetLogWriter(this.prisma, targetId, this.logger);
    try {
      // Lido ANTES de marcar RUNNING: assim, se algo falhar daqui em diante, o
      // deploymentId já é conhecido e a implantação ainda é fechada no fim.
      const target = await this.prisma.deploymentTarget.findUniqueOrThrow({
        where: { id: targetId },
        include: { machine: true, deployment: { include: { software: true } } },
      });

      // Só quem ainda está PENDING roda: um cancelamento (que só afeta PENDING) pode
      // ter chegado enquanto o item esperava na fila. A condição no próprio UPDATE
      // fecha a corrida entre a leitura acima e este ponto.
      const claimed = await this.prisma.deploymentTarget.updateMany({
        where: { id: targetId, status: DeploymentStatus.PENDING },
        data: { status: DeploymentStatus.RUNNING, startedAt: new Date() },
      });
      if (claimed.count === 0) return;

      deploymentId = target.deploymentId;
      const software = target.deployment.software;
      const hostname = target.machine.hostname;

      await this.prisma.deployment.updateMany({
        where: { id: deploymentId, status: DeploymentStatus.PENDING },
        data: { status: DeploymentStatus.RUNNING, startedAt: new Date() },
      });

      log.write(LogLevel.INFO, `Iniciando a instalação de ${software.name} ${software.version} em ${hostname}.`);

      let result: DeployResult;
      const installerProblem = await this.installerProblem(software.installerFileName);
      if (installerProblem) {
        result = { ok: false, phase: 'validate', reason: 'invalid-input', message: installerProblem };
      } else {
        result = await this.executor.run(
          {
            targetId,
            computerName: hostname,
            installerPath: this.storage.localPath(software.installerFileName!),
            installerSizeBytes: software.installerSizeBytes ?? 0,
            sha256: software.installerSha256 ?? '',
            installType: software.installType,
            installArgs: software.installArgs,
          },
          (event) => log.write(event.level, event.message),
        );
      }

      const outcome = interpretResult(result, software.installType);
      log.write(outcome.level, outcome.message);
      await log.flush();

      await this.prisma.deploymentTarget.update({
        where: { id: targetId },
        data: { status: outcome.status, finishedAt: new Date(), exitCode: outcome.exitCode },
      });
    } catch (err) {
      this.logger.error(`Falha inesperada ao executar o alvo ${targetId}: ${(err as Error).message}`);
      await this.markFailedQuietly(targetId, log);
    }
    if (deploymentId) await this.finalizeDeploymentQuietly(deploymentId);
  }

  /**
   * Fecha a implantação quando nenhuma máquina está pendente ou em execução.
   * Idempotente: duas máquinas terminando juntas podem chamar ao mesmo tempo, e só a
   * primeira grava (finishedAt nulo na condição).
   */
  async finalizeDeployment(deploymentId: string): Promise<void> {
    const targets = await this.prisma.deploymentTarget.findMany({
      where: { deploymentId },
      select: { status: true },
    });
    const status = aggregateDeploymentStatus(targets.map((t) => t.status));
    if (status === null) return;
    await this.prisma.deployment.updateMany({
      where: { id: deploymentId, finishedAt: null },
      data: { status, finishedAt: new Date() },
    });
  }

  private async installerProblem(fileName: string | null): Promise<string | null> {
    if (!fileName) return 'O software não tem instalador enviado.';
    try {
      if (await this.storage.exists(fileName)) return null;
      return 'O arquivo do instalador não foi encontrado na pasta de instaladores do servidor.';
    } catch (err) {
      return `Não foi possível acessar o instalador no servidor: ${(err as Error).message}`;
    }
  }

  private async markFailedQuietly(targetId: string, log: TargetLogWriter): Promise<void> {
    try {
      log.write(LogLevel.ERROR, 'Erro interno do servidor durante a implantação. Confira a máquina.');
      await log.flush();
      await this.prisma.deploymentTarget.updateMany({
        where: { id: targetId, status: DeploymentStatus.RUNNING },
        data: { status: DeploymentStatus.FAILED, finishedAt: new Date() },
      });
    } catch (err) {
      this.logger.error(`Não foi possível marcar o alvo ${targetId} como falha: ${(err as Error).message}`);
    }
  }

  private async finalizeDeploymentQuietly(deploymentId: string): Promise<void> {
    try {
      await this.finalizeDeployment(deploymentId);
    } catch (err) {
      this.logger.error(`Não foi possível fechar a implantação ${deploymentId}: ${(err as Error).message}`);
    }
  }
}

/**
 * Grava os logs de um alvo em sequência, na ordem em que chegam. O timestamp é dado
 * aqui e nunca se repete (+1 ms se preciso): dois passos no mesmo milissegundo
 * ficariam em ordem indefinida na consulta por (alvo, timestamp). Uma falha ao gravar
 * um log não interrompe a instalação — só fica no log do servidor.
 */
export class TargetLogWriter {
  private chain: Promise<void> = Promise.resolve();
  private lastTimestamp = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly targetId: string,
    private readonly logger: Logger,
  ) {}

  write(level: LogLevel, message: string): void {
    const timestamp = new Date(Math.max(Date.now(), this.lastTimestamp + 1));
    this.lastTimestamp = timestamp.getTime();
    this.chain = this.chain.then(async () => {
      try {
        await this.prisma.deploymentLog.create({
          data: { deploymentTargetId: this.targetId, timestamp, level, message },
        });
      } catch (err) {
        this.logger.warn(`Log do alvo ${this.targetId} não gravado: ${(err as Error).message}`);
      }
    });
  }

  flush(): Promise<void> {
    return this.chain;
  }
}
