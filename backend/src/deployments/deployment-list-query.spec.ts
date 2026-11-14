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
    });
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
  ])('recusa %p no campo %p (filtro ignorado em silêncio pareceria aplicado)', (query, field) => {
    expect(fieldOf(query)).toBe(field);
  });
});
