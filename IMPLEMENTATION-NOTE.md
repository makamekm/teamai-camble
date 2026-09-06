# Agent cancellation coordination (PLUGIN-05)

Camble CLI catches SIGTERM/SIGINT and stops forward work. Git push acknowledgement is reconciled using an independent cleanup signal, then only this operation's successful mutable refs are lease-restored. Cleanup uses one shared **20-second** budget, not one timeout per command. Immutable provenance tags remain reported. Returning refs does not prove a downstream Devtron rollback.

Host integration requirements:
- Send SIGTERM to the Node process first; allow at least 25 seconds before killing its remaining process group. A group SIGTERM can kill the active Git transport; Camble reconciles its ref before attempting rollback.
- Preserve nonzero-exit structured stdout, including `output.cancelled`, `output.recoveryRequired`, exact per-ref steps, and rollback failures.
- Before deleting workspace, read bounded `<request.workspace.path>/plugin-recovery.json`. It is a redacted API-v1 response envelope, atomically renamed and fsynced before/after every ref mutation. On forced kill its last in-flight state is **unknown/recovery-required**, never evidence that cancellation undid writes. Prefer final stdout when valid. Persist a copy outside the ephemeral workspace in the host's durable result/outbox.
- Journal `output.recovery.state` is checkpoint metadata, not host terminal job status. `in-progress`, `recovering`, `recovery-required` need reconciliation. A refs-only result never asserts deployed/ready.
- `TEAMAI_PROGRESS` recovery-checkpoint events are progress hints only; the journal carries the exact plan. No credentials are included.

No host files modified by this worker. No external promotion/deploy performed; local bare remotes only.

## Regression coverage

`npm run check` runs TypeScript checking, the shipped frontend build, and the Node test suite. `test/promotion-regression.test.mjs` executes the actual UI confirmed-plan serializer and real Git against isolated temporary bare remotes, with Git URL rewrites preventing any GitHub access. It covers per-source object databases, pinned source/target conflicts, application `tags/component` and `prod/component`, missing/zero confirmation rejection, partial-write compensation, concurrent rollback conflicts, lost acknowledgements, real CLI SIGTERM, SIGKILL durable in-flight evidence, Git-only credential-helper environment/hardening, and absolute configured tool paths outside PATH. The local fixtures are removed after tests.

Promotion exposes `output.refStatus = refs_updated` separately from `output.deploymentStatus = unverified`; neither operation completion nor restoration of Git refs proves downstream readiness or rollback. No browser, live Kubernetes, GitHub promotion, or Windows runtime E2E was performed.
