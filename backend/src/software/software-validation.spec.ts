import {
  LIMITS,
  SoftwareValidationError,
  validateInstallArgs,
  validateSoftwareCreate,
  validateSoftwareUpdate,
} from './software-validation';

/** Executa e devolve o campo e a mensagem do erro de validação. */
function errorOf(fn: () => unknown): { field: string; message: string } {
  try {
    fn();
  } catch (err) {
    if (err instanceof SoftwareValidationError) return { field: err.field, message: err.message };
    throw err;
  }
  throw new Error('esperava SoftwareValidationError, mas a validação passou');
}

const validBody = {
  name: '7-Zip',
  version: '23.01',
  vendor: 'Igor Pavlov',
  installType: 'EXE',
  installArgs: ['/S'],
};

describe('validateSoftwareCreate', () => {
  it('aceita um cadastro válido e normaliza espaços', () => {
    expect(
      validateSoftwareCreate({ ...validBody, name: '  Adobe   Acrobat  Reader ', vendor: '  Adobe ' }),
    ).toEqual({
      name: 'Adobe Acrobat Reader',
      version: '23.01',
      vendor: 'Adobe',
      installType: 'EXE',
      installArgs: ['/S'],
    });
  });

  it('installArgs e vendor são opcionais', () => {
    expect(validateSoftwareCreate({ name: 'App', version: '1.0', installType: 'MSI' })).toEqual({
      name: 'App',
      version: '1.0',
      vendor: null,
      installType: 'MSI',
      installArgs: [],
    });
  });

  it('vendor vazio ou só espaços vira null', () => {
    expect(validateSoftwareCreate({ ...validBody, vendor: '   ' }).vendor).toBeNull();
  });

  it('aceita installType em minúsculas e normaliza', () => {
    expect(validateSoftwareCreate({ ...validBody, installType: 'exe' }).installType).toBe('EXE');
  });

  it.each([
    ['name ausente', { ...validBody, name: undefined }, 'name'],
    ['name só espaços', { ...validBody, name: '   ' }, 'name'],
    ['version ausente', { ...validBody, version: undefined }, 'version'],
    ['name não-texto', { ...validBody, name: 123 }, 'name'],
    ['installType ausente', { ...validBody, installType: undefined }, 'installType'],
    ['installType desconhecido', { ...validBody, installType: 'ZIP' }, 'installType'],
    ['name longo demais', { ...validBody, name: 'x'.repeat(LIMITS.name + 1) }, 'name'],
    ['version longa demais', { ...validBody, version: '1'.repeat(LIMITS.version + 1) }, 'version'],
    ['quebra de linha no nome', { ...validBody, name: 'App\nOutro' }, 'name'],
    ['NUL no fabricante', { ...validBody, vendor: 'Ven\u0000dor' }, 'vendor'],
  ])('recusa %s', (_caso, body, field) => {
    expect(errorOf(() => validateSoftwareCreate(body)).field).toBe(field);
  });

  it('recusa SCRIPT com mensagem explicando a regra do projeto', () => {
    const { field, message } = errorOf(() => validateSoftwareCreate({ ...validBody, installType: 'SCRIPT' }));
    expect(field).toBe('installType');
    expect(message).toContain('não executa scripts arbitrários');
  });

  it.each(['installerSha256', 'installerFileName', 'createdById', 'active', 'id'])(
    'recusa campo controlado pelo servidor: %s',
    (field) => {
      const { message } = errorOf(() => validateSoftwareCreate({ ...validBody, [field]: 'x' }));
      expect(message).toContain(field);
    },
  );

  it.each([null, 'texto', 42, ['lista']])('recusa corpo que não é objeto: %p', (body) => {
    expect(errorOf(() => validateSoftwareCreate(body)).field).toBe('body');
  });
});

describe('validateSoftwareUpdate', () => {
  it('só devolve os campos enviados', () => {
    expect(validateSoftwareUpdate({ vendor: ' Novo fabricante ' })).toEqual({ vendor: 'Novo fabricante' });
  });

  it('vendor null limpa o fabricante', () => {
    expect(validateSoftwareUpdate({ vendor: null })).toEqual({ vendor: null });
  });

  it('recusa corpo vazio', () => {
    expect(errorOf(() => validateSoftwareUpdate({})).message).toBe('Nenhum campo para alterar.');
  });

  it('recusa name vazio (obrigatório também na edição)', () => {
    expect(errorOf(() => validateSoftwareUpdate({ name: '' })).field).toBe('name');
  });

  it('com installType junto, valida installArgs contra o novo tipo', () => {
    expect(errorOf(() => validateSoftwareUpdate({ installType: 'MSI', installArgs: ['/S'] })).field).toBe(
      'installArgs[0]',
    );
  });

  it('sem installType, só confere a forma (o tipo salvo é conferido por quem chama)', () => {
    expect(validateSoftwareUpdate({ installArgs: ['  /S  '] })).toEqual({ installArgs: ['/S'] });
    expect(errorOf(() => validateSoftwareUpdate({ installArgs: 'não é lista' })).field).toBe('installArgs');
  });

  it('recusa campo controlado pelo servidor', () => {
    expect(errorOf(() => validateSoftwareUpdate({ installerSha256: 'AB' })).field).toBe('installerSha256');
  });
});

describe('validateInstallArgs', () => {
  describe('EXE: modelos reais de instaladores', () => {
    it.each([
      [['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], 'Inno Setup'],
      [['/S'], 'NSIS'],
      [['/s', '/v"/qn"'], 'InstallShield (aspas dentro do token)'],
      [['-silent', '--no-desktop-shortcut'], 'switches com hífen'],
      [['/D=C:\\Apps\\7-Zip'], 'NSIS com pasta de destino'],
      [['/DIR="C:\\Program Files (x86)\\App"'], 'caminho com espaço e parênteses entre aspas'],
      [['/LOG="C:\\Temp\\instalação.log"'], 'acento dentro de aspas'],
      [['/LANG=pt-BR', '/MERGETASKS=desktopicon'], 'vários switches'],
      [['/PROP=""'], 'aspas vazias'],
    ])('aceita %j (%s)', (args) => {
      expect(validateInstallArgs(args, 'EXE')).toEqual(args);
    });
  });

  describe('MSI: só propriedades NOME=valor', () => {
    it.each([
      [['ALLUSERS=1']],
      [['REBOOT=ReallySuppress', 'ADDLOCAL=ALL']],
      [['INSTALLDIR="C:\\Program Files\\App"']],
      [['TRANSFORMS=custom.mst']],
      [['_PRIVADA.X=valor']],
    ])('aceita %j', (args) => {
      expect(validateInstallArgs(args, 'MSI')).toEqual(args);
    });

    it.each([
      ['/x', 'switch de desinstalação'],
      ['/qb', 'troca do modo silencioso fixo'],
      ['/i', 'segundo /i'],
      ['ALLUSERS', 'propriedade sem valor'],
      ['=1', 'propriedade sem nome'],
      ['1ABC=x', 'nome começando com dígito'],
    ])('recusa %p (%s)', (token) => {
      const { field, message } = errorOf(() => validateInstallArgs([token], 'MSI'));
      expect(field).toBe('installArgs[0]');
      expect(message).toContain('NOME=valor');
    });
  });

  describe('recusa caracteres que não têm motivo legítimo num argumento', () => {
    it.each([
      ['/S;calc', ';'],
      ['/S|whoami', '|'],
      ['/S&del', '&'],
      ['$(Remove-Item C:\\)', '$'],
      ['`calc`', '`'],
      ['/S>saida.txt', '>'],
      ['/S<entrada', '<'],
      ['{script}', '{'],
      ['%TEMP%', '%'],
      ["/S'x'", "'"],
      ['/S^x', '^'],
      ['/S!x', '!'],
      ['/S*', '*'],
      ['/S?', '?'],
    ])('%p (contém %s)', (token) => {
      const { field, message } = errorOf(() => validateInstallArgs([token], 'EXE'));
      expect(field).toBe('installArgs[0]');
      expect(message).toContain('caractere não permitido');
    });

    it('quebra de linha e tab no meio do token (código do caractere na mensagem)', () => {
      expect(errorOf(() => validateInstallArgs(['/S\nwhoami'], 'EXE')).message).toContain('código 10');
      expect(errorOf(() => validateInstallArgs(['/S\twhoami'], 'EXE')).message).toContain('código 9');
    });

    it('caractere perigoso escondido dentro de aspas também é recusado', () => {
      expect(errorOf(() => validateInstallArgs(['/LOG="a;b"'], 'EXE')).message).toContain('";"');
      expect(errorOf(() => validateInstallArgs(['/LOG="$(x)"'], 'EXE')).message).toContain('"$"');
    });
  });

  describe('espaço, parênteses e aspas', () => {
    it('espaço fora de aspas é recusado, com dica', () => {
      const { message } = errorOf(() => validateInstallArgs(['/DIR=C:\\Program Files\\App'], 'EXE'));
      expect(message).toContain('Espaço e parênteses só são aceitos dentro de aspas duplas');
    });

    it('parênteses fora de aspas são recusados', () => {
      expect(errorOf(() => validateInstallArgs(['/DIR=C:\\Apps(x86)'], 'EXE')).message).toContain('"("');
    });

    it('aspas sem fechamento são recusadas', () => {
      expect(errorOf(() => validateInstallArgs(['/DIR="C:\\App'], 'EXE')).message).toContain(
        'aspas duplas sem fechamento',
      );
    });

    it('recusa \\" (barra antes de aspa): no Windows vira aspa literal e desalinha os argumentos', () => {
      const { message } = errorOf(() => validateInstallArgs(['INSTALLDIR="C:\\Pasta\\"'], 'MSI'));
      expect(message).toContain('barra invertida imediatamente antes de aspa');
    });
  });

  describe('forma da lista', () => {
    it('remove espaços nas pontas de cada token', () => {
      expect(validateInstallArgs(['  /S  '], 'EXE')).toEqual(['/S']);
    });

    it('lista vazia é válida', () => {
      expect(validateInstallArgs([], 'EXE')).toEqual([]);
    });

    it.each([
      ['não é lista', '/S /NORESTART', 'installArgs'],
      ['item não-texto', ['/S', 1], 'installArgs[1]'],
      ['item vazio', ['/S', '   '], 'installArgs[1]'],
      ['item longo demais', ['/' + 'A'.repeat(LIMITS.argLength)], 'installArgs[0]'],
      ['lista longa demais', Array.from({ length: LIMITS.argCount + 1 }, () => '/S'), 'installArgs'],
    ])('recusa %s', (_caso, value, field) => {
      expect(errorOf(() => validateInstallArgs(value, 'EXE')).field).toBe(field);
    });

    it('o erro aponta o índice do token problemático', () => {
      expect(errorOf(() => validateInstallArgs(['/S', '/NORESTART', '/X;Y'], 'EXE')).field).toBe(
        'installArgs[2]',
      );
    });
  });
});
