import { Logger } from '@nestjs/common';
import { existsSync, readFileSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MsiInfoReader,
  READ_MSI_SCRIPT_PATH,
  loadMsiInfoReaderConfig,
  parseMsiInfoOutput,
} from './msi-info-reader';
import { REAL_POWERSHELL_TEST_TIMEOUT_MS } from '../deployments/testing/real-powershell';

// ProductCode lido no servidor, no envio do MSI (desinstalação remota).

const CODE = '{23170F69-40C1-2702-2606-000001000000}';

describe('parseMsiInfoOutput', () => {
  it('aceita o resultado do script e normaliza o ProductCode em maiúsculas', () => {
    const out = JSON.stringify({ ok: true, productCode: CODE.toLowerCase(), productName: '7-Zip', productVersion: '26.06.00.0', manufacturer: 'Igor Pavlov' });
    expect(parseMsiInfoOutput(`aviso qualquer\r\n${out}\r\n`)).toEqual({
      ok: true,
      info: { productCode: CODE, productName: '7-Zip', productVersion: '26.06.00.0', manufacturer: 'Igor Pavlov' },
    });
  });

  it('recusa ProductCode fora do formato {GUID}', () => {
    expect(parseMsiInfoOutput(JSON.stringify({ ok: true, productCode: '23170F69' }))).toMatchObject({ ok: false });
  });

  it('repassa a falha do script e trata saída vazia ou inválida', () => {
    expect(parseMsiInfoOutput(JSON.stringify({ ok: false, message: 'Arquivo não encontrado.' }))).toEqual({
      ok: false,
      message: 'Arquivo não encontrado.',
    });
    expect(parseMsiInfoOutput('')).toMatchObject({ ok: false });
    expect(parseMsiInfoOutput('{quebrado')).toMatchObject({ ok: false });
  });
});

describe('MsiInfoReader', () => {
  beforeAll(() => Logger.overrideLogger(false));
  afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']));

  it('fica indisponível fora do Windows, sem iniciar processo', async () => {
    const reader = new MsiInfoReader(loadMsiInfoReaderConfig({}, 'linux'));
    expect(reader.isAvailable).toBe(false);
    expect(await reader.read('C:\\x.msi')).toEqual({ ok: false, message: reader.unavailableReason });
  });

  it('o script está salvo em UTF-8 com BOM e só abre o pacote para leitura', () => {
    const source = readFileSync(READ_MSI_SCRIPT_PATH);
    expect([...source.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = source.toString('utf8');
    expect(text).toContain("'OpenDatabase', 'InvokeMethod', $null, $wi, @($path, 0)");
    expect(text).not.toMatch(/Start-Process|msiexec|Invoke-Expression|InstallProduct/i);
  });

  const sample = 'C:/rsd-data/amostras/7z2606-x64.msi';
  const onWindowsWithSample = process.platform === 'win32' && existsSync(sample) ? describe : describe.skip;
  onWindowsWithSample('com o powershell.exe real e o MSI de amostra (7-Zip 26.06)', () => {
    let dir: string;
    beforeAll(async () => {
      dir = await fsp.mkdtemp(join(tmpdir(), 'rsd-msi-'));
    });
    afterAll(() => fsp.rm(dir, { recursive: true, force: true }));

    it('lê o ProductCode do pacote (o mesmo visto na VM)', async () => {
      const path = join(dir, '0f0e0d0c-0b0a-4908-8706-050403020100.msi');
      await fsp.copyFile(sample, path);
      const reader = new MsiInfoReader(loadMsiInfoReaderConfig({ SystemRoot: process.env.SystemRoot }));
      expect(await reader.read(path)).toEqual({
        ok: true,
        info: { productCode: CODE, productName: '7-Zip 26.06 (x64 edition)', productVersion: '26.06.00.0', manufacturer: 'Igor Pavlov' },
      });
      // O pacote foi solto: dá para apagar logo em seguida.
      await expect(fsp.rm(path)).resolves.toBeUndefined();
    }, REAL_POWERSHELL_TEST_TIMEOUT_MS);

    it('recusa arquivo com nome fora do padrão do sistema', async () => {
      const path = join(dir, 'qualquer.msi');
      await fsp.copyFile(sample, path);
      const reader = new MsiInfoReader(loadMsiInfoReaderConfig({ SystemRoot: process.env.SystemRoot }));
      expect(await reader.read(path)).toEqual({ ok: false, message: 'Nome do arquivo inválido.' });
    }, REAL_POWERSHELL_TEST_TIMEOUT_MS);
  });
});
