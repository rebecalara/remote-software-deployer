import { promises as dns } from 'node:dns';
import { connect, isIP } from 'node:net';

// Teste de porta da verificação "respondendo no WinRM" (DECISIONS.md): só abre e fecha uma
// conexão TCP. Nenhum byte é enviado, nenhuma autenticação, nenhum comando.
//
// DNS separado da conexão, e limitado: o dns.lookup do Node usa o grupo de 4 threads do
// libuv, COMPARTILHADO pelo processo inteiro, e no Windows um nome que não existe leva ~2,7 s
// para falhar. Sem limite, uma rodada com nomes que não resolvem ocupava as 4 threads e o
// LDAP do login (que resolve "localhost") estourava o tempo de conexão — medido: localhost
// levou 10,8 s durante 8 consultas que falhavam. Com no máximo 2 consultas da verificação ao
// mesmo tempo, sempre sobram threads para o resto do backend.

export type ProbeOutcome = 'connected' | 'refused' | 'timeout' | 'dns' | 'error';

export interface ProbeResult {
  responding: boolean;
  outcome: ProbeOutcome;
}

/** Nome → endereço IP. Lança com code ENOTFOUND/EAI_AGAIN quando o nome não existe. */
export type Lookup = (host: string) => Promise<string>;

/** Consultas de DNS da verificação ao mesmo tempo (de 4 threads do libuv). */
export const DNS_LOOKUP_PARALLEL = 2;

/** Envolve `lookup` para no máximo `max` consultas ao mesmo tempo (as outras esperam a vez). */
export function createLookupLimiter(max: number, lookup: Lookup): Lookup {
  let active = 0;
  const waiting: Array<() => void> = [];
  const release = () => {
    active--;
    waiting.shift()?.();
  };
  return async (host) => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await lookup(host);
    } finally {
      release();
    }
  };
}

/** Padrão: o resolvedor do sistema (mesmo que o PowerShell usa: hosts, sufixos de busca, AD). */
const limitedSystemLookup = createLookupLimiter(DNS_LOOKUP_PARALLEL, async (host) => (await dns.lookup(host)).address);

/**
 * Resolve o nome (com o DNS limitado) e conecta em host:port. O tempo limite vale só para a
 * conexão, depois do DNS: esperar a vez na fila do DNS não pode virar "sem resposta".
 * Resolve (nunca rejeita).
 */
export async function probePort(
  host: string,
  port: number,
  timeoutMs: number,
  lookup: Lookup = limitedSystemLookup,
): Promise<ProbeResult> {
  let address = host;
  if (isIP(host) === 0) {
    try {
      address = await lookup(host);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return { responding: false, outcome: code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ENODATA' ? 'dns' : 'error' };
    }
  }
  return connectWithTimeout(address, port, timeoutMs);
}

function connectWithTimeout(address: string, port: number, timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = connect({ host: address, port });
    const finish = (outcome: ProbeOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve({ responding: outcome === 'connected', outcome });
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    socket.once('connect', () => finish('connected'));
    socket.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED') finish('refused');
      else if (err.code === 'ETIMEDOUT') finish('timeout');
      else finish('error');
    });
  });
}

/**
 * Aplica fn a cada item com no máximo `limit` ao mesmo tempo, na ordem dos itens.
 * onDone é chamado a cada item terminado (para o progresso).
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  onDone?: () => void,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
      onDone?.();
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}
