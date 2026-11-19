import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { RefreshIcon } from '../../components/icons';
import { useAuth } from '../../context/AuthContext';
import { useNow } from '../../hooks/useNow';
import { SessionExpiredError } from '../../services/apiClient';
import { getDashboard, listDeployments } from '../../services/deploymentService';
import type { DashboardActivity, DashboardData, DeploymentSummary } from '../../types/deployment';
import { formatDateTime, formatRelative } from '../../utils/format';
import { ActionBadge, Counter, OutsideCatalogBadge, StatusBadge, deploymentTarget } from '../Deployments/deploymentUi';

// Dashboard (tela inicial): resumo SÓ com dado real, a partir do mockup do Portfólio
// (recorte no DECISIONS.md). Monitoramento e Histórico são telas separadas.
const LATEST = 5;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : 'Erro inesperado.';
}

function percent(rate: number): string {
  return `${(rate * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
}

export function DashboardPage() {
  const { user } = useAuth();
  const canDeploy = user?.role === 'ADMIN' || user?.role === 'OPERATOR';
  const now = useNow();

  const [data, setData] = useState<DashboardData | null>(null);
  const [latest, setLatest] = useState<DeploymentSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [dashboard, page] = await Promise.all([getDashboard(), listDeployments({ pageSize: LATEST })]);
      setData(dashboard);
      setLatest(page.items);
      setError(null);
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) setError(messageOf(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!data) {
    return (
      <div className="p-4 sm:p-6">
        {error ? (
          <div role="alert" className="rounded-xl border border-slate-200 bg-white px-6 py-12 text-center shadow-sm">
            <p className="text-sm font-medium text-slate-700">Não foi possível carregar o resumo.</p>
            <p className="mt-1 text-sm text-slate-500">{error}</p>
            <button type="button" onClick={load} className="mt-3 text-sm font-medium text-blue-700 hover:underline">
              Tentar de novo
            </button>
          </div>
        ) : (
          <p className="text-sm text-slate-500">Carregando…</p>
        )}
      </div>
    );
  }

  const { machines, deployments: dep, system } = data;
  const w = dep.finishedInWindow;
  const successRate = dep.failureRate === null ? null : 1 - dep.failureRate;

  return (
    <div className="space-y-4 p-4 sm:p-6">
      {error && (
        <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">
          Não foi possível atualizar: {error}
        </p>
      )}

      {/* Contadores */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Counter
          label="Máquinas cadastradas"
          value={machines.total}
          detail={machines.lastSyncAt ? `${machines.seenInLastSync} presentes na última sincronização` : 'ainda não sincronizado'}
        />
        <Counter
          label="Implantações ativas"
          value={dep.activeDeployments}
          tone="blue"
          detail={dep.pendingTargets > 0 ? `${dep.pendingTargets} ${dep.pendingTargets === 1 ? 'máquina' : 'máquinas'} na fila` : undefined}
        />
        <Counter label={`Concluídas (${dep.windowHours} h)`} value={w.succeeded} tone="green" />
        <Counter
          label={`Com falha (${dep.windowHours} h)`}
          value={w.failed}
          tone="red"
          detail={dep.failureRate !== null ? `${percent(dep.failureRate)} de taxa de falha` : undefined}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Atividade recente */}
        <Card
          title="Atividade recente"
          className="lg:col-span-2"
          action={
            <Link to="/history" className="text-xs font-medium text-blue-700 hover:underline">
              Ver tudo →
            </Link>
          }
        >
          {data.activity.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-slate-500">Nenhuma atividade registrada ainda.</p>
          ) : (
            <ul className="divide-y divide-slate-100" data-testid="activity">
              {data.activity.map((a, i) => (
                <ActivityRow key={i} item={a} now={now} />
              ))}
            </ul>
          )}
        </Card>

        <div className="space-y-4">
          {/* Ações rápidas */}
          <Card title="Ações rápidas">
            <div className="space-y-2 p-4">
              {canDeploy && (
                <Link
                  to="/deployments/new"
                  className="block rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-800"
                >
                  Nova implantação
                </Link>
              )}
              <QuickLink to="/machines">Gerenciar máquinas</QuickLink>
              <QuickLink to="/monitoring">Ver monitoramento</QuickLink>
              <QuickLink to="/software">Catálogo de software</QuickLink>
            </div>
          </Card>

          {/* Status do sistema (real) */}
          <Card
            title="Status do sistema"
            action={
              <button
                type="button"
                onClick={load}
                disabled={loading}
                aria-label="Verificar de novo"
                className="rounded-md p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
              >
                <RefreshIcon className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              </button>
            }
          >
            <ul className="space-y-2.5 px-4 py-3 text-sm" data-testid="system-status">
              <StatusRow label="Banco de dados" ok={system.database.ok} okText="Respondendo" badText="Sem resposta" detail={system.database.detail} />
              <StatusRow label="AD / LDAP" ok={system.ldap.ok} okText="Respondendo" badText="Sem resposta" detail={system.ldap.detail} />
              <StatusRow
                label="Implantação remota"
                ok={system.deployment.available}
                okText="Disponível"
                badText="Indisponível neste ambiente"
                detail={system.deployment.detail}
              />
              <li className="flex items-baseline justify-between gap-3">
                <span className="text-slate-600">Última sincronização com o AD</span>
                <span className="text-right font-medium whitespace-nowrap text-slate-700" title={formatDateTime(system.lastSyncAt)}>
                  {system.lastSyncAt ? formatRelative(system.lastSyncAt, now) : 'nunca'}
                </span>
              </li>
            </ul>
            <p className="flex justify-between border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500">
              <span>Última verificação</span>
              <span>{formatRelative(system.checkedAt, now)}</span>
            </p>
          </Card>
        </div>
      </div>

      {/* Últimas implantações */}
      <Card
        title="Últimas implantações"
        action={
          <span className="flex items-center gap-3 text-xs">
            <span className="text-slate-500">
              Taxa de sucesso ({dep.windowHours} h):{' '}
              <span className="font-semibold text-emerald-700" data-testid="success-rate">
                {successRate === null ? '—' : percent(successRate)}
              </span>
            </span>
            <Link to="/history" className="font-medium text-blue-700 hover:underline">
              Histórico completo →
            </Link>
          </span>
        }
      >
        {latest === null || latest.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-slate-500">Nenhuma implantação ainda.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold tracking-wide whitespace-nowrap text-slate-500 uppercase">
                <tr>
                  <th scope="col" className="px-4 py-3">Software</th>
                  <th scope="col" className="px-4 py-3">Ação</th>
                  <th scope="col" className="px-4 py-3">Versão</th>
                  <th scope="col" className="px-4 py-3">Máquinas</th>
                  <th scope="col" className="px-4 py-3">Sucesso / falha</th>
                  <th scope="col" className="px-4 py-3">Status</th>
                  <th scope="col" className="px-4 py-3">Data / hora</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {latest.map((d) => (
                  <tr key={d.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2.5">
                      <Link to={`/deployments/${d.id}`} className="font-medium text-slate-900 hover:text-blue-700 hover:underline">
                        {deploymentTarget(d).name}
                      </Link>
                      {!deploymentTarget(d).inCatalog && (
                        <span className="ml-1.5">
                          <OutsideCatalogBadge />
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <ActionBadge action={d.action} />
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[13px] text-slate-600">{deploymentTarget(d).version ?? '—'}</td>
                    <td className="px-4 py-2.5 text-slate-600">{d.counts.total}</td>
                    <td className="px-4 py-2.5 font-medium">
                      <span className="text-emerald-700">{d.counts.succeeded}</span>
                      <span className="text-slate-400"> / </span>
                      <span className={d.counts.failed > 0 ? 'text-red-700' : 'text-slate-500'}>{d.counts.failed}</span>
                    </td>
                    <td className="px-4 py-2.5">
                      <DeploymentLabel status={d.status} succeeded={d.counts.succeeded} />
                    </td>
                    <td className="px-4 py-2.5 font-mono text-[13px] whitespace-nowrap text-slate-600">{formatDateTime(d.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/**
 * "Parcial" é só RÓTULO: implantação FAILED em que alguma máquina concluiu. O status no
 * banco continua FAILED (sem status novo — decisão do Bloco 4).
 */
function DeploymentLabel({ status, succeeded }: { status: DeploymentSummary['status']; succeeded: number }) {
  if (status === 'FAILED' && succeeded > 0) {
    return (
      <span
        title="Algumas máquinas concluíram e outras falharam"
        className="inline-flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-amber-800"
      >
        <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
        Parcial
      </span>
    );
  }
  return <StatusBadge status={status} />;
}

const DOT = { green: 'bg-emerald-500', red: 'bg-red-500', amber: 'bg-amber-500', blue: 'bg-blue-500', slate: 'bg-slate-400' };

function activityText(a: DashboardActivity): { text: string; dot: keyof typeof DOT } {
  const sw = `${a.softwareName}${a.softwareVersion ? ` ${a.softwareVersion}` : ''}${a.inCatalog === false ? ' (fora do catálogo)' : ''}`;
  if (a.kind === 'software') return { text: `${sw} adicionado ao catálogo`, dot: 'blue' };
  const total = a.total ?? 0;
  const machines = `${total} ${total === 1 ? 'máquina' : 'máquinas'}`;
  if (a.action === 'UNINSTALL') {
    if (a.status === 'SUCCEEDED') return { text: `${sw} removido de ${machines}`, dot: 'green' };
    if (a.status === 'CANCELLED') return { text: `Desinstalação de ${sw} cancelada`, dot: 'slate' };
    if ((a.succeeded ?? 0) > 0) return { text: `Desinstalação de ${sw}: ${a.failed} de ${machines} com falha`, dot: 'amber' };
    return { text: `Falha ao desinstalar ${sw} em ${machines}`, dot: 'red' };
  }
  if (a.status === 'SUCCEEDED') return { text: `${sw} instalado em ${machines}`, dot: 'green' };
  if (a.status === 'CANCELLED') return { text: `Implantação de ${sw} cancelada`, dot: 'slate' };
  if ((a.succeeded ?? 0) > 0) return { text: `${sw}: ${a.failed} de ${machines} com falha`, dot: 'amber' };
  return { text: `Falha ao instalar ${sw} em ${machines}`, dot: 'red' };
}

function ActivityRow({ item, now }: { item: DashboardActivity; now: number }) {
  const { text, dot } = activityText(item);
  const content = (
    <>
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[dot]}`} aria-hidden="true" />
      <span className="min-w-0">
        <span className="block text-sm text-slate-800">{text}</span>
        <span className="block text-xs text-slate-500">
          {formatRelative(item.at, now)}
          {item.by && <> · {item.by}</>}
        </span>
      </span>
    </>
  );
  return (
    <li>
      {item.deploymentId ? (
        <Link to={`/deployments/${item.deploymentId}`} className="flex gap-3 px-4 py-3 hover:bg-slate-50">
          {content}
        </Link>
      ) : (
        <div className="flex gap-3 px-4 py-3">{content}</div>
      )}
    </li>
  );
}

function StatusRow({
  label,
  ok,
  okText,
  badText,
  detail,
}: {
  label: string;
  ok: boolean;
  okText: string;
  badText: string;
  detail: string | null;
}) {
  return (
    <li>
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex items-center gap-2 text-slate-600">
          <span className={`h-2 w-2 shrink-0 rounded-full ${ok ? 'bg-emerald-500' : 'bg-amber-500'}`} aria-hidden="true" />
          {label}
        </span>
        <span className={`text-right font-medium ${ok ? 'text-emerald-700' : 'text-amber-700'}`}>{ok ? okText : badText}</span>
      </div>
      {!ok && detail && <p className="mt-0.5 pl-4 text-xs text-slate-500">{detail}</p>}
    </li>
  );
}

function Card({ title, action, className = '', children }: { title: string; action?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}>
      <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

function QuickLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="block rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
    >
      {children}
    </Link>
  );
}
