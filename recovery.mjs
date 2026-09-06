import { open, rename, mkdir } from "node:fs/promises";
import path from "node:path";

export class CancellationError extends Error {
  constructor() { super("Plugin cancellation requested; recovery required"); this.name = "CancellationError"; }
}

// The host must allow >20s after SIGTERM and retain the journal before deleting
// the workspace. SIGKILL cannot run JavaScript; an in-flight write is unknown.
export function createCancellation({ signal, cleanupMs = 20_000 } = {}) {
  let deadline = null;
  const cleanup = new AbortController();
  let timer;
  return {
    signal,
    check() { if (signal?.aborted) throw new CancellationError(); },
    beginRecovery() {
      if (deadline === null) {
        deadline = Date.now() + cleanupMs;
        timer = setTimeout(() => cleanup.abort(), cleanupMs);
        timer.unref?.();
      }
    },
    recoveryOptions() {
      this.beginRecovery();
      const remaining = deadline - Date.now();
      if (remaining <= 0 || cleanup.signal.aborted) throw new CancellationError();
      return { signal: cleanup.signal, timeoutMs: remaining, recovery: true };
    },
    dispose() { clearTimeout(timer); },
  };
}

export function createRecoveryJournal(request, redact, progress = async () => {}) {
  const root = request.workspace?.path ?? request.workspace?.root ?? request.workspacePath;
  let sequence = 0;
  return async (output, state = "in-progress") => {
    if (!root || !path.isAbsolute(root)) throw new Error("Missing recovery workspace");
    const indeterminate = ["in-progress", "recovering", "recovery-required"].includes(state);
    const report = redact({ apiVersion: 1, status: "error", summary: "Camble operation recovery checkpoint", output: { ...output, recoveryRequired: indeterminate || output.recoveryRequired === true, recovery: { state, sequence: ++sequence, cancellationDoesNotProveRollback: true } }, artifacts: [] });
    await mkdir(root, { recursive: true, mode: 0o700 });
    const target = path.join(root, "plugin-recovery.json");
    const temporary = `${target}.tmp`;
    const file = await open(temporary, "w", 0o600);
    try { await file.writeFile(JSON.stringify(report)); await file.sync(); } finally { await file.close(); }
    await rename(temporary, target);
    // Sync the rename too where supported. Windows does not support directory fsync.
    const directory = await open(root, "r").catch(() => null);
    if (directory) { try { await directory.sync(); } catch {} finally { await directory.close(); } }
    await progress({ apiVersion: 1, event: "recovery-checkpoint", actionId: request.actionId ?? request.action?.id, state, message: `Recovery checkpoint ${sequence}: ${state}`, recovery: report.output.recovery });
  };
}
