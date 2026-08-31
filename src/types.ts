export type PluginInputValue = string | number | boolean | string[];

export interface PluginAction {
  id: string;
  label: string;
  description: string;
  mode: "read" | "write";
  confirm?: string;
  capabilities: string[];
}

export interface AgentSummary {
  id: string;
  name: string;
  platform: string;
  arch: string;
  online: boolean;
  capabilities: Record<string, unknown>;
}

export interface PluginArtifact {
  id: string;
  fileName: string;
  type: string;
  size: number;
  sha256: string;
  downloadUrl: string;
}

export interface PluginOperationDto {
  id: string;
  kind: "refresh" | "action";
  actionId: string | null;
  actorName: string;
  jobId: string | null;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  progress: Array<{ at: string; state: string; message: string }>;
  result: null | { summary: string; output: Record<string, unknown>; artifacts: PluginArtifact[] };
  error: string | null;
  createdAt: string;
}

export interface ProjectPluginDetail {
  id: string;
  projectId: string;
  manifest: null | { id: string; name: string; actions: PluginAction[] };
  operations: PluginOperationDto[];
}

export interface PluginFrontendContext {
  apiVersion: 1;
  detail: ProjectPluginDetail;
  agents: AgentSummary[];
  agentIds: Record<string, string>;
  runningAction: string | null;
  hasRunningOperation: boolean;
  canRun: boolean;
  supportsAction(agent: AgentSummary | undefined, action: PluginAction): boolean;
  setAgent(actionId: string, agentId: string): void;
  runAction(action: PluginAction, inputs: Record<string, PluginInputValue>, agentId: string, askConfirmation: boolean): Promise<void>;
}

export interface PluginFrontendInstance {
  update(context: PluginFrontendContext): void;
  unmount(): void;
}
