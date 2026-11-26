import { extractFirstOu, mapComputerEntry, normalizeHostname } from './computer-mapper';

// Hostnames, OUs e domínios fictícios — nenhum dado real da Prefeitura.
describe('computer-mapper', () => {
  describe('mapComputerEntry', () => {
    it('mapeia uma entrada no formato do AD (objectClass=computer)', () => {
      const result = mapComputerEntry(
        {
          dn: 'CN=WS-ADM-001,OU=ADMINISTRACAO,OU=Computadores,DC=exemplo,DC=local',
          attributes: {
            cn: ['WS-ADM-001'],
            dnshostname: ['ws-adm-001.exemplo.local'],
            operatingsystem: ['Windows 11 Pro'],
          },
        },
        { osAttribute: 'operatingSystem' },
      );

      expect(result).toEqual({
        hostname: 'WS-ADM-001',
        operatingSystem: 'Windows 11 Pro',
        department: 'ADMINISTRACAO',
      });
    });

    it('mapeia uma entrada do OpenLDAP local (device), lendo o SO de description', () => {
      const result = mapComputerEntry(
        {
          dn: 'cn=ws-fin-002,ou=FINANCEIRO,ou=computers,dc=rsd,dc=local',
          attributes: { cn: ['ws-fin-002'], description: ['Windows 10 Pro'] },
        },
        { osAttribute: 'description' },
      );

      expect(result).toEqual({
        hostname: 'WS-FIN-002',
        operatingSystem: 'Windows 10 Pro',
        department: 'FINANCEIRO',
      });
    });

    it('usa dNSHostName (sem domínio) quando não há cn', () => {
      const result = mapComputerEntry(
        { dn: 'CN=X,OU=TI,DC=exemplo,DC=local', attributes: { dnshostname: ['ws-ti-015.exemplo.local'] } },
        { osAttribute: 'operatingSystem' },
      );
      expect(result?.hostname).toBe('WS-TI-015');
    });

    it('deixa SO e setor nulos quando não existem', () => {
      const result = mapComputerEntry(
        { dn: 'CN=WS-SEM-OU,CN=Computers,DC=exemplo,DC=local', attributes: { cn: ['WS-SEM-OU'] } },
        { osAttribute: 'operatingSystem' },
      );
      expect(result).toEqual({ hostname: 'WS-SEM-OU', operatingSystem: null, department: null });
    });

    it('ignora a entrada (null) quando não há como identificar o hostname', () => {
      const result = mapComputerEntry(
        { dn: 'CN=,OU=TI,DC=exemplo,DC=local', attributes: { cn: ['   '] } },
        { osAttribute: 'operatingSystem' },
      );
      expect(result).toBeNull();
    });

    it('trata valor de SO vazio como nulo', () => {
      const result = mapComputerEntry(
        { dn: 'CN=WS-1,OU=TI,DC=x', attributes: { cn: ['WS-1'], operatingsystem: [''] } },
        { osAttribute: 'operatingSystem' },
      );
      expect(result?.operatingSystem).toBeNull();
    });
  });

  describe('normalizeHostname', () => {
    it.each([
      ['WS-001', 'WS-001'],
      ['ws-001', 'WS-001'],
      ['  ws-001  ', 'WS-001'],
      ['ws-001.exemplo.local', 'WS-001'],
    ])('%s → %s', (input, expected) => {
      expect(normalizeHostname(input)).toBe(expected);
    });

    it.each([undefined, '', '   '])('retorna null para %p', (input) => {
      expect(normalizeHostname(input)).toBeNull();
    });
  });

  describe('extractFirstOu', () => {
    it('pega a OU mais próxima da máquina, não a de cima', () => {
      expect(extractFirstOu('CN=WS-1,OU=SAUDE,OU=Computadores,DC=exemplo,DC=local')).toBe('SAUDE');
    });

    it('não diferencia maiúsculas no nome do atributo', () => {
      expect(extractFirstOu('cn=ws-1,ou=educacao,dc=exemplo')).toBe('educacao');
    });

    it('respeita vírgula escapada no valor da OU (formato \\,)', () => {
      expect(extractFirstOu('CN=WS-1,OU=Obras\\, Viação,DC=exemplo')).toBe('Obras, Viação');
    });

    // Formato que o ldapjs v3 realmente devolve em entry.pojo.objectName
    // (encontrado na sincronização real contra o OpenLDAP: saía "Obras2c Viacao").
    it('decodifica vírgula escapada em hexadecimal (formato \\2c do ldapjs v3)', () => {
      expect(extractFirstOu('cn=WS-OBR-001,ou=Obras\\2c Viacao,ou=computers,dc=rsd')).toBe(
        'Obras, Viacao',
      );
    });

    it('decodifica acentos escapados como bytes UTF-8 em hexadecimal', () => {
      // "Viação" → ç = \c3\a7, ã = \c3\a3
      expect(extractFirstOu('CN=WS-1,OU=Obras\\2c Via\\c3\\a7\\c3\\a3o,DC=exemplo')).toBe(
        'Obras, Viação',
      );
    });

    it('decodifica outros caracteres especiais escapados (+, =, aspas)', () => {
      expect(extractFirstOu('CN=WS-1,OU=A\\2bB\\3dC\\22D,DC=x')).toBe('A+B=C"D');
    });

    it('retorna null quando o DN não tem OU (container padrão CN=Computers)', () => {
      expect(extractFirstOu('CN=WS-1,CN=Computers,DC=exemplo,DC=local')).toBeNull();
    });
  });
});
