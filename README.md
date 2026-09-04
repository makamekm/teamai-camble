# Camble Release plugin for TeamAI

Executable external plugin implementing TeamAI plugin contract v2. TeamAI pins this repository commit and a free agent runs `node plugin.mjs` with the versioned JSON request on stdin. Product policy and procedures live here rather than in TeamAI core.

## Actions

- `collect` — resolves exact `application3`/`backend` source SHAs. Preprod collection reads service directories from `backend/services` at the exact `dev` SHA; Prod collects both `preprod` SHAs.
- `promote` — verifies the collected SHAs have not moved. Preprod treats `application3` and `component` specially and gives every other backend item an immutable `<item>-N` tag plus `tags/<item>` branch. Prod compare-and-swaps each destination branch against its preflight SHA. If the second repository update fails, rollback compare-and-swaps the first branch only when it still contains the plugin-written SHA, so concurrent changes are preserved and reported as lease conflicts.
- `version-inspect` / `version-apply` — reads `app.json` on `application3:dev`, validates equal iOS/Android build numbers, requires the next build number, and dispatches `version-apply.yml` with `expectedSha`. SemVer prerelease and build metadata are accepted.
- `android-build` — first verifies that both supplied SHAs are the current `preprod` tips, then clones them, runs Camble preinit, validates equal iOS/Android build numbers, builds signed APK+AAB, declares both artifacts, and optionally uploads the AAB to the fixed Google Play Internal track.
- `test` — the action bound to `surfaces.chat.test`. It owns the exact environment matrix: managed `test.rulet.tv`/`preprod.rulet.tv` and external `stage.rulet.tv`/`rulet.tv`. Targets are Desktop Chrome, a real 390×844 Mobile Chrome emulation, and Android; each selected target produces a declared screenshot artifact visible in the chat. The required test case is prefilled from the TeamAI chat problem. Repository branch bindings selected by the scheduler are used when explicit branch inputs are absent. Android resolves both source branches to full immutable SHAs, applies a hashed native-host overlay, builds one immutable signed APK, proves the installed artifact and PID-scoped runtime host, then runs Mobilerun with reasoning, vision, 80 steps and durable trajectory capture. A matrix-selected account arrives only through TeamAI's encrypted fenced runtime credential and is written to ephemeral mode-0600 Mobilerun config/credentials files that are deleted after the run. With no selection, managed environments may reuse, create, verify or reset the disposable plugin account as required by the UI; external environments are fail-closed and never auto-create or mutate accounts. Values are used only through `type_secret`, redacted from progress/results, and never placed in prompts or durable plugin inputs. Failed runs retain screenshots already captured before failure. The large transient APK is represented by SHA/signature/version/overlay/installed-artifact provenance but is not uploaded.
- `cluster-observe` — reads the fixed `camee` deployment/container mapping and its active pods through `kubectl`. A service is ready only when its deployment image carries a full 40-character source SHA and every matching running pod is ready on that exact image with one valid, identical `sha256` imageID digest. Truncated tags, mixed digests, missing pods, and image mismatches fail closed.
- `cluster-deploy` — accepts `dev` or a bounded test/feature/fix branch and preflights every source, destination branch, and deterministic `refs/tags/<service>-<full-source-SHA>` provenance tag. It safely creates or reuses all immutable tags before compare-and-swapping Devtron branches. After rollout it locks the observed pod digest for each selected service and re-reads the exact deployments and pods to verify the full SHA/digest pair. A timeout or later failure rolls back only branches written by this invocation, using the plugin-written SHA as the rollback lease; retained immutable tags and all original/apply/rollback outcomes are returned. `application3` deliberately advances its own `tags/component`; backend services advance `tags/<item>`.

The release/deploy write actions support `dryRun` and default it to `true`. Dry runs calculate and return the complete plan but perform no GitHub, Google Play, or Kubernetes mutation. Chat `test` intentionally has no dry-run input: a successful run must contain evidence from real selected targets and never reports a simulated pass.

## Request and response

The entrypoint accepts one bounded TeamAI `apiVersion: 1` request on stdin. It recognizes `actionId` (and the equivalent `action.id`), `input`, declared repositories with authenticated HTTPS URLs and scheduler-selected `defaultBranch` values, an absolute temporary workspace path, and supplied secrets. Boolean inputs must be JSON booleans. It emits exactly one contract response on stdout and exits nonzero for errors. Test progress is emitted separately as redacted single-line `TEAMAI_PROGRESS <json>` records on stderr. Subprocess stderr is never copied into the response, known secret values are redacted, and subprocesses inherit only an operational environment allowlist plus explicitly scoped command values.

The test response `output` is a machine-readable lifecycle with ordered step states, exact Git provenance, APK checksum/signature/version/host-overlay verification, declared browser/Android screenshot artifacts, hashed Mobilerun trajectory metadata, bounded errors, and `verdict`/`verdictEvidence`. Missing Git access, target browser/device, signing credentials, Rust, `apksigner`, ADB, `mobilerun`, selected runtime host, secure local Mobilerun config, credential-ID actions, trajectory screenshots, or final target UI is a terminal error. Error envelopes preserve only artifacts captured before the failure.

Required Android secrets for a real build:

- `ANDROID_UPLOAD_KEYSTORE_BASE64`
- `ANDROID_UPLOAD_STORE_PASSWORD`
- `ANDROID_UPLOAD_KEY_ALIAS`
- `ANDROID_UPLOAD_KEY_PASSWORD`

Optional Play upload secret: `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`. `version-apply` requires the scoped repository/GitHub token supplied by the agent.

Real Android chat tests additionally require `apksigner`, an active `rustup` toolchain for native video effects, a compatible installed `mobilerun` CLI/device, and mode-0600 `$HOME/.teamai/camble-mobilerun-config.yaml`. In automatic mode that config enables a mode-0600 credentials file exposing `CAMBLE_TEST_EMAIL` and `CAMBLE_TEST_PASSWORD`; a selected matrix account uses an ephemeral credential file instead. Values reach Mobilerun only through `type_secret`, never prompts, logs, Git, response metadata, or unencrypted durable state. `$HOME/.teamai/camble-mobilerun-trajectories` must resolve to a writable directory; large trajectory data should live on external storage.

## Verification

```bash
npm test
```

The test suite injects fake command/browser runners and synthetic Git/Kubernetes/Mobilerun fixtures. It covers exact environment/target validation, Desktop and 390×844 Mobile Chrome screenshots, `--reasoning`/vision command order, encrypted matrix-account handoff, ephemeral 0600 credential cleanup, secure credential-ID evidence, final target-screen assertions, immutable APK provenance, terminal failures, redacted progress, special Camble ref rules, and dry-run non-mutation. It never contacts or mutates GitHub, Google Play, Kubernetes, or a device.
