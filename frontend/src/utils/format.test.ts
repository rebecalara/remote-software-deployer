import { describe, expect, it } from 'vitest';
import { formatBytes, formatDate, formatDateTime, formatRelative, initials, roleLabel } from './format';

// Datas montadas na hora LOCAL: o teste vale em qualquer fuso (Joinville ou o CI).
const local = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();

describe('formatDateTime — padrão do sistema "dd/mm/aaaa hh:mm"', () => {
  it('data e hora separadas por espaço, sem vírgula', () => {
    expect(formatDateTime(local(2026, 11, 19, 22, 42))).toBe('19/11/2026 22:42');
  });

  it('dia, mês e hora com dois dígitos', () => {
    expect(formatDateTime(local(2026, 1, 5, 7, 3))).toBe('05/01/2026 07:03');
  });

  it('sem data, mostra um travessão', () => {
    expect(formatDateTime(null)).toBe('—');
  });
});

describe('formatRelative — tempo relativo único do sistema', () => {
  const now = new Date(2026, 10, 25, 12, 0, 0).getTime();
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();

  it.each([
    [10, 'agora'],
    [44, 'agora'],
    [60, 'há 1 min'],
    [33 * 60, 'há 33 min'],
    [59 * 60 + 59, 'há 59 min'],
    [3600, 'há 1 h'],
    [3 * 3600 + 1800, 'há 3 h'],
    [86400, 'há 1 dia'],
    [4 * 86400 + 3600, 'há 4 dias'],
  ])('%i s atrás → "%s" (minutos e horas abreviados, dias por extenso, arredondando para baixo)', (seconds, text) => {
    expect(formatRelative(ago(seconds), now)).toBe(text);
  });

  it('no futuro usa "em": a próxima rodada automática', () => {
    expect(formatRelative(new Date(now + 15 * 60 * 1000).toISOString(), now)).toBe('em 15 min');
  });

  it('sem data, travessão', () => {
    expect(formatRelative(null, now)).toBe('—');
  });
});

describe('formatBytes — base 1024, como o Windows Explorer', () => {
  it.each([
    [0, '0 bytes'],
    [512, '512 bytes'],
    [1536, '1,5 KB'],
    [1659704, '1,6 MB'],
    [150 * 1024 * 1024, '150 MB'],
    [3 * 1024 ** 3, '3,0 GB'],
  ])('%i → "%s"', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });

  it('sem tamanho (instalador não enviado), travessão', () => {
    expect(formatBytes(null)).toBe('—');
  });
});

describe('identificação do usuário no cabeçalho', () => {
  it('iniciais do primeiro e do último nome', () => {
    expect(initials('Rebeca Lara de Souza', 'rebeca')).toBe('RS');
  });

  it('um nome só: as duas primeiras letras', () => {
    expect(initials('Rebeca', 'x')).toBe('RE');
  });

  it('sem nome de exibição: as duas primeiras letras do usuário', () => {
    expect(initials('  ', 'testuser')).toBe('TE');
    expect(initials(undefined, undefined)).toBe('?');
  });

  it('perfil em português', () => {
    expect(roleLabel('ADMIN')).toBe('Administrador');
    expect(roleLabel('OPERATOR')).toBe('Operador');
    expect(roleLabel('VIEWER')).toBe('Visualizador');
  });

  it('data curta', () => {
    expect(formatDate(local(2026, 11, 25))).toBe('25/11/2026');
    expect(formatDate(null)).toBe('—');
  });
});
