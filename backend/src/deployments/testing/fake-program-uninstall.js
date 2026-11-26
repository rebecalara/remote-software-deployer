// Processo falso usado nos testes da desinstalação por comando do fabricante, no lugar do
// powershell.exe com o uninstall-program-target.ps1. Mesmo protocolo (JSON pelo stdin,
// eventos JSON por linha). O comportamento é escolhido pelo computerName recebido.
'use strict';

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const raw = Buffer.concat(chunks);
  const input = JSON.parse(raw.toString('utf8'));
  const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
  const log = (message, phase = 'check', level = 'INFO') => out({ type: 'log', level, phase, message });

  switch (input.computerName) {
    case 'FAKE-REMOVED':
      log('Comando de desinstalação conferido no registro de FAKE-REMOVED.');
      log('Executando o desinstalador do fabricante em FAKE-REMOVED.', 'uninstall');
      log('O desinstalador terminou com o código 0. Conferindo se o programa saiu do registro (até 120 s).', 'confirm');
      out({ type: 'result', ok: true, removed: true, exitCode: 0 });
      return;
    case 'FAKE-STILL':
      out({ type: 'result', ok: false, phase: 'confirm', reason: 'still-installed', exitCode: 2, message: 'O programa continua registrado.' });
      return;
    case 'FAKE-NOT-INSTALLED':
      out({ type: 'result', ok: true, notInstalled: true });
      return;
    case 'FAKE-ECHO':
      log(`stdin-ascii=${raw.every((b) => b < 0x80)}`);
      log(`input=${JSON.stringify(input)}`);
      out({ type: 'result', ok: true, removed: true, exitCode: 0 });
      return;
    default:
      out({ type: 'result', ok: false, phase: 'resolve', reason: 'dns', message: `O nome ${input.computerName} não foi encontrado no DNS.` });
  }
});
