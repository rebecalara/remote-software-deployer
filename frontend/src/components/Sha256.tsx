import { useEffect, useState } from 'react';
import { CheckIcon, CopyIcon } from './icons';
import { Tooltip } from './Tooltip';

const FOCUSABLE = 'rounded-md outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50';
const ICON_BUTTON =
  'rounded-md p-1 text-slate-500 outline-none hover:bg-slate-100 hover:text-slate-700 focus-visible:ring-2 focus-visible:ring-blue-500/50';

/** SHA-256 abreviado (8 primeiros…8 últimos), o valor inteiro na dica e um botão de copiar. */
export function Sha256({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(id);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Sem permissão de área de transferência: o valor inteiro continua na dica.
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      <Tooltip content={<span className="font-mono break-all">{value}</span>}>
        <span tabIndex={0} className={`font-mono ${FOCUSABLE}`} data-testid="sha256">
          {value.slice(0, 8)}…{value.slice(-8)}
        </span>
      </Tooltip>
      <Tooltip content={copied ? 'Copiado' : 'Copiar SHA-256'} asLabel>
        <button type="button" onClick={copy} className={ICON_BUTTON} data-testid="copy-sha256">
          {copied ? <CheckIcon className="h-3.5 w-3.5 text-emerald-600" /> : <CopyIcon className="h-3.5 w-3.5" />}
        </button>
      </Tooltip>
    </span>
  );
}
