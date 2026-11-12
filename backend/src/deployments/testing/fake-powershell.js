// Processo falso usado nos testes do PowerShellExecutor no lugar do powershell.exe.
// Segue o mesmo protocolo do deploy-target.ps1 (JSON pelo stdin, um evento JSON por
// linha no stdout). O comportamento é escolhido pelo computerName recebido.
'use strict';

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const raw = Buffer.concat(chunks);
  const input = JSON.parse(raw.toString('utf8'));
  const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
  const log = (message, level = 'INFO', phase = 'connect') => out({ type: 'log', level, phase, message });
  const name = input.computerName;

  const exit = /^FAKE-EXIT-(\d+)$/.exec(name);
  if (exit) {
    log('Sessão WinRM aberta.');
    log('O instalador terminou.', 'INFO', 'install');
    out({ type: 'result', ok: true, exitCode: Number(exit[1]) });
    return;
  }

  switch (name) {
    case 'FAKE-ECHO': {
      // Devolve a entrada recebida e se o stdin chegou só com ASCII.
      const ascii = raw.every((byte) => byte < 0x80);
      log(`stdin-ascii=${ascii}`);
      log(`input=${JSON.stringify(input)}`);
      out({ type: 'result', ok: true, exitCode: 0 });
      return;
    }
    case 'FAKE-FAIL-CONNECT':
      log('Conectando.');
      out({ type: 'result', ok: false, phase: 'connect', reason: 'unreachable', message: 'não respondeu' });
      return;
    case 'FAKE-LEAK': {
      // Simula a senha aparecendo numa mensagem de erro e no stderr.
      const pwd = input.credential.password;
      log(`erro com a senha ${pwd} no meio`, 'WARN');
      process.stderr.write(`stderr com ${pwd}\n`);
      out({ type: 'result', ok: false, phase: 'connect', reason: 'session', message: `falhou: ${pwd}` });
      return;
    }
    case 'FAKE-GARBAGE':
      process.stdout.write('AVISO: isto não é JSON\n');
      process.stdout.write('{"type":"log","level":"BANANA","phase":"connect","message":"nível inválido"}\n');
      process.stdout.write('\n');
      out({ type: 'result', ok: true, exitCode: 0 });
      out({ type: 'result', ok: true, exitCode: 99 }); // segundo resultado: ignorado
      return;
    case 'FAKE-LONG':
      log('x'.repeat(5000));
      out({ type: 'result', ok: true, exitCode: 0 });
      return;
    case 'FAKE-NO-RESULT':
      log('Conectando.');
      process.stderr.write('Exceção não tratada no script\n');
      process.exit(1);
      return;
    case 'FAKE-HANG':
      log('Executando o instalador.', 'INFO', 'install');
      setInterval(() => {}, 1000);
      return;
    default:
      out({ type: 'result', ok: false, phase: 'validate', reason: 'invalid-input', message: `caso desconhecido: ${name}` });
  }
});
