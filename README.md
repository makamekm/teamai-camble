# Camble Release plugin for TeamAI

Executable external plugin implementing TeamAI plugin contract v2. TeamAI pins this repository commit and a free agent runs `node plugin.mjs` with the versioned JSON request on stdin. Product policy and procedures live here rather than in TeamAI core.

## Actions

- `collect` — resolves exact `application3`/`backend` source SHAs. Preprod collection reads service directories from `backend/services` at the exact `dev` SHA; Prod collects both `preprod` SHAs.
- `promote` — verifies the collected SHAs have not moved. Preprod treats `application3` and `component` specially and gives every other backend item an immutable `<item>-N` tag plus `tags/<item>` branch. Prod compare-and-swaps each destination branch against its preflight SHA. If the second repository update fails, rollback compare-and-swaps the first branch only when it still contains the plugin-written SHA, so concurrent changes are preserved and reported as lease conflicts.
- `version-inspect` / `version-apply` — reads `app.json` on `application3:dev`, validates equal iOS/Android build numbers, requires the next build number, and dispatches `version-apply.yml` with `expectedSha`. SemVer prerelease and build metadata are accepted.
- `android-build` — first verifies that both supplied SHAs are the current `preprod` tips, then clones them, runs Camble preinit, validates equal iOS/Android build numbers, builds signed APK+AAB, declares both artifacts, and optionally uploads the AAB to the fixed Google Play Internal track.
- `test` — the action bound to `surfaces.chat.test`. It accepts exactly `test.rulet.tv` or `peprod.rulet.tv` and only the `Android` target; the required test case is prefilled from the TeamAI chat problem. Repository branch bindings selected by the scheduler are used when explicit branch inputs are absent. It resolves both source branches to full immutable SHAs, applies a hashed test-only native-host overlay for the selected environment, builds one immutable signed APK, installs and verifies that exact version through ADB, clears stale app data, proves the runtime host from React Native logs, then runs `mobilerun run` with reasoning, vision, 80 steps and action-level trajectory capture. The prompt requires privacy/cookie and age gates, the existing-account login through Mobilerun secret IDs, the exact test case, all requested interaction assertions, and a final independently verifiable target screen. The large transient APK is represented by SHA/signature/version/overlay provenance but is not uploaded through TeamAI's bounded evidence channel.
- `cluster-observe` — reads the fixed `camee` deployment/container mapping and its active pods through `kubectl`. A service is ready only when its deployment image carries a full 40-character source SHA and every matching running pod is ready on that exact image with one valid, identical `sha256` imageID digest. Truncated tags, mixed digests, missing pods, and image mismatches fail closed.
- `cluster-deploy` — accepts `dev` or a bounded test/feature/fix branch and preflights every source, destination branch, and deterministic `refs/tags/<service>-<full-source-SHA>` provenance tag. It safely creates or reuses all immutable tags before compare-and-swapping Devtron branches. After rollout it locks the observed pod digest for each selected service and re-reads the exact deployments and pods to verify the full SHA/digest pair. A timeout or later failure rolls back only branches written by this invocation, using the plugin-written SHA as the rollback lease; retained immutable tags and all original/apply/rollback outcomes are returned. `application3` deliberately advances its own `tags/component`; backend services advance `tags/<item>`.

The release/deploy write actions support `dryRun` and default it to `true`. Dry runs calculate and return the complete plan but perform no GitHub, Google Play, or Kubernetes mutation. Chat `test` intentionally has no dry-run input: a successful run must contain evidence from real selected targets and never reports a simulated pass.

## Request and response

The entrypoint accepts one bounded TeamAI `apiVersion: 1` request on stdin. It recognizes `actionId` (and the equivalent `action.id`), `input`, declared repositories with authenticated HTTPS URLs and scheduler-selected `defaultBranch` values, an absolute temporary workspace path, and supplied secrets. Boolean inputs must be JSON booleans. It emits exactly one contract response on stdout and exits nonzero for errors. Test progress is emitted separately as redacted single-line `TEAMAI_PROGRESS <json>` records on stderr. Subprocess stderr is never copied into the response, known secret values are redacted, and subprocesses inherit only an operational environment allowlist plus explicitly scoped command values.

The test response `output` is a machine-readable lifecycle with ordered step states, exact Git provenance, APK checksum/signature/version/host-overlay verification, direct screenshots, hashed Mobilerun trajectory metadata, bounded errors, and `verdict`/`verdictEvidence`. Missing Git access, signing credentials, Rust, `apksigner`, ADB, `mobilerun`, a fresh matching device, selected runtime host, secure local Mobilerun config, both credential-ID actions, sufficient trajectory screenshots, or the final target UI is a terminal error. Error envelopes declare no upload artifacts, so the real test failure cannot be replaced by a secondary artifact transport error.

Required Android secrets for a real build:

- `ANDROID_UPLOAD_KEYSTORE_BASE64`
- `ANDROID_UPLOAD_STORE_PASSWORD`
- `ANDROID_UPLOAD_KEY_ALIAS`
- `ANDROID_UPLOAD_KEY_PASSWORD`

Optional Play upload secret: `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON`. `version-apply` requires the scoped repository/GitHub token supplied by the agent.

Real Android chat tests additionally require `apksigner`, an active `rustup` toolchain for native video effects, a compatible installed `mobilerun` CLI/device, and mode-0600 `$HOME/.teamai/camble-mobilerun-config.yaml`. That config must enable a mode-0600 credentials file exposing `CAMBLE_TEST_EMAIL` and `CAMBLE_TEST_PASSWORD` to Mobilerun's `type_secret` tool without putting credential values in prompts, plugin inputs, logs, Git, or TeamAI durable state. `$HOME/.teamai/camble-mobilerun-trajectories` must resolve to a writable directory; large trajectory data should live on external storage.

## Verification

```bash
npm test
```

The test suite injects a fake command runner and synthetic Git/Kubernetes/Mobilerun fixtures. It covers reads, mutation planning, stale-SHA and exact Android-only test-input validation, `--reasoning`/vision command order, secure credential-ID evidence, final target-screen assertions, immutable APK provenance, terminal failures, redacted progress, special Camble ref rules, and dry-run non-mutation. It never contacts or mutates GitHub, Google Play, Kubernetes, or a device.
