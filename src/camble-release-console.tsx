
import { CheckCircle2, Clock3, Download, GitBranch, History, LoaderCircle, PackageCheck, RefreshCw, Rocket, Smartphone, Tag, XCircle } from "lucide-react";
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
type Environment = "preprod" | "prod";

const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const numberText = (value: unknown): string => typeof value === "number" || typeof value === "string" ? String(value) : "";
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const records = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : [];
const shortSha = (value: string) => value ? value.slice(0, 12) : "—";

function latest(operations: PluginOperationDto[], actionId: string, predicate?: (output: Json) => boolean): PluginOperationDto | undefined {
  return operations.find((operation) => operation.actionId === actionId && operation.result && (!predicate || predicate(object(operation.result.output))));
}

function ActionAgent({ action, agents, value, onChange }: { action: PluginAction; agents: AgentSummary[]; value: string; onChange: (value: string) => void }) {
  return <label className="field camble-agent" data-action={action.id}><span>{action.id === "android-build" ? "Агент сборки" : "Агент"}</span><select value={value} required onChange={(event) => onChange(event.target.value)}><option value="">Выберите online агента</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.platform}/{agent.arch}</option>)}</select></label>;
}

function RunButton({ busy, disabled, children, onClick, primary = false }: { busy: boolean; disabled: boolean; children: React.ReactNode; onClick: () => void; primary?: boolean }) {
  return <button type="button" className={primary ? "plugin-action-button primary-button" : "plugin-action-button"} disabled={disabled} onClick={onClick}>{busy ? <LoaderCircle className="spin" /> : primary ? <Rocket /> : <PackageCheck />}<span>{children}</span></button>;
}

function RichHistory({ operations }: { operations: PluginOperationDto[] }) {
  return <section className="plugin-history camble-history"><header><History /><div><h3>Полная история и прогресс</h3><p>Audit, progress, Structured output, Failure, Rollback и Artifacts</p></div></header>{operations.length ? operations.map((operation) => {
    const output = object(operation.result?.output);
    return <details key={operation.id} open={operation.status === "running"}><summary><span className={`plugin-status ${operation.status}`}>{operation.status === "completed" ? <CheckCircle2 /> : operation.status === "running" ? <LoaderCircle className="spin" /> : operation.status === "failed" ? <XCircle /> : <Clock3 />}<strong>{operation.kind === "refresh" ? "Manifest refresh" : operation.actionId}</strong></span><time>{new Date(operation.createdAt).toLocaleString("ru-RU")}</time><span>{operation.status}</span></summary>
      <div className="camble-operation-meta"><span>Actor: {operation.actorName}</span><span>Job: {operation.jobId ?? "—"}</span></div>
      <ol>{operation.progress.map((entry, index) => <li key={`${entry.at}-${index}`} className={entry.state}><time>{new Date(entry.at).toLocaleTimeString("ru-RU")}</time>{entry.message}</li>)}</ol>
      {operation.error && <p className="plugin-operation-error">{operation.error}</p>}
      {operation.result && <div className="plugin-result"><strong>{operation.result.summary}</strong><h4>Structured output</h4><pre>{JSON.stringify(output, null, 2)}</pre>{output.failure !== undefined && <><h4>Failure</h4><pre>{JSON.stringify(output.failure, null, 2)}</pre></>}{output.rollback !== undefined && <><h4>Rollback</h4><pre>{JSON.stringify(output.rollback, null, 2)}</pre></>}{operation.result.artifacts.length > 0 && <><h4>Artifacts</h4><div className="plugin-result-artifacts">{operation.result.artifacts.map((artifact) => <a key={artifact.id} href={artifact.downloadUrl}><Download /> {artifact.fileName}<small>{artifact.type} · {Math.ceil(artifact.size / 1024)} KB · {artifact.sha256.slice(0, 16)}…</small></a>)}</div></>}</div>}
    </details>;
  }) : <p className="modal-empty">История пуста.</p>}</section>;
}

export function CambleReleaseConsole({ detail, agents, agentIds, runningAction, hasRunningOperation, canRun, supportsAction, onAgent, onRun }: Props) {
  const actions = useMemo(() => new Map(detail.manifest?.actions.map((action) => [action.id, action]) ?? []), [detail.manifest]);
  const operations = detail.operations;
  const [environment, setEnvironment] = useState<Environment>("preprod");
  const [selectedItems, setSelectedItems] = useState<string[]>([]);
  const [versionName, setVersionName] = useState("");
  const [buildNumber, setBuildNumber] = useState("");
  const [sourceBranch, setSourceBranch] = useState("dev");
  const [services, setServices] = useState<string[]>(["application3", "admin-ui", "component"]);

  const latestCollectSnapshot = latest(operations, "collect", (output) => text(output.environment) === environment);
  const snapshotOutput = object(latestCollectSnapshot?.result?.output);
  const snapshot = latestCollectSnapshot ? {
    environment: text(snapshotOutput.environment), sourceBranch: text(snapshotOutput.sourceBranch),
    applicationSha: text(snapshotOutput.applicationSha), backendSha: text(snapshotOutput.backendSha), items: strings(snapshotOutput.items),
  } : null;
  const latestPreprodSnapshotOperation = latest(operations, "collect", (output) => text(output.environment) === "preprod");
  const preprodOutput = object(latestPreprodSnapshotOperation?.result?.output);
  const latestPreprodSnapshot = latestPreprodSnapshotOperation ? { applicationSha: text(preprodOutput.applicationSha), backendSha: text(preprodOutput.backendSha) } : null;
  const latestVersionInspection = latest(operations, "version-inspect");
  const inspection = object(latestVersionInspection?.result?.output);
  const clusterOperation = latest(operations, "cluster-observe") ?? latest(operations, "cluster-deploy");
  const clusterRoot = object(clusterOperation?.result?.output);
  const cluster = object(clusterRoot.cluster ?? clusterRoot);

  useEffect(() => {
    if (!latestVersionInspection) return;
    setVersionName(text(inspection.versionName));
    setBuildNumber(numberText(inspection.nextBuildNumber));
  }, [latestVersionInspection?.id]);
  useEffect(() => {
    if (!snapshot) return;
    setSelectedItems(environment === "prod" ? ["application3", "backend"] : snapshot.items);
  }, [latestCollectSnapshot?.id, environment]);

  const busy = (id: string) => runningAction === id || hasRunningOperation;
  const compatible = (id: string) => { const action = actions.get(id); return action ? agents.filter((agent) => supportsAction(agent, action)) : []; };
  const run = async (id: string, inputs: Record<string, PluginInputValue>, askConfirmation = false) => {
    const action = actions.get(id); if (!action) return;
    await onRun(action, inputs, agentIds[id] ?? "", askConfirmation);
  };
  const disabled = (id: string) => !canRun || busy(id) || !(agentIds[id] ?? "");
  const toggle = (values: string[], value: string, checked: boolean) => checked ? [...new Set([...values, value])] : values.filter((item) => item !== value);

  return <div className="camble-release-console">
    <section className="camble-release-section camble-promotion"><header><div><span>RELEASE REFS</span><h3>Promotion окружения</h3><p>Точный snapshot сначала фиксирует full SHA, затем из него строится план и только после проверки применяются refs.</p></div><GitBranch /></header>
      <div className="plugin-tabs" role="tablist" aria-label="Camble release environment">{(["preprod", "prod"] as const).map((value) => <button type="button" role="tab" aria-selected={environment === value} className={environment === value ? "active" : ""} key={value} onClick={() => setEnvironment(value)}>{value === "preprod" ? "Preprod" : "Prod"}</button>)}</div>
      <div className="camble-release-grid">
        <div className="camble-panel"><h4>1. Snapshot</h4><p>{environment === "preprod" ? "Source: dev" : "Source: preprod"}</p><ActionAgent action={actions.get("collect")!} agents={compatible("collect")} value={agentIds.collect ?? ""} onChange={(value) => onAgent("collect", value)} /><RunButton busy={busy("collect")} disabled={disabled("collect")} onClick={() => void run("collect", { environment })}>Собрать точный snapshot</RunButton></div>
        <div className="camble-panel camble-snapshot"><h4>Source branch</h4>{snapshot ? <dl><dt>Environment</dt><dd>{snapshot.environment}</dd><dt>Source branch</dt><dd>{snapshot.sourceBranch}</dd><dt>application3 SHA</dt><dd><code title={snapshot.applicationSha}>{snapshot.applicationSha}</code></dd><dt>backend SHA</dt><dd><code title={snapshot.backendSha}>{snapshot.backendSha}</code></dd></dl> : <p className="modal-empty">Сначала соберите актуальный snapshot.</p>}</div>
      </div>
      {snapshot && <div className="camble-panel"><div className="camble-selection-heading"><div><h4>2. Состав promotion</h4><p>{environment === "prod" ? "Полный promotion: application3 и backend всегда применяются вместе." : "TeamAI обновит только отмеченные refs; application3/component special cases сохраняются."}</p></div>{environment === "preprod" && <button type="button" className="plugin-action-button" onClick={() => setSelectedItems(selectedItems.length === snapshot.items.length ? [] : snapshot.items)}>Выбрать все</button>}</div><div className="camble-items">{(environment === "prod" ? ["application3", "backend"] : snapshot.items).map((item) => <label key={item}><input type="checkbox" disabled={environment === "prod"} checked={selectedItems.includes(item)} onChange={(event) => setSelectedItems(toggle(selectedItems, item, event.target.checked))} /><span>{item}</span></label>)}</div>
        <ActionAgent action={actions.get("promote")!} agents={compatible("promote")} value={agentIds.promote ?? ""} onChange={(value) => onAgent("promote", value)} /><div className="camble-actions"><RunButton busy={busy("promote")} disabled={disabled("promote") || selectedItems.length === 0} onClick={() => void run("promote", { environment, "application-sha": snapshot.applicationSha, "backend-sha": snapshot.backendSha, items: environment === "prod" ? ["application3", "backend"] : selectedItems, "dry-run": true })}>План promotion</RunButton><RunButton primary busy={busy("promote")} disabled={disabled("promote") || selectedItems.length === 0} onClick={() => void run("promote", { environment, "application-sha": snapshot.applicationSha, "backend-sha": snapshot.backendSha, items: environment === "prod" ? ["application3", "backend"] : selectedItems, "dry-run": false }, true)}>Применить promotion</RunButton></div></div>}
    </section>

    <section className="camble-release-section"><header><div><span>APPLICATION VERSION</span><h3>Версия приложения</h3><p>Версия и следующий build читаются из application3/dev и передаются workflow вместе с проверенным commit.</p></div><Tag /></header>
      <div className="camble-release-grid"><div className="camble-panel"><ActionAgent action={actions.get("version-inspect")!} agents={compatible("version-inspect")} value={agentIds["version-inspect"] ?? ""} onChange={(value) => onAgent("version-inspect", value)} /><RunButton busy={busy("version-inspect")} disabled={disabled("version-inspect")} onClick={() => void run("version-inspect", {})}>Проверить версию</RunButton></div><div className="camble-panel camble-version-current"><dl><dt>Текущая версия</dt><dd>{text(inspection.versionName) || "—"}</dd><dt>Текущий commit</dt><dd><code>{text(inspection.applicationSha) || text(inspection.sha) || "—"}</code></dd><dt>Следующий build</dt><dd>{numberText(inspection.nextBuildNumber) || "—"}</dd></dl></div></div>
      <div className="camble-panel camble-form-grid"><label className="field"><span>Новая версия</span><input value={versionName} placeholder="4.3.3 или 4.3.3-beta.1" onChange={(event) => setVersionName(event.target.value)} /></label><label className="field"><span>Следующий build</span><input type="number" step="1" value={buildNumber} onChange={(event) => setBuildNumber(event.target.value)} /></label><ActionAgent action={actions.get("version-apply")!} agents={compatible("version-apply")} value={agentIds["version-apply"] ?? ""} onChange={(value) => onAgent("version-apply", value)} /><div className="camble-actions"><RunButton busy={busy("version-apply")} disabled={disabled("version-apply") || !versionName || !buildNumber} onClick={() => void run("version-apply", { "version-name": versionName, "build-number": Number(buildNumber), "dry-run": true })}>План версии</RunButton><RunButton primary busy={busy("version-apply")} disabled={disabled("version-apply") || !versionName || !buildNumber} onClick={() => void run("version-apply", { "version-name": versionName, "build-number": Number(buildNumber), "dry-run": false }, true)}>Применить версию</RunButton></div></div>
    </section>

    <section className="camble-release-section"><header><div><span>ANDROID RELEASE</span><h3>Android из последнего Preprod snapshot</h3><p>Exact SHAs, signed APK+AAB, iOS/Android build parity; Google Play Internal фиксирован и не может быть заменён Production.</p></div><Smartphone /></header>
      <div className="camble-panel"><dl className="camble-inline-meta"><dt>application3</dt><dd><code>{shortSha(latestPreprodSnapshot?.applicationSha ?? "")}</code></dd><dt>backend</dt><dd><code>{shortSha(latestPreprodSnapshot?.backendSha ?? "")}</code></dd><dt>Store track</dt><dd><strong>Google Play Internal</strong></dd></dl><ActionAgent action={actions.get("android-build")!} agents={compatible("android-build")} value={agentIds["android-build"] ?? ""} onChange={(value) => onAgent("android-build", value)} /><div className="camble-actions"><RunButton busy={busy("android-build")} disabled={disabled("android-build") || !latestPreprodSnapshot} onClick={() => latestPreprodSnapshot && void run("android-build", { "application-sha": latestPreprodSnapshot.applicationSha, "backend-sha": latestPreprodSnapshot.backendSha, "dry-run": true })}>План сборки</RunButton><RunButton primary busy={busy("android-build")} disabled={disabled("android-build") || !latestPreprodSnapshot} onClick={() => latestPreprodSnapshot && void run("android-build", { "application-sha": latestPreprodSnapshot.applicationSha, "backend-sha": latestPreprodSnapshot.backendSha, "dry-run": false }, true)}>Собрать Android</RunButton></div></div>
    </section>

    <section className="camble-release-section"><header><div><span>KUBERNETES / DEVTRON</span><h3>Состояние кластера</h3><p>Deployment, Image, Full SHA, Digest, Readiness и Pods проверяются по реально запущенным pod imageID.</p></div><RefreshCw /></header>
      <div className="camble-panel camble-observe"><ActionAgent action={actions.get("cluster-observe")!} agents={compatible("cluster-observe")} value={agentIds["cluster-observe"] ?? ""} onChange={(value) => onAgent("cluster-observe", value)} /><RunButton busy={busy("cluster-observe")} disabled={disabled("cluster-observe")} onClick={() => void run("cluster-observe", {})}>Обновить состояние кластера</RunButton></div>
      <div className="camble-cluster-grid">{records(cluster.services).map((service) => <article className="camble-cluster-card" key={text(service.service)}><header><strong>{text(service.service)}</strong><span className={service.ready === true ? "ready" : "failed"}>{service.ready === true ? "Ready" : "Not ready"}</span></header><dl><dt>Deployment</dt><dd>{text(service.deployment)}</dd><dt>Image</dt><dd><code>{text(service.image)}</code></dd><dt>Full SHA</dt><dd><code>{text(service.sourceSha) || "—"}</code></dd><dt>Digest</dt><dd><code>{text(service.resolvedDigest) || "—"}</code></dd><dt>Readiness</dt><dd>{service.ready === true ? "ready" : "not ready"}</dd><dt>Pods</dt><dd>{records(service.pods).length}</dd></dl>{records(service.pods).length > 0 && <details><summary>Pods</summary>{records(service.pods).map((pod) => <div className="camble-pod" key={text(pod.name)}><strong>{text(pod.name)}</strong><code>{text(pod.digest) || text(pod.imageID)}</code><span>{pod.ready === true ? "ready" : "not ready"}</span></div>)}</details>}</article>)}</div>
      {!records(cluster.services).length && <p className="modal-empty">Запустите observation, чтобы увидеть реальные deployment и pod digests.</p>}
      <div className="camble-panel camble-cluster-deploy"><h4>Cluster deploy</h4><label className="field"><span>Source branch</span><input value={sourceBranch} onChange={(event) => setSourceBranch(event.target.value)} /></label><fieldset><legend>Маппинг сервисов</legend><div className="camble-items">{["application3", "admin-ui", "component"].map((service) => <label key={service}><input type="checkbox" checked={services.includes(service)} onChange={(event) => setServices(toggle(services, service, event.target.checked))} /><span>{service}{service === "application3" ? " → tags/component (application repo)" : ` → tags/${service} (backend repo)`}</span></label>)}</div></fieldset><ActionAgent action={actions.get("cluster-deploy")!} agents={compatible("cluster-deploy")} value={agentIds["cluster-deploy"] ?? ""} onChange={(value) => onAgent("cluster-deploy", value)} /><div className="camble-actions"><RunButton busy={busy("cluster-deploy")} disabled={disabled("cluster-deploy") || !sourceBranch || services.length === 0} onClick={() => void run("cluster-deploy", { "source-branch": sourceBranch, services, "dry-run": true })}>План deploy</RunButton><RunButton primary busy={busy("cluster-deploy")} disabled={disabled("cluster-deploy") || !sourceBranch || services.length === 0} onClick={() => void run("cluster-deploy", { "source-branch": sourceBranch, services, "dry-run": false }, true)}>Применить deploy</RunButton></div></div>
    </section>
    <RichHistory operations={operations} />
  </div>;
}
