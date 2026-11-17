import { BadRequestException } from '@nestjs/common';
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, parseDeploymentListQuery } from './deployment-validation';

// Bloco 6: filtros e paginação de GET /deployments.

const SW = '11111111-1111-4111-8111-111111111111';

function fieldOf(query: Record<string, unknown>): string {
  try {
    parseDeploymentListQuery(query);
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return ((err as BadRequestException).getResponse() as { field: string }).field;
  }
  throw new Error('deveria ter recusado');
}

describe('parseDeploymentListQuery', () => {
  it('sem parâmetros: primeira página, tamanho padrão, sem filtros', () => {
    expect(parseDeploymentListQuery({})).toEqual({
      page: 1,
      pageSize: DEFAULT_PAGE_SIZE,
      status: null,
      softwareId: null,
      machine: null,
      from: null,
      to: null,
      mine: false,
      state: null,
      finishedFrom: null,
    });
  });

  it('state e finishedFrom: em andamento, encerradas e encerradas a partir de um instante', () => {
    expect(parseDeploymentListQuery({ state: 'active' }).state).toBe('active');
    expect(parseDeploymentListQuery({ state: 'finished', finishedFrom: '2026-11-15T12:00:00Z' })).toMatchObject({
      state: 'finished',
      finishedFrom: new Date('2026-11-15T12:00:00Z'),
    });
  });

  it('parâmetro vazio é o mesmo que ausente', () => {
    expect(parseDeploymentListQuery({ status: '', machine: '  ', from: '' })).toMatchObject({
      status: null,
      machine: null,
      from: null,
    });
  });

  it('aceita todos os filtros válidos', () => {
    expect(
      parseDeploymentListQuery({
        page: '2',
        pageSize: '50',
        status: 'SUCCEEDED',
        softwareId: SW.toUpperCase(),
        machine: 'WS-ADM',
        from: '2026-11-01T03:00:00.000Z',
        to: '2026-11-02T03:00:00.000Z',
      }),
    ).toEqual({
      page: 2,
      pageSize: 50,
      status: 'SUCCEEDED',
      softwareId: SW,
      machine: 'WS-ADM',
      from: new Date('2026-11-01T03:00:00.000Z'),
      to: new Date('2026-11-02T03:00:00.000Z'),
      mine: false,
      state: null,
      finishedFrom: null,
    });
  });

  it('mine=true liga o filtro "minhas"; mine=false ou ausente, desliga', () => {
    expect(parseDeploymentListQuery({ mine: 'true' }).mine).toBe(true);
    expect(parseDeploymentListQuery({ mine: 'false' }).mine).toBe(false);
    expect(parseDeploymentListQuery({ mine: '' }).mine).toBe(false);
  });

  it('nenhum id de usuário vindo da query entra no resultado', () => {
    const parsed = parseDeploymentListQuery({ mine: 'true', userId: 'outro', user: 'outro' });
    expect(Object.values(parsed)).not.toContain('outro');
  });

  it.each([
    [{ page: '0' }, 'page'],
    [{ page: '1.5' }, 'page'],
    [{ page: 'abc' }, 'page'],
    [{ pageSize: '0' }, 'pageSize'],
    [{ pageSize: String(MAX_PAGE_SIZE + 1) }, 'pageSize'],
    [{ status: 'DONE' }, 'status'],
    [{ status: 'succeeded' }, 'status'],
    [{ softwareId: '7-zip' }, 'softwareId'],
    [{ machine: 'x'.repeat(65) }, 'machine'],
    [{ from: '2026-11-01' }, 'from'],
    [{ from: 'ontem' }, 'from'],
    [{ to: '2026-13-45T00:00:00Z' }, 'to'],
    [{ from: '2026-11-02T00:00:00Z', to: '2026-11-01T00:00:00Z' }, 'to'],
    [{ from: '2026-11-01T00:00:00Z', to: '2026-11-01T00:00:00Z' }, 'to'],
    [{ status: ['FAILED', 'SUCCEEDED'] }, 'status'],
    [{ mine: '1' }, 'mine'],
    [{ state: 'RUNNING' }, 'state'],
    [{ state: 'done' }, 'state'],
    [{ finishedFrom: 'ontem' }, 'finishedFrom'],
    [{ state: 'active', finishedFrom: '2026-11-15T12:00:00Z' }, 'finishedFrom'],
    [{ mine: 'yes' }, 'mine'],
    [{ mine: ['true', 'true'] }, 'mine'],
  ])('recusa %p no campo %p (filtro ignorado em silêncio pareceria aplicado)', (query, field) => {
    expect(fieldOf(query)).toBe(field);
  });
});
