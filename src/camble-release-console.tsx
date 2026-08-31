import { CheckCircle2, Clock3, GitBranch, History, LoaderCircle, PackageCheck, RefreshCw, Rocket, XCircle } from "lucide-react";
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
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const shortSha = (value: string) => value ? value.slice(0, 12) : "—";
const REQUIRED_ACTIONS = ["collect", "promote"] as const;

function latest(operations: PluginOperationDto[], actionId: string, environment: Environment): PluginOperationDto | undefined {
  return operations.find((operation) => operation.actionId === actionId && operation.result && text(object(operation.result.output).environment) === environment);
}

function ActionAgent({ action, agents, value, onChange }: { action: PluginAction; agents: AgentSummary[]; value: string; onChange: (value: string) => void }) {
  return <label className="field camble-agent" data-action={action.id}><span>Агент</span><select value={value} required onChange={(event) => onChange(event.target.value)}><option value="">Выберите online агента</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.platform}/{agent.arch}</option>)}</select></label>;
}

function RunButton({ busy, disabled, children, onClick }: { busy: boolean; disabled: boolean; children: React.ReactNode; onClick: () => void }) {
  return <button type="button" className="plugin-action-button primary-button" disabled={disabled} onClick={onClick}>{busy ? <LoaderCircle className="spin" /> : <Rocket />}<span>{children}</span></button>;
}

function ReleaseHistory({ operations }: { operations: PluginOperationDto[] }) {
  return <section className="plugin-history camble-release-history"><header><History /><div><h3>История и прогресс</h3><p>Операции сохраняются и переживают перезапуск.</p></div></header><div>{operations.length ? operations.map((operation) => <details key={operation.id} open={operation.status === "running"}><summary><span className={`plugin-status ${operation.status}`}>{operation.status === "completed" ? <CheckCircle2 /> : operation.status === "running" ? <LoaderCircle className="spin" /> : operation.status === "failed" ? <XCircle /> : <Clock3 />}{operation.actionId === "collect" ? "Сбор данных" : "Deploy"}</span><span>{operation.actorName}</span><time>{new Date(operation.createdAt).toLocaleString("ru-RU")}</time></summary><ol>{operation.progress.map((entry, index) => <li key={`${entry.at}-${index}`} className={entry.state}><time>{new Date(entry.at).toLocaleTimeString("ru-RU")}</time><span>{entry.message}</span></li>)}</ol>{operation.error && <p className="plugin-operation-error">{operation.error}</p>}{operation.result && <div className="plugin-plan"><strong>{operation.result.summary}</strong></div>}</details>) : <p className="modal-empty">История пуста.</p>}</div></section>;
}

export function CambleReleaseConsole({ detail, agents, agentIds, runningAction, hasRunningOperation, canRun, supportsAction, onAgent, onRun }: Props) {
  const actions = useMemo(() => new Map(detail.manifest?.actions.map((action) => [action.id, action]) ?? []), [detail.manifest]);
  const operations = detail.operations;
  const [environment, setEnvironment] = useState<Environment>("preprod");
  const [selectedItems, setSelectedItems] = useState<string[]>([]);

  const latestCollectSnapshot = latest(operations, "collect", environment);
  const snapshotOutput = object(latestCollectSnapshot?.result?.output);
  const snapshot = latestCollectSnapshot ? {
    sourceBranch: text(snapshotOutput.sourceBranch),
    applicationSha: text(snapshotOutput.applicationSha),
    backendSha: text(snapshotOutput.backendSha),
    items: strings(snapshotOutput.items),
  } : null;

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
  const missingActions = REQUIRED_ACTIONS.filter((id) => !actions.has(id));
  const releaseOperations = operations.filter((operation) => operation.actionId === "collect" || operation.actionId === "promote");

  if (missingActions.length) return <div className="error-banner" role="alert">Несовместимый Camble manifest: отсутствуют actions {missingActions.join(", ")}.</div>;

  return <section className="camble-original-release">
    <div className="plugin-tabs" role="tablist" aria-label="Camble release environment">{(["preprod", "prod"] as const).map((value) => <button type="button" role="tab" aria-selected={environment === value} className={environment === value ? "active" : ""} key={value} onClick={() => setEnvironment(value)}>{value === "preprod" ? "Preprod" : "Prod"}</button>)}</div>
    <div className="plugin-environment">
      <div className="plugin-environment-intro"><div><h3>{environment === "preprod" ? "Preprod" : "Prod"}</h3><p>{environment === "preprod" ? "Ручной выбор application3 и backend-сервисов из services/ на точных dev SHA." : "Полное продвижение application3 и backend из Preprod в Prod."}</p></div><div className="camble-collect-controls"><ActionAgent action={actions.get("collect")!} agents={compatible("collect")} value={agentIds.collect ?? ""} onChange={(value) => onAgent("collect", value)} /><RunButton busy={busy("collect")} disabled={disabled("collect")} onClick={() => void run("collect", { environment })}>Собрать данные</RunButton></div></div>
      {snapshot ? <>
        <div className="plugin-snapshot-meta"><span><Clock3 /> {latestCollectSnapshot ? new Date(latestCollectSnapshot.createdAt).toLocaleString("ru-RU") : "—"}</span><span><GitBranch /> application3 {snapshot.sourceBranch}: <code>{shortSha(snapshot.applicationSha)}</code></span><span><GitBranch /> backend {snapshot.sourceBranch}: <code>{shortSha(snapshot.backendSha)}</code></span></div>
        <section className="plugin-selection"><header><div><h4>{environment === "preprod" ? "Выберите сервисы" : "Полный состав окружения"}</h4><p>{environment === "preprod" ? "TeamAI обновит только отмеченные refs." : "Deploy всех перечисленных компонентов."}</p></div><span>{selectedItems.length} выбрано</span></header><div className="plugin-items">{(environment === "prod" ? ["application3", "backend"] : snapshot.items).map((item) => <label key={item} className={selectedItems.includes(item) ? "selected" : ""}><input type="checkbox" disabled={environment === "prod" || busy("promote")} checked={selectedItems.includes(item)} onChange={(event) => setSelectedItems(toggle(selectedItems, item, event.target.checked))} /><span><PackageCheck /><strong>{item}</strong><small>{item === "application3" ? `application3:${snapshot.sourceBranch}` : `backend:${snapshot.sourceBranch}`}</small></span></label>)}</div></section>
        <div className="plugin-deploy-bar"><div><strong>{environment === "preprod" ? "Preprod" : "Prod"} deploy</strong><p>{environment === "preprod" ? "Продвинуть только выбранные компоненты в Preprod? Невыбранные refs не изменятся." : "Продвинуть application3 и backend целиком из Preprod в Prod?"}</p></div><div className="camble-deploy-controls"><ActionAgent action={actions.get("promote")!} agents={compatible("promote")} value={agentIds.promote ?? ""} onChange={(value) => onAgent("promote", value)} /><RunButton busy={busy("promote")} disabled={disabled("promote") || selectedItems.length === 0} onClick={() => void run("promote", { environment, "application-sha": snapshot.applicationSha, "backend-sha": snapshot.backendSha, items: environment === "prod" ? ["application3", "backend"] : selectedItems, "dry-run": false }, true)}>Развернуть</RunButton></div></div>
      </> : <div className="plugin-no-snapshot"><RefreshCw /><h4>Данные ещё не собраны</h4><p>TeamAI прочитает source SHA и каталог services без анализа diff.</p></div>}
    </div>
    <ReleaseHistory operations={releaseOperations} />
  </section>;
}
