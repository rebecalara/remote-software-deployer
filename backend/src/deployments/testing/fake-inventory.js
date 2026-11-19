// Processo falso usado nos testes do inventário (RF08) no lugar do powershell.exe.
// Segue o protocolo do inventory-target.ps1 (JSON pelo stdin, eventos JSON por linha).
// O comportamento é escolhido pelo computerName recebido.
'use strict';

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const raw = Buffer.concat(chunks);
  const input = JSON.parse(raw.toString('utf8'));
  const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
  const log = (message, phase = 'connect') => out({ type: 'log', level: 'INFO', phase, message });

  switch (input.computerName) {
    case 'FAKE-OK':
      log('Sessão WinRM aberta.');
      log('Leitura concluída: 3 itens.', 'read');
      out({
        type: 'result',
        ok: true,
        items: [
          { name: '7-Zip 26.06 (x64 edition)', version: '26.06.00.0', publisher: 'Igor Pavlov', installDate: '2026-11-19', productCode: '{23170f69-40c1-2702-2606-000001000000}', arch: '64' },
          { name: 'Microsoft Edge', version: '157.0', publisher: 'Microsoft Corporation', installDate: '', productCode: '', arch: '32' },
          { name: 'Microsoft Edge', version: '157.0', publisher: 'Microsoft Corporation', installDate: '', productCode: '', arch: '64' },
        ],
      });
      return;
    case 'FAKE-ECHO':
      // Devolve a entrada recebida (e se o stdin chegou só com ASCII) na mensagem de uma
      // falha — mensagens passam pelo filtro de senha.
      out({ type: 'result', ok: false, reason: 'unexpected', message: `ascii=${raw.every((b) => b < 0x80)} input=${JSON.stringify(input)}` });
      return;
    case 'FAKE-DENIED':
      out({ type: 'result', ok: false, phase: 'connect', reason: 'access-denied', message: `Acesso negado em FAKE-DENIED (senha ${input.credential?.password}).` });
      return;
    case 'FAKE-HANG':
      setTimeout(() => undefined, 60_000);
      return;
    case 'FAKE-SILENT':
      process.stderr.write('falhou sem resultado');
      process.exit(3);
      return;
    default:
      out({ type: 'result', ok: false, reason: 'dns', message: `O nome ${input.computerName} não foi encontrado no DNS.` });
  }
});
