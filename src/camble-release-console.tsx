import { CheckCircle2, Clock3, Download, GitBranch, Hammer, History, LoaderCircle, PackageCheck, RefreshCw, Rocket, Tag, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { AgentSummary, PluginAction, PluginInputValue, PluginOperationDto, ProjectPluginDetail } from "./types";

interface Props {
  detail: ProjectPluginDetail;
  agents: AgentSummary[];
  agentIds: Record<string, string>;
  runningAction: string | null;
  hasRunningOperation: boolean;
  canRun: boolean;
  supportsAction: (agent: AgentSummary | undefined, action: PluginAction) => boolean;
  onAgent: (actionId: string, agentId: string) => void;
  onRun: (action: PluginAction, inputs: Record<string, PluginInputValue>, agentId: string, askConfirmation: boolean) => Promise<void>;
}

type Json = Record<string, unknown>;
type Tab = "version" | "build" | "preprod" | "prod";
type Environment = "preprod" | "prod";
interface ServiceState {
  id: string;
  repository: string;
  sourceRef: string;
  targetRef: string;
  sourceSha: string | null;
  targetSha: string | null;
  status: "current" | "stale" | "missing-source";
}

const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const shortSha = (value: string | null | undefined) => value ? value.slice(0, 12) : "—";
const REQUIRED_ACTIONS = ["version-inspect", "version-apply", "android-build", "collect", "promote"] as const;

function output(operation: PluginOperationDto | undefined): Json {
  return object(operation?.result?.output);
}

function latest(operations: PluginOperationDto[], actionId: string, environment?: Environment): PluginOperationDto | undefined {
  return operations.find((operation) => operation.actionId === actionId && operation.result && (!environment || text(output(operation).environment) === environment));
}

function serviceStates(value: unknown): ServiceState[] {
  if (!Array.isArray(value)) return [];
  return value.map(object).filter((item) => typeof item.id === "string").map((item) => ({
    id: text(item.id), repository: text(item.repository), sourceRef: text(item.sourceRef), targetRef: text(item.targetRef),
    sourceSha: typeof item.sourceSha === "string" ? item.sourceSha : null,
    targetSha: typeof item.targetSha === "string" ? item.targetSha : null,
    status: item.status === "current" ? "current" : item.status === "missing-source" ? "missing-source" : "stale",
  }));
}

function ActionAgent({ action, agents, value, onChange }: { action: PluginAction; agents: AgentSummary[]; value: string; onChange: (value: string) => void }) {
  const auto = agents[0];
  return <label className="field camble-agent" data-action={action.id}><span>Агент</span><select value={value} onChange={(event) => onChange(event.target.value)}><option value="">{auto ? `Свободный агент (автовыбор: ${auto.name})` : "Нет свободного совместимого агента"}</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.platform}/{agent.arch}</option>)}</select></label>;
}

function RunButton({ busy, disabled, children, onClick, secondary = false }: { busy: boolean; disabled: boolean; children: React.ReactNode; onClick: () => void; secondary?: boolean }) {
  return <button type="button" className={secondary ? "plugin-action-button" : "plugin-action-button primary-button"} disabled={disabled} onClick={onClick}>{busy ? <LoaderCircle className="spin" /> : secondary ? <RefreshCw /> : <Rocket />}<span>{children}</span></button>;
}

function OperationHistory({ operations }: { operations: PluginOperationDto[] }) {
  return <section className="plugin-history camble-release-history"><header><History /><div><h3>История и прогресс</h3><p>Операции, результаты и артефакты сохраняются после перезапуска.</p></div></header><div>{operations.length ? operations.map((operation) => <details key={operation.id} open={operation.status === "running"}><summary><span className={`plugin-status ${operation.status}`}>{operation.status === "completed" ? <CheckCircle2 /> : operation.status === "running" ? <LoaderCircle className="spin" /> : operation.status === "failed" ? <XCircle /> : <Clock3 />}{operation.actionId}</span><span>{operation.actorName}</span><time>{new Date(operation.createdAt).toLocaleString("ru-RU")}</time></summary><ol>{operation.progress.map((entry, index) => <li key={`${entry.at}-${index}`} className={entry.state}><time>{new Date(entry.at).toLocaleTimeString("ru-RU")}</time><span>{entry.message}</span></li>)}</ol>{operation.error && <p className="plugin-operation-error">{operation.error}</p>}{operation.result && <div className="plugin-plan"><strong>{operation.result.summary}</strong>{operation.result.artifacts.length > 0 && <div className="camble-artifacts">{operation.result.artifacts.map((artifact) => <a key={artifact.id} href={artifact.downloadUrl}><Download /> {artifact.fileName}</a>)}</div>}</div>}</details>) : <p className="modal-empty">История пуста.</p>}</div></section>;
}

export function CambleReleaseConsole({ detail, agents, agentIds, runningAction, hasRunningOperation, canRun, supportsAction, onAgent, onRun }: Props) {
  const actions = useMemo(() => new Map(detail.manifest?.actions.map((action) => [action.id, action]) ?? []), [detail.manifest]);
  const operations = detail.operations;
  const [tab, setTab] = useState<Tab>("version");
  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const [versionName, setVersionName] = useState("");
  const [buildNumber, setBuildNumber] = useState("");

  const versionOperation = latest(operations, "version-inspect");
  const version = output(versionOperation);
  const buildOperation = latest(operations, "android-build");
  const build = output(buildOperation);
  const environment: Environment | null = tab === "preprod" || tab === "prod" ? tab : null;
  const collectOperation = environment ? latest(operations, "collect", environment) : undefined;
  const snapshot = output(collectOperation);
  const services = serviceStates(snapshot.services);

  useEffect(() => {
    if (!versionOperation) return;
    setVersionName(text(version.versionName));
    setBuildNumber(text(version.nextBuildNumber));
  }, [versionOperation?.id]);
  useEffect(() => { setSelectedItems([]); }, [tab, collectOperation?.id]);

  const compatible = (id: string) => { const action = actions.get(id); return action ? agents.filter((agent) => supportsAction(agent, action)) : []; };
  const selectedAgent = (id: string) => agentIds[id] || compatible(id)[0]?.id || "";
  const busy = (id: string) => runningAction === id || hasRunningOperation;
  const disabled = (id: string) => !canRun || busy(id) || !selectedAgent(id);
  const run = async (id: string, inputs: Record<string, PluginInputValue>, askConfirmation = false) => {
    const action = actions.get(id); const agentId = selectedAgent(id);
    if (!action || !agentId) return;
    await onRun(action, inputs, agentId, askConfirmation);
  };
  const toggle = (value: string, checked: boolean) => setSelectedItems((current) => checked ? [...new Set([...current, value])] : current.filter((item) => item !== value));
  const availableServices = services.filter((service) => service.sourceSha !== null);
  const missingActions = REQUIRED_ACTIONS.filter((id) => !actions.has(id));

  if (missingActions.length) return <div className="error-banner" role="alert">Несовместимый Camble manifest: отсутствуют actions {missingActions.join(", ")}.</div>;

  return <section className="camble-release-workspace">
    <div className="plugin-tabs camble-workspace-tabs" role="tablist" aria-label="Camble release workspace">{([
      ["version", "Версионирование"], ["build", "Билд"], ["preprod", "Preprod"], ["prod", "Prod"],
    ] as const).map(([value, label]) => <button type="button" role="tab" aria-selected={tab === value} className={tab === value ? "active" : ""} key={value} onClick={() => setTab(value)}>{label}</button>)}</div>

    {tab === "version" && <div className="plugin-environment camble-tab-panel">
      <header className="camble-tab-heading"><div><span>APPLICATION3 / DEV</span><h3>Версионирование</h3><p>Актуальные версия, build и commit всегда читаются непосредственно из ветки application3/dev.</p></div><Tag /></header>
      <div className="camble-version-grid"><div className="camble-panel"><ActionAgent action={actions.get("version-inspect")!} agents={compatible("version-inspect")} value={agentIds["version-inspect"] ?? ""} onChange={(value) => onAgent("version-inspect", value)} /><RunButton secondary busy={busy("version-inspect")} disabled={disabled("version-inspect")} onClick={() => void run("version-inspect", {})}>Обновить из application3/dev</RunButton></div><dl className="camble-panel camble-version-current"><dt>Текущая версия</dt><dd>{text(version.versionName) || "—"}</dd><dt>Текущий build</dt><dd>{text(version.buildNumber) || "—"}</dd><dt>Commit dev</dt><dd><code>{shortSha(text(version.commitSha))}</code></dd></dl></div>
      <div className="camble-panel camble-version-form"><label className="field"><span>Новая версия</span><input value={versionName} placeholder="4.3.3" onChange={(event) => setVersionName(event.target.value)} /></label><label className="field"><span>Новый build</span><input type="number" step="1" value={buildNumber} onChange={(event) => setBuildNumber(event.target.value)} /></label><ActionAgent action={actions.get("version-apply")!} agents={compatible("version-apply")} value={agentIds["version-apply"] ?? ""} onChange={(value) => onAgent("version-apply", value)} /><RunButton busy={busy("version-apply")} disabled={disabled("version-apply") || !versionName || !buildNumber} onClick={() => void run("version-apply", { "version-name": versionName, "build-number": Number(buildNumber), "dry-run": false }, true)}>Проставить версию и билд</RunButton></div>
      <OperationHistory operations={operations.filter((operation) => operation.actionId === "version-inspect" || operation.actionId === "version-apply")} />
    </div>}

    {tab === "build" && <div className="plugin-environment camble-tab-panel">
      <header className="camble-tab-heading"><div><span>APPLICATION BUILD</span><h3>Билд application</h3><p>Точные application3/backend dev SHAs разрешаются на выбранном агенте непосредственно перед сборкой.</p></div><Hammer /></header>
      <div className="camble-panel camble-build-panel"><ActionAgent action={actions.get("android-build")!} agents={compatible("android-build")} value={agentIds["android-build"] ?? ""} onChange={(value) => onAgent("android-build", value)} /><div className="camble-build-source"><span>Последний application SHA <code>{shortSha(text(build.applicationSha))}</code></span><span>Последний backend SHA <code>{shortSha(text(build.backendSha))}</code></span><span>Источник: <strong>{text(build.verifiedBranch) || "dev"}</strong></span></div><RunButton busy={busy("android-build")} disabled={disabled("android-build")} onClick={() => void run("android-build", { "dry-run": false }, true)}>Собрать application</RunButton></div>
      <OperationHistory operations={operations.filter((operation) => operation.actionId === "android-build")} />
    </div>}

    {environment && <div className="plugin-environment camble-tab-panel">
      <div className="plugin-environment-intro"><div><h3>{environment === "preprod" ? "Preprod: dev → tags/[service]" : "Prod: tags/[service] → prod/[service]"}</h3><p>{environment === "preprod" ? "application3 идёт в application3:tags/component; component — в backend:tags/component; остальные — в backend:tags/[service]." : "Каждый сервис продвигается из своего tags/[service] в prod/[service]; application3 использует component."}</p></div><div className="camble-collect-controls"><ActionAgent action={actions.get("collect")!} agents={compatible("collect")} value={agentIds.collect ?? ""} onChange={(value) => onAgent("collect", value)} /><RunButton secondary busy={busy("collect")} disabled={disabled("collect")} onClick={() => void run("collect", { environment })}>Обновить состояние</RunButton></div></div>
      {collectOperation ? <>
        <div className="plugin-snapshot-meta"><span><Clock3 /> {new Date(collectOperation.createdAt).toLocaleString("ru-RU")}</span><span><GitBranch /> {environment === "preprod" ? "dev → tags/*" : "tags/* → prod/*"}</span><span>{services.filter((service) => service.status === "stale").length} отстало · {services.filter((service) => service.status === "current").length} актуально</span></div>
        <section className="plugin-selection camble-service-selection"><header><div><h4>Выберите сервисы</h4><p>По умолчанию ничего не выбрано. В deploy попадут только отмеченные сервисы.</p></div><div className="camble-selection-actions"><span>{selectedItems.length} выбрано</span><button type="button" onClick={() => setSelectedItems(availableServices.map((service) => service.id))}>Выделить все</button><button type="button" onClick={() => setSelectedItems([])}>Сбросить выделение</button></div></header><div className="plugin-items">{services.map((service) => <label key={`${service.repository}:${service.id}`} className={selectedItems.includes(service.id) ? "selected" : ""}><input type="checkbox" disabled={!service.sourceSha || busy("promote")} checked={selectedItems.includes(service.id)} onChange={(event) => toggle(service.id, event.target.checked)} /><span><PackageCheck /><strong>{service.id === "application3" ? "application" : service.id}</strong><small>{service.repository} · {service.sourceRef} → {service.targetRef}</small><small className={`camble-ref-status ${service.status}`}>{service.status === "current" ? "Актуальный" : service.status === "missing-source" ? "Нет Preprod ref" : environment === "preprod" ? "Отстал от dev" : "Отстал от Preprod"}</small><code>{shortSha(service.sourceSha)} → {shortSha(service.targetSha)}</code></span></label>)}</div></section>
        <div className="plugin-deploy-bar"><div><strong>{environment} deploy</strong><p>Guarded update только выбранных веток; при конфликте ref операция останавливается.</p></div><div className="camble-deploy-controls"><ActionAgent action={actions.get("promote")!} agents={compatible("promote")} value={agentIds.promote ?? ""} onChange={(value) => onAgent("promote", value)} /><RunButton busy={busy("promote")} disabled={disabled("promote") || selectedItems.length === 0} onClick={() => void run("promote", { environment, items: selectedItems, "dry-run": false }, true)}>Развернуть выбранные</RunButton></div></div>
      </> : <div className="plugin-no-snapshot"><RefreshCw /><h4>Состояние ещё не загружено</h4><p>Нажмите «Обновить состояние», чтобы получить актуальные ref и commit SHA всех сервисов.</p></div>}
      <OperationHistory operations={operations.filter((operation) => (operation.actionId === "collect" || operation.actionId === "promote") && text(output(operation).environment) === environment)} />
    </div>}
  </section>;
}
