import {
  BadRequestException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { parseInstallerUploadHeaders } from './installer-upload-headers';

const MAX = 500 * 1024 * 1024;
const valid = {
  'content-type': 'application/octet-stream',
  'content-length': '1659704',
  'x-file-name': '7z2606-x64.exe',
};

describe('parseInstallerUploadHeaders', () => {
  it('devolve o nome original quando os cabeçalhos são válidos', () => {
    expect(parseInstallerUploadHeaders(valid, MAX)).toBe('7z2606-x64.exe');
  });

  it('decodifica acentos e espaços (encodeURIComponent)', () => {
    const name = encodeURIComponent('Instalação Reader (x64).exe');
    expect(parseInstallerUploadHeaders({ ...valid, 'x-file-name': name }, MAX)).toBe(
      'Instalação Reader (x64).exe',
    );
  });

  it.each([
    ['C:\\Users\\fulano\\Downloads\\7z.exe', 'Windows'],
    ['/home/fulano/7z.exe', 'Unix'],
    ['..\\..\\7z.exe', 'relativo'],
  ])('guarda só o nome, nunca o caminho de quem enviou (%s, %s)', (path) => {
    expect(parseInstallerUploadHeaders({ ...valid, 'x-file-name': encodeURIComponent(path) }, MAX)).toBe('7z.exe');
  });

  it('aceita Content-Type com parâmetros e outra caixa', () => {
    expect(
      parseInstallerUploadHeaders({ ...valid, 'content-type': 'Application/Octet-Stream; charset=binary' }, MAX),
    ).toBe('7z2606-x64.exe');
  });

  it('sem Content-Length (envio em partes) é aceito: o limite vale durante a gravação', () => {
    const { 'content-length': _ignored, ...withoutLength } = valid;
    expect(parseInstallerUploadHeaders(withoutLength, MAX)).toBe('7z2606-x64.exe');
  });

  it('413 pelo Content-Length, antes de ler o corpo', () => {
    expect(() => parseInstallerUploadHeaders({ ...valid, 'content-length': String(MAX + 1) }, MAX)).toThrow(
      PayloadTooLargeException,
    );
  });

  it('exatamente no limite é aceito', () => {
    expect(parseInstallerUploadHeaders({ ...valid, 'content-length': String(MAX) }, MAX)).toBe('7z2606-x64.exe');
  });

  it.each([
    [undefined],
    ['application/json'],
    ['multipart/form-data; boundary=x'],
    ['application/x-msdownload'],
  ])('415 para Content-Type %p', (contentType) => {
    expect(() => parseInstallerUploadHeaders({ ...valid, 'content-type': contentType }, MAX)).toThrow(
      UnsupportedMediaTypeException,
    );
  });

  it.each([
    ['Content-Length 0', { 'content-length': '0' }],
    ['Content-Length negativo', { 'content-length': '-1' }],
    ['Content-Length não numérico', { 'content-length': 'abc' }],
    ['sem X-File-Name', { 'x-file-name': undefined }],
    ['X-File-Name vazio', { 'x-file-name': '   ' }],
    ['X-File-Name mal codificado', { 'x-file-name': '%E0%A4%A' }],
    ['X-File-Name só com caminho', { 'x-file-name': encodeURIComponent('C:\\pasta\\') }],
    ['X-File-Name com quebra de linha', { 'x-file-name': encodeURIComponent('a\nb.exe') }],
    ['X-File-Name longo demais', { 'x-file-name': 'a'.repeat(252) + '.exe' }],
  ])('400: %s', (_caso, override) => {
    expect(() => parseInstallerUploadHeaders({ ...valid, ...override }, MAX)).toThrow(BadRequestException);
  });
});
