import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ActivityIcon, CheckCircleIcon, MonitorIcon, RefreshIcon, SignalIcon, XCircleIcon } from '../../components/icons';
import { useAuth } from '../../context/AuthContext';
import { useNow } from '../../hooks/useNow';
import { SessionExpiredError } from '../../services/apiClient';
import { getDashboard, listDeployments } from '../../services/deploymentService';
import type { DashboardActivity, DashboardData, DeploymentSummary } from '../../types/deployment';
import { formatDateTime, formatRelative } from '../../utils/format';
import { Tooltip } from '../../components/Tooltip';
import { DeploymentBadges, StatusBadge, deploymentTitle } from '../Deployments/deploymentUi';

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
            <p className="text-body font-medium text-slate-700">Não foi possível carregar o resumo.</p>
            <p className="mt-1 text-body text-slate-500">{error}</p>
            <button type="button" onClick={load} className="mt-3 text-body font-medium text-blue-700 hover:underline">
              Tentar de novo
            </button>
          </div>
        ) : (
          <p className="text-body text-slate-500">Carregando…</p>
        )}
      </div>
    );
  }

  const { machines, deployments: dep, system, reachability: reach } = data;
  const w = dep.finishedInWindow;
  const successRate = dep.successRate;

  return (
    <div className="space-y-4 p-4 sm:p-6">
      {error && (
        <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-body text-amber-800">
          Não foi possível atualizar: {error}
        </p>
      )}

      {/* Contadores: ícone, número, título, detail e uma linha opcional (só dado real) */}
      {/* Cinco numa linha só a partir de 1440 px: abaixo disso, com a escala de 14 px, o
          título "Respondendo no WinRM" não cabe no cartão sem cortar (3 + 2 por linha). */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 wide:grid-cols-5" data-testid="stat-cards">
        <StatCard
          icon={<MonitorIcon className="h-4 w-4" />}
          tone="slate"
          value={machines.total}
          title="Máquinas cadastradas"
          detail={machines.lastSyncAt ? `${machines.seenInLastSync} presentes no AD` : 'ainda não sincronizado'}
        />
        {/* "Acessíveis pelo WinRM", não "online": a porta aceitar conexão não diz mais que isso.
            A tela de Máquinas, com mais espaço, mantém "Respondendo no WinRM". */}
        <StatCard
          testId="reachability-card"
          icon={<SignalIcon className="h-4 w-4" />}
          tone="cyan"
          value={reach.available ? reach.responding : '—'}
          title="Acessíveis"
          hint="Máquinas cuja porta do WinRM (5985) respondeu na última verificação"
          detail={!reach.available ? 'verificação desligada neste servidor' : 'pelo WinRM'}
          detailMore={
            reach.available ? (reach.checkedAt ? `verificado ${formatRelative(reach.checkedAt, now)}` : 'ainda não verificado') : undefined
          }
          extra={!reach.available ? (reach.detail ?? undefined) : undefined}
        />
        <StatCard
          icon={<ActivityIcon className="h-4 w-4" />}
          tone="blue"
          value={dep.activeDeployments}
          title="Implantações ativas"
          detail="em andamento agora"
          extra={dep.pendingTargets > 0 ? `${dep.pendingTargets} na fila` : undefined}
        />
        <StatCard
          icon={<CheckCircleIcon className="h-4 w-4" />}
          tone="green"
          value={w.succeeded}
          title="Concluídas"
          detail={`últimas ${dep.windowHours} h`}
        />
        <StatCard
          icon={<XCircleIcon className="h-4 w-4" />}
          // Vermelho só com falha; no 0, cinza como o de Máquinas.
          tone={w.failed > 0 ? 'red' : 'slate'}
          value={w.failed}
          title="Com falha"
          detail={`últimas ${dep.windowHours} h`}
          extra={
            [w.partial > 0 && `${w.partial} ${w.partial === 1 ? 'parcial' : 'parciais'}`, dep.failureRate !== null && `taxa de falha ${percent(dep.failureRate)}`]
              .filter(Boolean)
              .join(' · ') || undefined
          }
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Atividade recente */}
        <Card
          title="Atividade recente"
          className="lg:col-span-2"
          action={
            <Link to="/history" className="text-meta font-medium text-blue-700 hover:underline">
              Ver tudo →
            </Link>
          }
        >
          {data.activity.length === 0 ? (
            <p className="px-4 py-10 text-center text-body text-slate-500">Nenhuma atividade registrada ainda.</p>
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
                  className="block rounded-lg bg-blue-700 px-4 py-2.5 text-body font-semibold text-white hover:bg-blue-800"
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
            <ul className="space-y-2.5 px-4 py-3 text-body" data-testid="system-status">
              <StatusRow label="Banco de dados" ok={system.database.ok} okText="Respondendo" badText="Sem resposta" detail={system.database.detail} />
              <StatusRow
                label="AD / LDAP"
                ok={system.ldap.ok}
                okText="Respondendo"
                badText={system.ldap.reason === 'refused' ? 'Recusou a conta de serviço' : 'Sem resposta'}
                detail={system.ldap.detail}
              />
              {/* Só a configuração do servidor; quem mostra as máquinas de verdade é o cartão "Acessíveis". */}
              <StatusRow
                label="Implantação remota"
                ok={system.deployment.available}
                okText="Configurada"
                badText="Não configurada neste ambiente"
                detail={system.deployment.detail}
                hint="Confere o PowerShell, o script e a credencial no servidor; não testa nenhuma máquina. As máquinas acessíveis estão no cartão Acessíveis."
              />
            </ul>
            {/* Rodapé: as datas, em texto secundário; acima, só as linhas com bolinha */}
            <div className="space-y-1 border-t border-slate-100 px-4 py-2.5 text-meta text-slate-500" data-testid="system-status-footer">
              <p className="flex justify-between gap-3">
                <span>Última sincronização com o AD</span>
                <span className="whitespace-nowrap" title={formatDateTime(system.lastSyncAt)}>
                  {system.lastSyncAt ? formatRelative(system.lastSyncAt, now) : 'nunca'}
                </span>
              </p>
              <p className="flex justify-between gap-3">
                <span>Última verificação</span>
                <span className="whitespace-nowrap">{formatRelative(system.checkedAt, now)}</span>
              </p>
            </div>
          </Card>
        </div>
      </div>

      {/* Últimas implantações */}
      <Card
        title="Últimas implantações"
        action={
          <span className="flex items-center gap-3 text-meta">
            <span className="text-slate-500">
              Taxa de sucesso ({dep.windowHours} h):{' '}
              {successRate === null ? (
                <span className="text-slate-500" data-testid="success-rate">
                  sem implantações nas últimas {dep.windowHours} h
                </span>
              ) : (
                <span className="font-semibold text-emerald-700" data-testid="success-rate">
                  {percent(successRate)}
                </span>
              )}
            </span>
            <Link to="/history" className="font-medium text-blue-700 hover:underline">
              Histórico completo →
            </Link>
          </span>
        }
      >
        {latest === null || latest.length === 0 ? (
          <p className="px-4 py-10 text-center text-body text-slate-500">Nenhuma implantação ainda.</p>
        ) : (
          <div className="overflow-x-auto">
            {/* Mesmas colunas e selos da tabela do Monitoramento e do Histórico. */}
            <table className="w-full min-w-[480px] text-left text-body">
              <thead className="border-b border-slate-200 bg-slate-50 text-meta font-semibold tracking-wide whitespace-nowrap text-slate-500 uppercase">
                <tr>
                  <th scope="col" className="px-4 py-3">Implantação</th>
                  <th scope="col" className="px-4 py-3">Máquinas</th>
                  <th scope="col" className="px-4 py-3">Status</th>
                  <th scope="col" className="px-4 py-3">Criada em</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {latest.map((d) => {
                  const { title, tip } = deploymentTitle(d);
                  const link = (
                    <Link to={`/deployments/${d.id}`} className="font-medium text-slate-900 hover:text-blue-700 hover:underline">
                      {title}
                    </Link>
                  );
                  return (
                    <tr key={d.id} className="hover:bg-slate-50">
                      <td className="px-4 py-2.5">
                        <p className="flex flex-wrap items-center gap-2">
                          {tip ? <Tooltip content={tip}>{link}</Tooltip> : link}
                          <DeploymentBadges deployment={d} />
                        </p>
                      </td>
                      <td className="px-4 py-2.5 text-slate-600 tabular-nums">{d.counts.total}</td>
                      <td className="px-4 py-2.5">
                        <StatusBadge status={d.status} counts={d.counts} />
                      </td>
                      <td className="px-4 py-2.5 text-body whitespace-nowrap text-slate-600">{formatDateTime(d.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
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
    if (a.status === 'PARTIAL') return { text: `Desinstalação de ${sw} parcial: ${a.succeeded} de ${machines} concluídas`, dot: 'amber' };
    return { text: `Falha ao desinstalar ${sw} em ${machines}`, dot: 'red' };
  }
  if (a.status === 'SUCCEEDED') return { text: `${sw} instalado em ${machines}`, dot: 'green' };
  if (a.status === 'CANCELLED') return { text: `Implantação de ${sw} cancelada`, dot: 'slate' };
  if (a.status === 'PARTIAL') return { text: `Instalação de ${sw} parcial: ${a.succeeded} de ${machines} concluídas`, dot: 'amber' };
  return { text: `Falha ao instalar ${sw} em ${machines}`, dot: 'red' };
}

function ActivityRow({ item, now }: { item: DashboardActivity; now: number }) {
  const { text, dot } = activityText(item);
  const content = (
    <>
      <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[dot]}`} aria-hidden="true" />
      <span className="min-w-0">
        <span className="block text-body text-slate-800">{text}</span>
        <span className="block text-meta text-slate-500">
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
  hint,
}: {
  label: string;
  ok: boolean;
  okText: string;
  badText: string;
  detail: string | null;
  /** Dica ao passar o mouse: o que a linha confere. */
  hint?: string;
}) {
  return (
    <li title={hint} data-testid={`status-row-${label}`}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="flex items-center gap-2 text-slate-600">
          <span className={`h-2 w-2 shrink-0 rounded-full ${ok ? 'bg-emerald-500' : 'bg-amber-500'}`} aria-hidden="true" />
          {label}
        </span>
        <span className={`text-right font-medium ${ok ? 'text-emerald-700' : 'text-amber-700'}`}>{ok ? okText : badText}</span>
      </div>
      {!ok && detail && <p className="mt-0.5 pl-4 text-meta text-slate-500">{detail}</p>}
    </li>
  );
}

type StatTone = 'slate' | 'cyan' | 'blue' | 'green' | 'red';

const STAT_ICON_STYLE: Record<StatTone, string> = {
  slate: 'bg-slate-100 text-slate-600',
  cyan: 'bg-cyan-50 text-cyan-700',
  blue: 'bg-blue-50 text-blue-600',
  green: 'bg-emerald-50 text-emerald-600',
  red: 'bg-red-50 text-red-600',
};

/**
 * Cartão do Dashboard, na estrutura do protótipo: ícone no topo à esquerda (quadrado de
 * fundo suave), número grande, título curto, detalhe em cinza e uma linha opcional. Mesma
 * altura em toda a linha (a grade estica); no computador os textos não quebram (cortam com
 * "…" e o texto inteiro fica no title); no celular podem quebrar.
 */
function StatCard({
  icon,
  tone,
  value,
  title,
  detail,
  detailMore,
  extra,
  hint,
  testId,
}: {
  icon: ReactNode;
  tone: StatTone;
  value: number | string;
  title: string;
  detail: string;
  /**
   * Continuação do detalhe, na mesma linha ("pelo WinRM · verificado há 15 min"). Entre
   * 1440 e 1535 px (cinco cartões numa linha, cartão estreito) ela não cabe e desce para a
   * linha de baixo, em vez de cortar com "…".
   */
  detailMore?: string;
  extra?: string;
  /** Explicação do cartão: dica ao passar o mouse e texto para leitor de tela. */
  hint?: string;
  testId?: string;
}) {
  const full = detailMore ? `${detail} · ${detailMore}` : detail;
  return (
    // relative: o texto só para leitor de tela é absoluto e precisa ficar preso no cartão.
    <div
      data-testid={testId ?? 'stat-card'}
      title={hint}
      className="relative flex h-full min-w-0 flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
    >
      {hint && <span className="sr-only" data-testid="stat-hint">{hint}</span>}
      <span data-testid="stat-icon" className={`flex h-8 w-8 items-center justify-center rounded-lg ${STAT_ICON_STYLE[tone]}`}>
        {icon}
      </span>
      <p className="mt-3 text-stat font-semibold text-slate-900 tabular-nums">{value}</p>
      <p className="mt-1 text-body font-semibold text-slate-700 md:truncate" title={hint ?? title}>
        {title}
      </p>
      <p className="mt-0.5 text-meta text-slate-500 md:truncate" title={full} data-testid="stat-detail">
        <span data-testid="stat-detail-base">{detail}</span>
        {detailMore && (
          <span className="wide:max-2xl:hidden">
            {' · '}
            <span data-testid="stat-detail-more">{detailMore}</span>
          </span>
        )}
      </p>
      {detailMore && (
        <p className="mt-0.5 hidden text-meta text-slate-500 wide:max-2xl:block wide:max-2xl:truncate" title={full}>
          <span data-testid="stat-detail-more">{detailMore}</span>
        </p>
      )}
      {extra && (
        <p className="mt-0.5 text-meta font-medium text-slate-600 md:truncate" title={extra}>
          {extra}
        </p>
      )}
    </div>
  );
}

function Card({ title, action, className = '', children }: { title: string; action?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}>
      <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
        <h2 className="text-section font-semibold text-slate-900">{title}</h2>
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
      className="block rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-body font-medium text-slate-700 hover:bg-slate-50"
    >
      {children}
    </Link>
  );
}
