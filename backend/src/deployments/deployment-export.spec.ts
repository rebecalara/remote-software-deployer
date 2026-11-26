import { BadRequestException, INestApplication } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../auth/roles.decorator';
import {
  EXPORT_COLUMNS,
  EXPORT_MAX_ROWS,
  EXPORT_TOO_MANY,
  csvCell,
  exportFileName,
  formatDateTimeSaoPaulo,
  formatDurationText,
  targetResultLabel,
  toCsv,
} from './deployment-export';
import { parseDeploymentListQuery } from './deployment-validation';
import { DeploymentsController } from './deployments.controller';
import { DeploymentsService, deploymentListWhere } from './deployments.service';

// Exportação do Histórico em CSV (Excel em português): uma linha por máquina de cada
// implantação, com os mesmos filtros e a mesma validação da listagem.

const BOM = '﻿';
const ME = '88888888-8888-4888-8888-888888888888';
const SW = '11111111-1111-4111-8111-111111111111';
const at = (iso: string) => new Date(iso);

describe('csvCell (Excel em português: ";" e aspas)', () => {
  it.each([
    ['7-Zip', '7-Zip'],
    ['com;ponto e vírgula', '"com;ponto e vírgula"'],
    ['aspas "dentro"', '"aspas ""dentro"""'],
    ['quebra\nde linha', '"quebra\nde linha"'],
    ['', ''],
  ])('%p → %p', (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });

  it('nulo vira célula vazia; número fica como está', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(0)).toBe('0');
    expect(csvCell(-1603)).toBe('-1603');
  });

  it.each([
    ['=1+1', "'=1+1"],
    ['+cmd', "'+cmd"],
    ['-2+3+cmd|\' /C calc\'!A0', "'-2+3+cmd|' /C calc'!A0"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\tTAB', "'\tTAB"],
    ['\rCR', '"\'\rCR"'],
    ['=HYPERLINK("http://x";"y")', '"\'=HYPERLINK(""http://x"";""y"")"'],
  ])('injeção de fórmula: %p recebe apóstrofo → %p', (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });
});

describe('toCsv', () => {
  it('começa com o BOM do UTF-8, separa por ";" e termina cada linha com CRLF', () => {
    const csv = toCsv([['a', 'b;c'], [1, null]]);
    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv).toBe(`${BOM}${EXPORT_COLUMNS.join(';')}\r\na;"b;c"\r\n1;\r\n`);
  });
});

describe('formatos', () => {
  it('data e hora em America/Sao_Paulo, "dd/mm/aaaa hh:mm"', () => {
    expect(formatDateTimeSaoPaulo(at('2026-11-20T01:30:00Z'))).toBe('19/11/2026 22:30');
    expect(formatDateTimeSaoPaulo(at('2026-11-20T15:05:59Z'))).toBe('20/11/2026 12:05');
    expect(formatDateTimeSaoPaulo(null)).toBe('');
  });

  it('nome do arquivo com a data de São Paulo', () => {
    expect(exportFileName(at('2026-11-25T02:00:00Z'))).toBe('rsd-historico-2026-11-24.csv');
    expect(exportFileName(at('2026-11-25T12:00:00Z'))).toBe('rsd-historico-2026-11-25.csv');
  });

  it('duração legível, como nas telas', () => {
    expect(formatDurationText(at('2026-11-20T10:00:00Z'), at('2026-11-20T10:00:04Z'))).toBe('4 s');
    expect(formatDurationText(at('2026-11-20T10:00:00Z'), at('2026-11-20T10:01:05Z'))).toBe('1 min 5 s');
    expect(formatDurationText(at('2026-11-20T10:00:00Z'), at('2026-11-20T11:02:00Z'))).toBe('1 h 2 min');
    expect(formatDurationText(null, at('2026-11-20T10:00:00Z'))).toBe('');
  });

  it('resultado na máquina', () => {
    expect(targetResultLabel({ status: 'SUCCEEDED', exitCode: 0, lastMessage: 'Instalação concluída (código 0).' })).toBe('Concluído');
    expect(targetResultLabel({ status: 'SUCCEEDED', exitCode: null, lastMessage: 'Já instalado: o produto…' })).toBe('Já estava instalado');
    expect(targetResultLabel({ status: 'SUCCEEDED', exitCode: null, lastMessage: 'Não estava instalado: …' })).toBe('Não estava instalado');
    expect(targetResultLabel({ status: 'SUCCEEDED', exitCode: 3010, lastMessage: '' })).toBe('Concluído, reinício pendente');
    expect(targetResultLabel({ status: 'FAILED', exitCode: 1603, lastMessage: '' })).toBe('Falhou');
    expect(targetResultLabel({ status: 'CANCELLED', exitCode: null, lastMessage: null })).toBe('Cancelado');
  });
});

// ---------- service ----------

function target(hostname: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    status,
    exitCode: null,
    startedAt: at('2026-11-20T13:00:00Z'),
    finishedAt: at('2026-11-20T13:00:04Z'),
    machine: { hostname },
    logs: [],
    ...extra,
  };
}

function deployment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'd1',
    name: '7-Zip 26.06 — 2 máquinas',
    action: 'INSTALL',
    status: 'FAILED',
    createdAt: at('2026-11-20T12:59:00Z'),
    startedAt: at('2026-11-20T13:00:00Z'),
    finishedAt: at('2026-11-20T13:00:10Z'),
    software: { id: SW, name: '7-Zip', version: '26.06', installType: 'MSI' },
    productCode: null,
    productName: null,
    productVersion: null,
    productPublisher: null,
    uninstallCommand: null,
    user: { username: 'testuser', displayName: 'Test User' },
    targets: [
      target('WS-ADM-001', 'SUCCEEDED', { exitCode: 0 }),
      target('WS-ADM-002', 'FAILED', { exitCode: 1603 }),
    ],
    ...overrides,
  };
}

function setup() {
  const prisma = {
    deployment: { findMany: jest.fn() },
    deploymentTarget: { count: jest.fn() },
  };
  const service = new DeploymentsService(prisma as never, {} as never, {} as never, {} as never);
  return { prisma, service };
}

const lines = (csv: string) => csv.replace(BOM, '').split('\r\n').filter((l) => l !== '');

describe('DeploymentsService.exportCsv', () => {
  it('usa os MESMOS filtros da listagem (where idêntico), sem paginar, na mesma ordem', async () => {
    const { prisma, service } = setup();
    prisma.deploymentTarget.count.mockResolvedValue(2);
    prisma.deployment.findMany.mockResolvedValue([deployment()]);
    const query = parseDeploymentListQuery({
      state: 'finished',
      status: 'PARTIAL',
      action: 'INSTALL',
      softwareId: SW,
      machine: 'ws-adm',
      from: '2026-11-01T03:00:00.000Z',
      to: '2026-11-21T03:00:00.000Z',
      page: '3',
      pageSize: '10',
    });
    await service.exportCsv(query, ME);

    const where = deploymentListWhere(query, ME);
    expect(prisma.deploymentTarget.count).toHaveBeenCalledWith({ where: { deployment: where } });
    const args = prisma.deployment.findMany.mock.calls[0][0];
    expect(args.where).toEqual(where);
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(args).not.toHaveProperty('skip');
    expect(args).not.toHaveProperty('take');
  });

  it('"Minhas": o usuário vem de quem pediu (o do token), nunca da query', async () => {
    const { prisma, service } = setup();
    prisma.deploymentTarget.count.mockResolvedValue(0);
    prisma.deployment.findMany.mockResolvedValue([]);
    await service.exportCsv(parseDeploymentListQuery({ mine: 'true', userId: 'outro' }), ME);
    expect(prisma.deployment.findMany.mock.calls[0][0].where).toEqual({ userId: ME });
  });

  it('uma linha por máquina, colunas na ordem pedida, valores em português', async () => {
    const { prisma, service } = setup();
    prisma.deploymentTarget.count.mockResolvedValue(3);
    prisma.deployment.findMany.mockResolvedValue([
      deployment(),
      deployment({
        id: 'd2',
        action: 'UNINSTALL',
        status: 'SUCCEEDED',
        software: null,
        productCode: '{AAAA}',
        productName: 'PuTTY release 0.85 (64-bit)',
        productVersion: '0.85.0.0',
        user: { username: 'operador', displayName: null },
        targets: [target('RSD-ALVO-01', 'SUCCEEDED', { exitCode: null, logs: [{ message: 'Não estava instalado: …' }] })],
      }),
    ]);
    const { csv, fileName } = await service.exportCsv(parseDeploymentListQuery({}), ME, at('2026-11-25T12:00:00Z'));

    expect(fileName).toBe('rsd-historico-2026-11-25.csv');
    expect(csv.startsWith(BOM)).toBe(true);
    expect(lines(csv)).toEqual([
      'Software;Versão;Ação;Fora do catálogo;Status da implantação;Máquina;Resultado na máquina;Código de saída;Solicitada por;Criada em;Início;Fim;Duração',
      '7-Zip;26.06;Instalação;Não;Parcial;WS-ADM-001;Concluído;0;Test User;20/11/2026 09:59;20/11/2026 10:00;20/11/2026 10:00;4 s',
      '7-Zip;26.06;Instalação;Não;Parcial;WS-ADM-002;Falhou;1603;Test User;20/11/2026 09:59;20/11/2026 10:00;20/11/2026 10:00;4 s',
      'PuTTY release 0.85 (64-bit);0.85.0.0;Desinstalação;Sim;Concluído;RSD-ALVO-01;Não estava instalado;;operador;20/11/2026 09:59;20/11/2026 10:00;20/11/2026 10:00;4 s',
    ]);
    // Sem logs: só o último passo é lido, para o "Resultado na máquina".
    const include = prisma.deployment.findMany.mock.calls[0][0].include;
    expect(include.targets.include.logs).toEqual({ orderBy: { timestamp: 'desc' }, take: 1, select: { message: true } });
  });

  it('nome de produto malicioso no inventário não vira fórmula no Excel', async () => {
    const { prisma, service } = setup();
    prisma.deploymentTarget.count.mockResolvedValue(1);
    prisma.deployment.findMany.mockResolvedValue([
      deployment({
        status: 'SUCCEEDED',
        software: null,
        productCode: '{B}',
        productName: '=HYPERLINK("http://x";"clique")',
        targets: [target('WS-1', 'SUCCEEDED')],
      }),
    ]);
    const { csv } = await service.exportCsv(parseDeploymentListQuery({}), ME);
    expect(lines(csv)[1].startsWith('"\'=HYPERLINK(""http://x"";""clique"")";')).toBe(true);
  });

  it(`acima de ${EXPORT_MAX_ROWS} linhas: 400 "${EXPORT_TOO_MANY}" sem ler as implantações`, async () => {
    const { prisma, service } = setup();
    prisma.deploymentTarget.count.mockResolvedValue(EXPORT_MAX_ROWS + 1);
    const err = await service.exportCsv(parseDeploymentListQuery({}), ME).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toMatchObject({ statusCode: 400, message: EXPORT_TOO_MANY });
    expect(prisma.deployment.findMany).not.toHaveBeenCalled();
  });

  it(`exatamente ${EXPORT_MAX_ROWS} linhas ainda exporta`, async () => {
    const { prisma, service } = setup();
    prisma.deploymentTarget.count.mockResolvedValue(EXPORT_MAX_ROWS);
    prisma.deployment.findMany.mockResolvedValue([]);
    await expect(service.exportCsv(parseDeploymentListQuery({}), ME)).resolves.toMatchObject({ fileName: expect.any(String) });
  });

  it('filtro inválido = 400, como na listagem (a mesma validação)', () => {
    expect(() => parseDeploymentListQuery({ status: 'QUALQUER' })).toThrow(BadRequestException);
  });
});

// ---------- rota HTTP (app Nest de verdade, guard JWT de verdade) ----------

describe('GET /deployments/export', () => {
  const SECRET = 'segredo-so-do-teste';
  let app: INestApplication;
  let base: string;
  const exportCsv = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: SECRET })],
      controllers: [DeploymentsController],
      providers: [{ provide: DeploymentsService, useValue: { exportCsv } }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    base = base.replace('[::1]', '127.0.0.1');
  });
  afterAll(() => app.close());
  beforeEach(() => exportCsv.mockReset());

  it('sem login: 401, e o service nem é chamado', async () => {
    const res = await fetch(`${base}/deployments/export`);
    expect(res.status).toBe(401);
    expect(exportCsv).not.toHaveBeenCalled();
  });

  it.each([UserRole.VIEWER, UserRole.OPERATOR, UserRole.ADMIN])('%s logado: 200 com o arquivo CSV', async (role) => {
    exportCsv.mockResolvedValue({ fileName: 'rsd-historico-2026-11-25.csv', csv: `${BOM}a;b\r\n` });
    const token = await new JwtService({ secret: SECRET }).signAsync({ sub: ME, username: 'quem', role });
    const res = await fetch(`${base}/deployments/export?mine=true&status=FAILED&userId=outro`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="rsd-historico-2026-11-25.csv"');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // BOM do UTF-8
    const [query, userId] = exportCsv.mock.calls[0];
    expect(query).toMatchObject({ mine: true, status: 'FAILED' });
    expect(userId).toBe(ME); // do token, não do ?userId=
  });

  it('filtro inválido: 400 com o campo, antes de consultar', async () => {
    const token = await new JwtService({ secret: SECRET }).signAsync({ sub: ME, username: 'quem', role: UserRole.VIEWER });
    const res = await fetch(`${base}/deployments/export?status=QUALQUER`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: 'status' });
    expect(exportCsv).not.toHaveBeenCalled();
  });

  it('leitura para qualquer usuário logado (sem @Roles) e declarada ANTES de :id', () => {
    expect(new Reflector().get<UserRole[] | undefined>(ROLES_KEY, DeploymentsController.prototype.exportCsv)).toBeUndefined();
    const methods = Object.getOwnPropertyNames(DeploymentsController.prototype);
    expect(methods.indexOf('exportCsv')).toBeGreaterThan(-1);
    expect(methods.indexOf('exportCsv')).toBeLessThan(methods.indexOf('get'));
    expect(Reflect.getMetadata(PATH_METADATA, DeploymentsController.prototype.exportCsv)).toBe('export');
  });
});
