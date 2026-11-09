import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import {
  InstallerStorageService,
  InstallerStorageUnavailableError,
  InstallerTooLargeError,
  InvalidInstallerHeaderError,
  InvalidStoredFileNameError,
  parseMaxSizeMb,
  resolveStorageDir,
} from './installer-storage.service';

// fs/promises do Node 22 não aceita jest.spyOn (propriedades não configuráveis):
// o módulo é substituído por uma cópia cujo rename é um jest.fn que, por padrão,
// chama o rename real.
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual('node:fs/promises');
  return { ...actual, rename: jest.fn(actual.rename) };
});
const realRename = jest.requireActual('node:fs/promises').rename;
const renameMock = fsp.rename as unknown as jest.Mock;

// Pastas SEMPRE temporárias do sistema, criadas e apagadas por cada teste —
// nunca C:\rsd-data nem nada dentro do repositório.

const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const MZ = Buffer.from('MZ');
const CHUNK = 64 * 1024;

/** Arquivo "instalador" falso: assinatura + bytes pseudoaleatórios determinísticos. */
function fakeInstaller(header: Buffer, totalBytes: number): Buffer {
  const body = Buffer.alloc(totalBytes - header.length);
  for (let i = 0; i < body.length; i++) body[i] = (i * 31 + 7) & 0xff;
  return Buffer.concat([header, body]);
}

/** Stream em pedaços de 64 KB que conta quantos pedaços foram lidos. */
function chunked(data: Buffer, options: { failAfterChunks?: number } = {}) {
  const counter = { chunksRead: 0 };
  const stream = new Readable({
    read() {
      const start = counter.chunksRead * CHUNK;
      if (options.failAfterChunks !== undefined && counter.chunksRead === options.failAfterChunks) {
        this.destroy(new Error('conexão caiu no meio do envio'));
        return;
      }
      if (start >= data.length) {
        this.push(null);
        return;
      }
      counter.chunksRead++;
      this.push(data.subarray(start, start + CHUNK));
    },
  });
  return { stream, counter };
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex').toUpperCase();

describe('InstallerStorageService', () => {
  const ORIGINAL_ENV = process.env;
  let dir: string;

  async function createService(maxMb?: string) {
    process.env = { ...ORIGINAL_ENV, INSTALLER_STORAGE_DIR: dir };
    if (maxMb === undefined) delete process.env.INSTALLER_MAX_SIZE_MB;
    else process.env.INSTALLER_MAX_SIZE_MB = maxMb;
    const service = new InstallerStorageService();
    await service.onModuleInit();
    return service;
  }

  /** Tudo o que existe na pasta, inclusive dentro de .tmp. */
  async function filesOnDisk(): Promise<string[]> {
    const top = (await fsp.readdir(dir)).filter((n) => n !== '.tmp');
    const tmp = (await fsp.readdir(join(dir, '.tmp'))).map((n) => `.tmp/${n}`);
    return [...top, ...tmp].sort();
  }

  beforeEach(async () => {
    renameMock.mockReset().mockImplementation(realRename);
    dir = await fsp.mkdtemp(join(tmpdir(), 'rsd-installers-test-'));
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    process.env = ORIGINAL_ENV;
    await fsp.rm(dir, { recursive: true, force: true });
  });

  describe('save', () => {
    it('grava um MSI válido com nome gerado, tamanho e SHA-256 corretos', async () => {
      const service = await createService();
      const data = fakeInstaller(OLE, 3 * 1024 * 1024 + 123);

      const result = await service.save(chunked(data).stream, 'MSI');

      expect(result.fileName).toMatch(/^[0-9a-f-]{36}\.msi$/);
      expect(result.sizeBytes).toBe(data.length);
      expect(result.sha256).toBe(sha256(data));
      expect(result.sha256).toMatch(/^[0-9A-F]{64}$/);
      // Compara por hash: toEqual em Buffer de MB é lento demais no Jest.
      expect(sha256(await fsp.readFile(join(dir, result.fileName)))).toBe(sha256(data));
      expect(await filesOnDisk()).toEqual([result.fileName]); // nenhum .part sobrando
    });

    it('grava um EXE válido com extensão .exe (vinda do tipo, não do nome original)', async () => {
      const service = await createService();
      const data = fakeInstaller(MZ, 200_000);

      const result = await service.save(chunked(data).stream, 'EXE');

      expect(result.fileName).toMatch(/^[0-9a-f-]{36}\.exe$/);
      expect(result.sha256).toBe(sha256(data));
    });

    it('gera nomes diferentes para dois envios do mesmo arquivo', async () => {
      const service = await createService();
      const data = fakeInstaller(MZ, 10_000);
      const a = await service.save(chunked(data).stream, 'EXE');
      const b = await service.save(chunked(data).stream, 'EXE');
      expect(a.fileName).not.toBe(b.fileName);
      expect(a.sha256).toBe(b.sha256);
    });

    it.each([
      ['EXE com conteúdo de MSI', 'EXE', OLE],
      ['MSI com conteúdo de EXE', 'MSI', MZ],
      ['MSI que na verdade é PDF', 'MSI', Buffer.from('%PDF-1.7')],
      ['EXE que na verdade é ZIP', 'EXE', Buffer.from('PK\x03\x04')],
    ] as const)('recusa %s, aborta logo no início e não deixa arquivo', async (_caso, type, header) => {
      const service = await createService();
      const { stream, counter } = chunked(fakeInstaller(header, 100 * CHUNK)); // ~6,4 MB

      await expect(service.save(stream, type)).rejects.toThrow(InvalidInstallerHeaderError);

      // Abortou no primeiro pedaço (com margem para o buffer interno do stream),
      // em vez de ler os 100 pedaços.
      expect(counter.chunksRead).toBeLessThan(5);
      expect(await filesOnDisk()).toEqual([]);
    });

    it('recusa arquivo vazio ou menor que a assinatura', async () => {
      const service = await createService();
      await expect(service.save(Readable.from([]), 'EXE')).rejects.toThrow(InvalidInstallerHeaderError);
      await expect(service.save(Readable.from([Buffer.from([0xd0, 0xcf])]), 'MSI')).rejects.toThrow(
        InvalidInstallerHeaderError,
      );
      expect(await filesOnDisk()).toEqual([]);
    });

    it('aceita assinatura que chega partida em pedaços pequenos', async () => {
      const service = await createService();
      const data = fakeInstaller(OLE, 1000);
      const bytes = [...data].map((b) => Buffer.from([b])); // 1 byte por pedaço

      const result = await service.save(Readable.from(bytes), 'MSI');

      expect(result.sha256).toBe(sha256(data));
    });

    it('aborta ao passar do limite sem ler o resto, e não deixa arquivo', async () => {
      const service = await createService('1'); // 1 MB
      const { stream, counter } = chunked(fakeInstaller(MZ, 10 * 1024 * 1024)); // 10 MB

      const error = await service.save(stream, 'EXE').catch((e) => e);

      expect(error).toBeInstanceOf(InstallerTooLargeError);
      expect(error.maxBytes).toBe(1024 * 1024);
      expect(counter.chunksRead).toBeLessThan(24); // ~1 MB = 16 pedaços, não 160
      expect(await filesOnDisk()).toEqual([]);
    });

    it('aceita arquivo com exatamente o tamanho do limite', async () => {
      const service = await createService('1');
      const data = fakeInstaller(MZ, 1024 * 1024);
      await expect(service.save(chunked(data).stream, 'EXE')).resolves.toMatchObject({
        sizeBytes: 1024 * 1024,
      });
    });

    it('conexão que cai no meio do envio não deixa arquivo', async () => {
      const service = await createService();
      const { stream } = chunked(fakeInstaller(MZ, 50 * CHUNK), { failAfterChunks: 10 });

      await expect(service.save(stream, 'EXE')).rejects.toThrow('conexão caiu no meio do envio');
      expect(await filesOnDisk()).toEqual([]);
    });

    it('tenta o rename de novo quando o Windows segura o arquivo (EPERM) por um instante', async () => {
      const service = await createService();
      renameMock.mockRejectedValueOnce(Object.assign(new Error('EPERM'), { code: 'EPERM' }));

      const result = await service.save(chunked(fakeInstaller(MZ, 5000)).stream, 'EXE');

      expect(renameMock).toHaveBeenCalledTimes(2);
      expect(await filesOnDisk()).toEqual([result.fileName]);
    });

    it('desiste depois de 3 tentativas de rename e apaga o .part', async () => {
      const service = await createService();
      renameMock.mockRejectedValue(Object.assign(new Error('EBUSY'), { code: 'EBUSY' }));

      await expect(service.save(chunked(fakeInstaller(MZ, 5000)).stream, 'EXE')).rejects.toThrow('EBUSY');
      expect(renameMock).toHaveBeenCalledTimes(3);
      expect(await filesOnDisk()).toEqual([]);
    });

    it('não tenta de novo em erro não transitório (ex.: ENOSPC) e apaga o .part', async () => {
      const service = await createService();
      renameMock.mockRejectedValue(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));

      await expect(service.save(chunked(fakeInstaller(MZ, 5000)).stream, 'EXE')).rejects.toThrow('ENOSPC');
      expect(renameMock).toHaveBeenCalledTimes(1);
      expect(await filesOnDisk()).toEqual([]);
    });
  });

  describe('openRead, delete e listFiles', () => {
    it('lê de volta o arquivo gravado e apaga de forma idempotente', async () => {
      const service = await createService();
      const data = fakeInstaller(OLE, 50_000);
      const { fileName } = await service.save(chunked(data).stream, 'MSI');

      const chunks: Buffer[] = [];
      for await (const chunk of service.openRead(fileName)) chunks.push(chunk as Buffer);
      expect(sha256(Buffer.concat(chunks))).toBe(sha256(data));

      await service.delete(fileName);
      await expect(service.delete(fileName)).resolves.toBeUndefined(); // já não existe: sem erro
      expect(await filesOnDisk()).toEqual([]);
    });

    it.each([
      '../../etc/passwd',
      '..\\..\\Windows\\win.ini',
      'instalador.msi',
      'c0ffee00-0000-4000-8000-000000000000.bat',
      'c0ffee00-0000-4000-8000-000000000000.msi/../x',
      'C0FFEE00-0000-4000-8000-000000000000.msi',
      '',
    ])('recusa nome que não foi gerado pelo sistema: %p', async (name) => {
      const service = await createService();
      expect(() => service.openRead(name)).toThrow(InvalidStoredFileNameError);
      await expect(service.delete(name)).rejects.toThrow(InvalidStoredFileNameError);
    });

    it('listFiles só devolve instaladores guardados (ignora .tmp e arquivos estranhos)', async () => {
      const service = await createService();
      const { fileName } = await service.save(chunked(fakeInstaller(MZ, 1000)).stream, 'EXE');
      await fsp.writeFile(join(dir, 'leia-me.txt'), 'x');

      expect(await service.listFiles()).toEqual([fileName]);
    });
  });

  describe('subida', () => {
    it('apaga .part de envios interrompidos e mantém os instaladores completos', async () => {
      const first = await createService();
      const { fileName } = await first.save(chunked(fakeInstaller(MZ, 1000)).stream, 'EXE');
      await fsp.writeFile(join(dir, '.tmp', 'c0ffee00-0000-4000-8000-000000000000.part'), 'meio arquivo');

      await createService(); // "reinício" do backend

      expect(await filesOnDisk()).toEqual([fileName]);
    });

    it('sem INSTALLER_STORAGE_DIR: indisponível, e gravar/ler/listar lançam erro próprio', async () => {
      process.env = { ...ORIGINAL_ENV };
      delete process.env.INSTALLER_STORAGE_DIR;
      const service = new InstallerStorageService();
      await service.onModuleInit(); // não pode lançar: o resto do catálogo precisa subir

      expect(service.isAvailable).toBe(false);
      await expect(service.save(Readable.from([MZ]), 'EXE')).rejects.toThrow(InstallerStorageUnavailableError);
      expect(() => service.openRead('c0ffee00-0000-4000-8000-000000000000.exe')).toThrow(
        InstallerStorageUnavailableError,
      );
      await expect(service.listFiles()).rejects.toThrow(InstallerStorageUnavailableError);
    });
  });
});

describe('resolveStorageDir', () => {
  const ORIGINAL_ENV = process.env;
  afterEach(() => (process.env = ORIGINAL_ENV));

  it('aceita uma pasta temporária do sistema', () => {
    const dir = join(tmpdir(), 'rsd-qualquer');
    expect(resolveStorageDir(dir)).toBe(resolve(dir));
  });

  it.each([undefined, '', '   '])('sem valor (%p): indisponível', (raw) => {
    expect(resolveStorageDir(raw)).toBeNull();
  });

  it('recusa pasta dentro do repositório', () => {
    const repoRoot = resolve(__dirname, '..', '..', '..');
    expect(resolveStorageDir(join(repoRoot, 'instaladores'))).toBeNull();
    expect(resolveStorageDir(join(repoRoot, 'backend', '.data'))).toBeNull();
    expect(resolveStorageDir(repoRoot)).toBeNull();
  });

  it('recusa pasta dentro do OneDrive (pela variável do Windows e pelo nome)', () => {
    process.env = { ...ORIGINAL_ENV, OneDrive: 'D:\\Nuvem\\MinhaPasta' };
    expect(resolveStorageDir('D:\\Nuvem\\MinhaPasta\\instaladores')).toBeNull();
    expect(resolveStorageDir('E:\\Dados\\OneDrive - Empresa\\instaladores')).toBeNull();
    expect(resolveStorageDir('E:\\Dados\\onedrive\\x')).toBeNull();
  });

  it('não confunde nome parecido com OneDrive', () => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.OneDrive;
    delete process.env.OneDriveConsumer;
    delete process.env.OneDriveCommercial;
    expect(resolveStorageDir('E:\\Dados\\MeuOneDriveBackup\\x')).not.toBeNull();
  });
});

describe('parseMaxSizeMb', () => {
  it.each([
    [undefined, 500],
    ['', 500],
    ['500', 500],
    ['1', 1],
    ['2000', 2000],
    ['2001', 2000], // teto: o tamanho é Int no banco
    ['99999', 2000],
    ['0', 500],
    ['-5', 500],
    ['1.5', 500],
    ['abc', 500],
  ])('%p → %p MB', (raw, expected) => {
    expect(parseMaxSizeMb(raw)).toBe(expected);
  });
});
