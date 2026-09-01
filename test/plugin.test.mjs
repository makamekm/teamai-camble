import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { createCommandRunner, execute, executeContract, planPromotion, PluginError } from "../plugin.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const D = "d".repeat(40);
const E = "e".repeat(40);
const DIGEST_A = `sha256:${"1".repeat(64)}`;
const DIGEST_B = `sha256:${"2".repeat(64)}`;
const repositories = [
  { id: "application3", url: "https://github.com/ruletvorg/application3", owner: "ruletvorg", name: "application3", token: "fake" },
  { id: "backend", url: "https://github.com/ruletvorg/backend", owner: "ruletvorg", name: "backend", token: "fake" },
];
async function root() { return mkdtemp(path.join(os.tmpdir(), "camble-plugin-test-")); }
function request(actionId, input, workspacePath) { return { apiVersion: 1, actionId, input, repositories, workspace: { path: workspacePath } }; }
function fakeRunner(handler) {
  const calls = [];
  const runner = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    return handler?.(command, args, options, calls) ?? { code: 0, stdout: "", stderr: "" };
  };
  runner.calls = calls;
  return runner;
}
function refsRunner(extra = {}) {
  return fakeRunner(async (command, args, options, calls) => {
    if (command === "git" && args[0] === "ls-remote") {
      const repo = args[1].includes("application3") ? "application3" : "backend";
      const pattern = args[2];
      if (pattern.startsWith("refs/tags/")) return { code: 0, stdout: extra.tags?.[pattern] ?? "", stderr: "" };
      const sha = extra.heads?.[`${repo}:${pattern}`] ?? (repo === "application3" ? A : B);
      return { code: 0, stdout: `${sha}\t${pattern}\n`, stderr: "" };
    }
    if (command === "git" && args[0] === "clone" && extra.clone) await extra.clone(args.at(-1), args[args.length - 2]);
    if (extra.handler) return extra.handler(command, args, options, calls);
    return { code: 0, stdout: "", stderr: "" };
  });
}
function statefulRefsRunner(extra = {}) {
  const state = new Map(Object.entries(extra.refs ?? {}));
  let pushNumber = 0;
  const repoId = (url) => url.includes("application3") ? "application3" : "backend";
  const defaultSha = (repo, ref) => {
    if (ref.startsWith("refs/tags/")) return null;
    if (ref === "refs/heads/prod") return repo === "application3" ? C : D;
    if (ref.startsWith("refs/heads/tags/")) return repo === "application3" ? C : D;
    return repo === "application3" ? A : B;
  };
  const read = (repo, ref) => state.has(`${repo}:${ref}`) ? state.get(`${repo}:${ref}`) : defaultSha(repo, ref);
  const runner = fakeRunner(async (command, args, options, calls) => {
    if (command === "git" && args[0] === "ls-remote") {
      const repo = repoId(args[1]);
      const ref = args[2];
      const sha = read(repo, ref);
      return { code: 0, stdout: sha ? `${sha}\t${ref}\n` : "", stderr: "" };
    }
    if (command === "git" && args[0] === "push") {
      pushNumber += 1;
      const leased = args[1].startsWith("--force-with-lease=");
      const urlIndex = leased ? 2 : 1;
      const repo = repoId(args[urlIndex]);
      const spec = args[urlIndex + 1].replace(/^\+/, "");
      const [targetSha, ref] = spec.split(":");
      const leaseValue = leased ? args[1].slice("--force-with-lease=".length) : null;
      const expectedSha = leased ? leaseValue.slice(ref.length + 1) || null : undefined;
      const injected = await extra.failPush?.({ pushNumber, repo, ref, targetSha, expectedSha, state, calls });
      if (injected) return typeof injected === "number" ? { code: injected, stdout: "", stderr: "" } : injected;
      if (leased && read(repo, ref) !== expectedSha) return { code: 1, stdout: "", stderr: "" };
      state.set(`${repo}:${ref}`, targetSha);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (command === "kubectl") return extra.kubectl?.(args, calls) ?? { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  runner.state = state;
  runner.read = read;
  return runner;
}
function recordedSpawn({ code = 0, stdout = "", stderr = "" } = {}) {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      if (stdout) child.stdout.write(stdout);
      if (stderr) child.stderr.write(stderr);
      child.stdout.end();
      child.stderr.end();
      child.emit("close", code);
    });
    return child;
  };
  spawnImpl.calls = calls;
  return spawnImpl;
}

test("manifest is executable schema v2 with only declared action contract", async () => {
  const manifest = JSON.parse(await (await import("node:fs/promises")).readFile(new URL("../teamai-plugin.json", import.meta.url), "utf8"));
  assert.equal(manifest.schemaVersion, 2);
  assert.deepEqual(manifest.runtime, { apiVersion: 1, engine: "node", entrypoint: "plugin.mjs" });
  assert.deepEqual(manifest.actions.map((item) => item.id), ["collect", "promote", "version-inspect", "version-apply", "android-build", "cluster-observe", "cluster-deploy"]);
  assert.deepEqual(manifest.actions.flatMap((action) => action.inputs).map((input) => input.id).filter((id) => !/^[a-z][a-z0-9-]*$/.test(id)), []);
  for (const action of manifest.actions.filter((item) => item.mode === "write")) assert.ok(action.confirm.length > 0);
  assert.equal(manifest.actions.find((item) => item.id === "android-build").inputs.some((input) => input.id === "track"), false);
  assert.equal(JSON.stringify(manifest).includes("production"), false);
});

test("collect resolves per-service dev to tags state with exact SHAs", async () => {
  const workspace = await root();
  const runner = refsRunner({
    heads: {
      "application3:refs/heads/tags/component": C,
      "backend:refs/heads/tags/admin-ui": B,
      "backend:refs/heads/tags/component": D,
    },
    clone: async (target) => {
      await mkdir(path.join(target, "services", "component"), { recursive: true });
      await mkdir(path.join(target, "services", "admin-ui"), { recursive: true });
      await writeFile(path.join(target, "services", "README"), "not a directory");
    },
  });
  const result = await execute(request("collect", { environment: "preprod" }, workspace), { runner });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.output.items, ["application3", "admin-ui", "component"]);
  assert.deepEqual(result.output.services.map(({ id, repository, sourceRef, targetRef, sourceSha, targetSha, status }) => ({ id, repository, sourceRef, targetRef, sourceSha, targetSha, status })), [
    { id: "application3", repository: "application3", sourceRef: "dev", targetRef: "tags/component", sourceSha: A, targetSha: C, status: "stale" },
    { id: "admin-ui", repository: "backend", sourceRef: "dev", targetRef: "tags/admin-ui", sourceSha: B, targetSha: B, status: "current" },
    { id: "component", repository: "backend", sourceRef: "dev", targetRef: "tags/component", sourceSha: B, targetSha: D, status: "stale" },
  ]);
  assert.equal(runner.calls.some((call) => call.args[0] === "push"), false);
});

test("prod collect compares every tags service ref with prod service ref", async () => {
  const workspace = await root();
  const runner = refsRunner({
    heads: {
      "application3:refs/heads/tags/component": C,
      "application3:refs/heads/prod/component": C,
      "backend:refs/heads/tags/component": D,
      "backend:refs/heads/prod/component": B,
    },
    clone: async (target) => { await mkdir(path.join(target, "services", "component"), { recursive: true }); },
  });
  const result = await execute(request("collect", { environment: "prod" }, workspace), { runner });
  assert.deepEqual(result.output.services.map(({ id, sourceRef, targetRef, status }) => ({ id, sourceRef, targetRef, status })), [
    { id: "application3", sourceRef: "tags/component", targetRef: "prod/component", status: "current" },
    { id: "component", sourceRef: "tags/component", targetRef: "prod/component", status: "stale" },
  ]);
});

test("preprod plan maps application and backend services from dev to tags branches", async () => {
  const workspace = await root();
  const runner = refsRunner({ heads: {
    "application3:refs/heads/tags/component": C,
    "backend:refs/heads/tags/component": D,
    "backend:refs/heads/tags/admin-ui": D,
  } });
  const value = request("promote", { environment: "preprod", items: ["application3", "component", "admin-ui"], dryRun: true }, workspace);
  const plan = await planPromotion(value, { runner });
  assert.deepEqual(plan.updates.map(({ item, repository, sourceRef, ref, sha, originalSha }) => ({ item, repository, sourceRef, ref, sha, originalSha })), [
    { item: "application3", repository: "application3", sourceRef: "refs/heads/dev", ref: "refs/heads/tags/component", sha: A, originalSha: C },
    { item: "component", repository: "backend", sourceRef: "refs/heads/dev", ref: "refs/heads/tags/component", sha: B, originalSha: D },
    { item: "admin-ui", repository: "backend", sourceRef: "refs/heads/dev", ref: "refs/heads/tags/admin-ui", sha: B, originalSha: D },
  ]);
  const result = await execute(value, { runner });
  assert.equal(result.output.dryRun, true);
  assert.equal(runner.calls.some((call) => call.args[0] === "push"), false);
});

test("prod plan promotes only selected tags branches to matching prod branches", async () => {
  const workspace = await root();
  const runner = refsRunner({ heads: {
    "application3:refs/heads/tags/component": C,
    "application3:refs/heads/prod/component": A,
    "backend:refs/heads/tags/admin-ui": D,
    "backend:refs/heads/prod/admin-ui": B,
  } });
  const result = await execute(request("promote", { environment: "prod", items: ["application3", "admin-ui"], dryRun: true }, workspace), { runner });
  assert.deepEqual(result.output.selectedItems, ["application3", "admin-ui"]);
  assert.deepEqual(result.output.updates.map(({ sourceRef, ref, sha, originalSha }) => ({ sourceRef, ref, sha, originalSha })), [
    { sourceRef: "refs/heads/tags/component", ref: "refs/heads/prod/component", sha: C, originalSha: A },
    { sourceRef: "refs/heads/tags/admin-ui", ref: "refs/heads/prod/admin-ui", sha: D, originalSha: B },
  ]);
});

test("multi-service promotion uses guarded writes and rolls back earlier writes on failure", async () => {
  const workspace = await root();
  const runner = statefulRefsRunner({
    refs: {
      "application3:refs/heads/tags/component": A,
      "application3:refs/heads/prod/component": C,
      "backend:refs/heads/tags/component": B,
      "backend:refs/heads/prod/component": D,
    },
    failPush: ({ pushNumber }) => pushNumber === 2 ? 7 : 0,
  });
  const result = await executeContract(request("promote", { environment: "prod", items: ["application3", "component"], dryRun: false }, workspace), { runner });
  assert.equal(result.exitCode, 1);
  assert.equal(result.response.status, "error");
  assert.equal(result.response.output.failure.original.item, "component");
  assert.equal(result.response.output.failure.rollback[0].outcome, "restored");
  assert.equal(runner.read("application3", "refs/heads/prod/component"), C);
});

test("version inspect and apply validate the next build and dry-run workflow dispatch", async () => {
  const workspace = await root();
  const runner = refsRunner({ clone: async (target) => {
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "app.json"), JSON.stringify({ expo: { version: "4.3.3-rc.1+build.7", android: { versionCode: "200422" }, ios: { buildNumber: "200422" } } }));
  } });
  const inspected = await execute(request("version-inspect", {}, workspace), { runner });
  assert.equal(inspected.output.versionName, "4.3.3-rc.1+build.7");
  assert.equal(inspected.output.nextBuildNumber, "200423");
  const planned = await execute(request("version-apply", { versionName: "4.4.0+build.9", buildNumber: 200423, dryRun: true }, workspace), { runner });
  assert.equal(planned.output.inputs.expectedSha, A);
  assert.equal(planned.output.workflow, "version-apply.yml");
  await assert.rejects(() => execute(request("version-apply", { versionName: "4.4.0", buildNumber: 7, dryRun: true }, workspace), { runner }), /must be 200423/);
  await assert.rejects(() => execute(request("version-apply", { versionName: "4.4.0-01", buildNumber: 200423, dryRun: true }, workspace), { runner }), /Invalid version name/);
});

test("application build resolves current dev tips on the selected agent", async () => {
  const workspace = await root();
  const runner = refsRunner();
  const result = await execute(request("android-build", { dryRun: true }, workspace), { runner });
  assert.equal(result.output.dryRun, true);
  assert.equal(result.output.verifiedBranch, "dev");
  assert.equal(result.output.storeTrack, "internal");
  assert.deepEqual(result.output.steps, ["resolve current dev SHAs", "clone exact SHAs", "npm ci/preinit", "signed APK+AAB", "optional Google Play Internal upload"]);
  assert.deepEqual(runner.calls.filter((call) => call.args[0] === "ls-remote").map((call) => call.args[2]), ["refs/heads/dev", "refs/heads/dev"]);
  assert.equal(runner.calls.some((call) => call.args[0] === "clone"), false);
  await assert.rejects(() => execute(request("android-build", { applicationSha: C, dryRun: true }, workspace), { runner }), /dev moved/);
  await assert.rejects(() => execute(request("android-build", { track: "production", dryRun: true }, workspace), { runner }), /fixed to internal/);
});

test("android build rejects generated iOS and Android build-number mismatch before signing", async () => {
  const workspace = await root();
  const runner = refsRunner({ clone: async (target, url) => {
    if (!url.includes("application3")) return;
    await mkdir(path.join(target, "builder"), { recursive: true });
    await writeFile(path.join(target, "app.json"), JSON.stringify({ expo: { version: "4.4.0-rc.1", android: { versionCode: 42 }, ios: { buildNumber: "41" } } }));
  } });
  await assert.rejects(() => execute(request("android-build", { applicationSha: A, backendSha: B, dryRun: false }, workspace), { runner }), /iOS buildNumber must equal Android versionCode/);
  assert.equal(runner.calls.some((call) => call.command === "./gradlew" || call.command === "gradlew.bat"), false);
});

test("Windows Android build uses the batch Gradle shim and preserves build-number parity", async () => {
  const workspace = await root();
  const runner = refsRunner({
    clone: async (target, url) => {
      if (!url.includes("application3")) return;
      await mkdir(path.join(target, "builder"), { recursive: true });
      await mkdir(path.join(target, "android", "app"), { recursive: true });
      await writeFile(path.join(target, "app.json"), JSON.stringify({ expo: { version: "4.4.0+windows.1", android: { versionCode: 42 }, ios: { buildNumber: "42" } } }));
      await writeFile(path.join(target, "android", "gradle.properties"), "org.gradle.daemon=false\n");
    },
    handler: async (command, args, options) => {
      if (command === "gradlew.bat") {
        const applicationRoot = path.dirname(options.cwd);
        const apk = path.join(applicationRoot, "android", "app", "build", "outputs", "apk", "release");
        const aab = path.join(applicationRoot, "android", "app", "build", "outputs", "bundle", "release");
        await mkdir(apk, { recursive: true });
        await mkdir(aab, { recursive: true });
        await writeFile(path.join(apk, "app-release.apk"), "apk");
        await writeFile(path.join(aab, "app-release.aab"), "aab");
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  const value = request("android-build", { applicationSha: A, backendSha: B, dryRun: false }, workspace);
  value.secrets = {
    ANDROID_UPLOAD_KEYSTORE_BASE64: Buffer.alloc(32, 1).toString("base64"),
    ANDROID_UPLOAD_STORE_PASSWORD: "store-secret",
    ANDROID_UPLOAD_KEY_ALIAS: "upload",
    ANDROID_UPLOAD_KEY_PASSWORD: "key-secret",
  };
  const result = await execute(value, { runner, platform: "win32", environment: {} });
  assert.equal(result.output.versionName, "4.4.0+windows.1");
  assert.equal(result.output.buildNumber, "42");
  assert.equal(result.output.storeTrack, "internal");
  assert.ok(runner.calls.some((call) => call.command === "gradlew.bat"));
});

function kubernetesResources(options = {}) {
  const applicationSha = options.applicationSha ?? A;
  const backendSha = options.backendSha ?? B;
  const deployment = (name, container, sha) => ({
    metadata: { name, generation: 3 },
    spec: {
      replicas: 2,
      selector: { matchLabels: { app: name } },
      template: { spec: { containers: [{ name: container, image: `registry/${name}:${sha}-test` }] } },
    },
    status: { observedGeneration: 3, updatedReplicas: 2, availableReplicas: 2, readyReplicas: 2, unavailableReplicas: 0, conditions: [{ type: "Available", status: "True" }, { type: "Progressing", status: "True" }] },
  });
  const deployments = [
    deployment("application-camee", "application", applicationSha),
    deployment("admin-camee", "admin", backendSha),
    deployment("component-camee", "component", backendSha),
  ];
  const pods = deployments.flatMap((item) => {
    const name = item.metadata.name;
    const container = item.spec.template.spec.containers[0];
    const digest = name === "application-camee" ? DIGEST_A : DIGEST_B;
    return [1, 2].map((number) => ({
      metadata: { name: `${name}-${number}`, labels: { app: name } },
      spec: { containers: [{ name: container.name, image: container.image }] },
      status: { phase: "Running", containerStatuses: [{ name: container.name, image: container.image, imageID: `containerd://registry/${name}@${digest}`, ready: true }] },
    }));
  });
  if (options.componentReady === false) {
    const component = deployments.find((item) => item.metadata.name === "component-camee");
    component.status.readyReplicas = 0;
    component.status.availableReplicas = 0;
  }
  if (options.secondComponentDigest) {
    const componentPods = pods.filter((item) => item.metadata.labels.app === "component-camee");
    componentPods[1].status.containerStatuses[0].imageID = `containerd://registry/component-camee@${options.secondComponentDigest}`;
  }
  return { deployments: { items: deployments }, pods: { items: pods } };
}
function kubectlResources(resources) {
  return (args) => {
    const resource = args[2];
    if (resource === "deployments") return { code: 0, stdout: JSON.stringify(resources.deployments), stderr: "" };
    if (resource === "pods") return { code: 0, stdout: JSON.stringify(resources.pods), stderr: "" };
    return { code: 1, stdout: "", stderr: "" };
  };
}

test("cluster observation verifies full source SHAs and exact running-pod image digests", async () => {
  const workspace = await root();
  const resources = kubernetesResources();
  const runner = fakeRunner((command, args) => command === "kubectl" ? kubectlResources(resources)(args) : { code: 0, stdout: "", stderr: "" });
  const result = await execute(request("cluster-observe", {}, workspace), { runner });
  assert.equal(result.output.namespace, "camee");
  assert.equal(result.output.rolledOut, true);
  assert.deepEqual(result.output.services.map((item) => [item.service, item.deployment, item.container, item.ready]), [
    ["application3", "application-camee", "application", true], ["admin-ui", "admin-camee", "admin", true], ["component", "component-camee", "component", true],
  ]);
  assert.deepEqual(result.output.services.map((item) => [item.sourceSha, item.resolvedDigest]), [[A, DIGEST_A], [B, DIGEST_B], [B, DIGEST_B]]);
  assert.ok(result.output.services.every((item) => item.pods.length === 2 && item.pods.every((pod) => pod.imageID && pod.digest)));
  assert.ok(runner.calls.some((call) => call.args.includes("component-camee")));
  assert.ok(runner.calls.some((call) => call.args[2] === "pods"));
});

test("cluster observation returns a bounded kubectl failure classification without raw stderr", async () => {
  const workspace = await root();
  const secret = "https://private-cluster.example/token-value";
  const runner = fakeRunner((command) => command === "kubectl"
    ? { code: 1, stdout: "", stderr: `Unable to connect to the server: dial tcp ${secret}: i/o timeout` }
    : { code: 0, stdout: "", stderr: "" });
  const { response, exitCode } = await executeContract(request("cluster-observe", {}, workspace), { runner });
  assert.equal(exitCode, 1);
  assert.equal(response.summary, "kubectl failed: CONNECTION_TIMEOUT");
  assert.deepEqual(response.output, { reason: "CONNECTION_TIMEOUT", exitCode: 1 });
  assert.equal(JSON.stringify(response).includes(secret), false);
});

test("cluster observation rejects truncated source tags and mixed pod digests", async () => {
  const workspace = await root();
  const resources = kubernetesResources({ secondComponentDigest: `sha256:${"3".repeat(64)}` });
  const application = resources.deployments.items.find((item) => item.metadata.name === "application-camee");
  application.spec.template.spec.containers[0].image = "registry/application-camee:aaaaaaaa-test";
  for (const pod of resources.pods.items.filter((item) => item.metadata.labels.app === "application-camee")) {
    pod.spec.containers[0].image = application.spec.template.spec.containers[0].image;
    pod.status.containerStatuses[0].image = application.spec.template.spec.containers[0].image;
  }
  const runner = fakeRunner((command, args) => command === "kubectl" ? kubectlResources(resources)(args) : { code: 0, stdout: "", stderr: "" });
  const result = await execute(request("cluster-observe", {}, workspace), { runner });
  assert.equal(result.output.rolledOut, false);
  const app = result.output.services.find((item) => item.service === "application3");
  const component = result.output.services.find((item) => item.service === "component");
  assert.equal(app.sourceSha, null);
  assert.equal(app.provenanceReady, false);
  assert.equal(component.resolvedDigest, null);
  assert.equal(component.digestMatches, false);
});

test("cluster dry-run plans application3 special target and backend component independently", async () => {
  const workspace = await root();
  const runner = refsRunner();
  const result = await execute(request("cluster-deploy", { sourceBranch: "test/release", services: ["application3", "component"], dryRun: true }, workspace), { runner });
  assert.deepEqual(result.output.updates, [
    { service: "application3", repository: "application3", sha: A, tagRef: `refs/tags/application3-${A}`, branchRef: "refs/heads/tags/component", originalBranchSha: A, provenance: { sourceSha: A, immutableTagRef: `refs/tags/application3-${A}`, expectedDigest: null } },
    { service: "component", repository: "backend", sha: B, tagRef: `refs/tags/component-${B}`, branchRef: "refs/heads/tags/component", originalBranchSha: B, provenance: { sourceSha: B, immutableTagRef: `refs/tags/component-${B}`, expectedDigest: null } },
  ]);
  assert.deepEqual(result.output.steps.map((item) => [item.phase, item.applyStatus]), [["immutable-tag", "planned"], ["immutable-tag", "planned"], ["branch", "unchanged"], ["branch", "unchanged"]]);
  assert.equal(runner.calls.some((call) => call.args[0] === "push" || call.command === "kubectl"), false);
});

test("cluster rollout locks and re-verifies the exact digest for the full source SHA", async () => {
  const workspace = await root();
  const resources = kubernetesResources();
  const runner = statefulRefsRunner({ kubectl: kubectlResources(resources) });
  const result = await execute(request("cluster-deploy", { sourceBranch: "dev", services: ["component"], dryRun: false }, workspace), { runner, now: () => 0, sleep: async () => {} });
  assert.equal(result.output.cluster.rolledOut, true);
  assert.equal(result.output.cluster.timedOut, false);
  assert.deepEqual(result.output.updates[0].provenance, { sourceSha: B, immutableTagRef: `refs/tags/component-${B}`, expectedDigest: DIGEST_B });
  const component = result.output.cluster.services.find((item) => item.service === "component");
  assert.equal(component.expectedSourceSha, B);
  assert.equal(component.expectedDigest, DIGEST_B);
  assert.equal(component.digestMatches, true);
  assert.deepEqual(result.output.provenanceRefs, [{ service: "component", repository: "backend", immutableTagRef: `refs/tags/component-${B}`, sourceSha: B, actualTagSha: B, expectedDigest: DIGEST_B, verified: true }]);
  assert.equal(runner.calls.filter((call) => call.command === "kubectl").length, 4);
});

test("cluster rollout rejects a different full SHA with the same eight-character prefix and restores its branch", async () => {
  const workspace = await root();
  const collidingSha = `aaaaaaaa${"e".repeat(32)}`;
  const resources = kubernetesResources({ applicationSha: collidingSha });
  const runner = statefulRefsRunner({ kubectl: kubectlResources(resources) });
  let nowCalls = 0;
  const result = await executeContract(request("cluster-deploy", { sourceBranch: "dev", services: ["application3"], dryRun: false }, workspace), {
    runner,
    now: () => nowCalls++ === 0 ? 0 : 900_000,
    sleep: async () => assert.fail("collision fixture should time out before sleeping"),
  });
  assert.equal(result.response.status, "error");
  const application = result.response.output.cluster.services.find((item) => item.service === "application3");
  assert.equal(application.sourceSha, collidingSha);
  assert.equal(application.expectedSourceSha, A);
  assert.equal(application.sourceMatches, false);
  assert.equal(result.response.output.failure.rollback.outcome, "restored");
  assert.equal(runner.read("application3", "refs/heads/tags/component"), C);
});

test("cluster rollout timeout returns durable tag, apply, and rollback outcomes", async () => {
  const workspace = await root();
  const resources = kubernetesResources({ componentReady: false });
  const runner = statefulRefsRunner({ kubectl: kubectlResources(resources) });
  let nowCalls = 0;
  const result = await executeContract(request("cluster-deploy", { sourceBranch: "dev", services: ["component"], dryRun: false }, workspace), {
    runner,
    now: () => nowCalls++ === 0 ? 0 : 900_000,
    sleep: async () => assert.fail("timeout fixture should not sleep"),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.response.status, "error");
  assert.match(result.response.summary, /did not become ready/);
  assert.equal(result.response.output.cluster.rolledOut, false);
  assert.equal(result.response.output.cluster.timedOut, true);
  assert.equal(result.response.output.cluster.services.find((item) => item.service === "component").ready, false);
  assert.deepEqual(result.response.output.retainedImmutableTags, [{ service: "component", repository: "backend", ref: `refs/tags/component-${B}`, sha: B }]);
  assert.deepEqual(result.response.output.steps.map((item) => [item.phase, item.applyStatus, item.rollback?.status]), [["immutable-tag", "created", undefined], ["branch", "succeeded", "succeeded"]]);
  assert.equal(result.response.output.failure.original.outcome, "timed-out");
  assert.equal(result.response.output.failure.rollback.outcome, "restored");
  assert.equal(runner.read("backend", "refs/heads/tags/component"), D);
});

test("cluster branch failure rolls back only plugin-updated branches and enumerates retained tags", async () => {
  const workspace = await root();
  const runner = statefulRefsRunner({ failPush: ({ pushNumber }) => pushNumber === 4 ? 7 : 0 });
  const result = await executeContract(request("cluster-deploy", { sourceBranch: "dev", services: ["admin-ui", "component"], dryRun: false }, workspace), { runner });
  assert.equal(result.response.status, "error");
  assert.deepEqual(result.response.output.retainedImmutableTags.map((item) => item.ref), [`refs/tags/admin-ui-${B}`, `refs/tags/component-${B}`]);
  assert.deepEqual(result.response.output.steps.map((item) => [item.phase, item.service, item.applyStatus, item.rollback?.status]), [
    ["immutable-tag", "admin-ui", "created", undefined],
    ["immutable-tag", "component", "created", undefined],
    ["branch", "admin-ui", "succeeded", "succeeded"],
    ["branch", "component", "failed", "not-needed"],
  ]);
  assert.equal(result.response.output.failure.original.outcome, "push-failed");
  assert.equal(result.response.output.failure.rollback.outcome, "restored");
  assert.equal(runner.read("backend", "refs/heads/tags/admin-ui"), D);
  assert.equal(runner.read("backend", "refs/heads/tags/component"), D);
});

test("cluster rollback lease conflict preserves a concurrent branch update", async () => {
  const workspace = await root();
  const resources = kubernetesResources({ componentReady: false });
  const runner = statefulRefsRunner({
    kubectl: kubectlResources(resources),
    failPush: ({ pushNumber, state }) => {
      if (pushNumber === 3) state.set("backend:refs/heads/tags/component", E);
      return 0;
    },
  });
  let nowCalls = 0;
  const result = await executeContract(request("cluster-deploy", { sourceBranch: "dev", services: ["component"], dryRun: false }, workspace), {
    runner,
    now: () => nowCalls++ === 0 ? 0 : 900_000,
    sleep: async () => assert.fail("concurrency fixture should time out before sleeping"),
  });
  assert.equal(result.response.status, "error");
  assert.equal(result.response.output.failure.rollback.outcome, "lease-conflict");
  assert.deepEqual(result.response.output.failure.rollback.steps[0], { service: "component", repository: "backend", ref: "refs/heads/tags/component", expectedSha: B, targetSha: D, outcome: "lease-conflict", actualSha: E });
  assert.equal(result.response.output.steps.find((item) => item.phase === "branch").rollback.status, "lease-conflict");
  assert.equal(runner.read("backend", "refs/heads/tags/component"), E);
});

test("cluster immutable tag creation fails closed on a concurrent collision before branch writes", async () => {
  const workspace = await root();
  const runner = statefulRefsRunner({
    failPush: ({ pushNumber, state }) => {
      if (pushNumber === 1) state.set(`backend:refs/tags/component-${B}`, E);
      return 0;
    },
  });
  const result = await executeContract(request("cluster-deploy", { sourceBranch: "dev", services: ["component"], dryRun: false }, workspace), { runner });
  assert.equal(result.response.status, "error");
  assert.equal(result.response.output.failure.original.outcome, "lease-conflict");
  assert.equal(result.response.output.failure.original.actualSha, E);
  assert.equal(result.response.output.failure.rollback.outcome, "not-needed");
  assert.deepEqual(result.response.output.retainedImmutableTags, []);
  assert.equal(runner.calls.filter((call) => call.args[0] === "push").length, 1);
  assert.equal(runner.read("backend", "refs/heads/tags/component"), D);
});

test("cluster recovery safely reuses an existing immutable tag at the exact source SHA", async () => {
  const workspace = await root();
  const runner = statefulRefsRunner({ refs: { [`backend:refs/tags/component-${B}`]: B } });
  const result = await execute(request("cluster-deploy", { sourceBranch: "dev", services: ["component"], dryRun: true }, workspace), { runner });
  assert.deepEqual(result.output.steps.map((item) => [item.phase, item.applyStatus]), [["immutable-tag", "preexisting"], ["branch", "planned"]]);
  assert.equal(result.output.steps[1].expectedSha, D);
  assert.deepEqual(result.output.steps[1].rollback, { expectedSha: B, targetSha: D, status: "available" });
  assert.equal(runner.calls.some((call) => call.args[0] === "push"), false);
});

test("strict booleans reject malformed dryRun values before any action work", async () => {
  const workspace = await root();
  const cases = [
    ["promote", { environment: "prod", applicationSha: A, backendSha: B }],
    ["version-apply", { versionName: "4.4.0", buildNumber: 2 }],
    ["android-build", { applicationSha: A, backendSha: B }],
    ["cluster-deploy", { sourceBranch: "dev", services: ["component"] }],
  ];
  for (const malformed of ["true", 1, null, {}]) {
    for (const [action, input] of cases) {
      const runner = fakeRunner(() => assert.fail(`${action} must not invoke a subprocess`));
      let fetchCalls = 0;
      const result = await executeContract(request(action, { ...input, dryRun: malformed }, workspace), { runner, fetch: async () => { fetchCalls += 1; } });
      assert.equal(result.response.status, "error", `${action} accepted ${JSON.stringify(malformed)}`);
      assert.equal(result.exitCode, 1);
      assert.equal(runner.calls.length, 0);
      assert.equal(fetchCalls, 0);
    }
  }
});

test("CLI emits an error response and exits nonzero for malformed dryRun", async () => {
  const workspace = await root();
  const value = request("android-build", { applicationSha: A, backendSha: B, dryRun: "true" }, workspace);
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("../plugin.mjs", import.meta.url))], { input: JSON.stringify(value), encoding: "utf8" });
  assert.equal(child.status, 1);
  assert.equal(child.stderr, "");
  const response = JSON.parse(child.stdout);
  assert.equal(response.status, "error");
  assert.match(response.summary, /Invalid boolean/);
});

test("Windows command runner uses cmd shims and an inherited environment allowlist", async () => {
  const spawnImpl = recordedSpawn();
  const runner = createCommandRunner({
    platform: "win32",
    environment: { PATH: "C:\\tools", ComSpec: "C:\\Windows\\System32\\cmd.exe", TOP_SECRET: "must-not-leak" },
    spawnImpl,
  });
  await runner("npm", ["ci", "--no-audit"], { env: { BACKEND_BRANCH: A } });
  await runner("gradlew.bat", ["app:bundleRelease", "-Dvalue=with space"]);
  assert.equal(spawnImpl.calls[0].command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(spawnImpl.calls[0].args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(spawnImpl.calls[0].args[3], '""npm.cmd" "ci" "--no-audit""');
  assert.equal(spawnImpl.calls[1].args[3], '""gradlew.bat" "app:bundleRelease" "-Dvalue=with space""');
  assert.equal(spawnImpl.calls[0].options.windowsVerbatimArguments, true);
  assert.equal(spawnImpl.calls[0].options.env.PATH, "C:\\tools");
  assert.equal(spawnImpl.calls[0].options.env.BACKEND_BRANCH, A);
  assert.equal(spawnImpl.calls[0].options.env.TOP_SECRET, undefined);
});

test("command errors omit raw stderr and contract errors redact all known secrets", async () => {
  const stderrSecret = "raw-stderr-private-value";
  const spawnImpl = recordedSpawn({ code: 7, stderr: `tool failed with ${stderrSecret}` });
  const commandRunner = createCommandRunner({ environment: { PATH: "/bin", UNRELATED_SECRET: stderrSecret }, spawnImpl });
  await assert.rejects(() => commandRunner("git", ["status"]), (error) => {
    assert.equal(error.message, "git failed with exit code 7");
    assert.equal(error.message.includes(stderrSecret), false);
    return true;
  });
  assert.equal(spawnImpl.calls[0].options.env.UNRELATED_SECRET, undefined);

  const workspace = await root();
  const subprocessContract = await executeContract(request("collect", { environment: "prod" }, workspace), { runner: commandRunner });
  assert.equal(subprocessContract.response.status, "error");
  assert.equal(JSON.stringify(subprocessContract.response).includes(stderrSecret), false);

  const requestSecret = "request-private-value";
  const environmentSecret = "environment-private-value";
  const value = request("collect", { environment: "prod" }, workspace);
  value.secrets = { CUSTOM_SECRET: requestSecret };
  const runner = fakeRunner(() => { throw new PluginError(`failure ${requestSecret} ${environmentSecret}`, { detail: requestSecret, nested: [environmentSecret] }); });
  const result = await executeContract(value, { runner, environment: { GITHUB_TOKEN: environmentSecret } });
  const serialized = JSON.stringify(result.response);
  assert.equal(result.response.status, "error");
  assert.equal(serialized.includes(requestSecret), false);
  assert.equal(serialized.includes(environmentSecret), false);
  assert.match(serialized, /\[REDACTED\]/);
});

test("validation rejects unknown actions, unsafe branches and malformed requests", async () => {
  const workspace = await root(); const runner = refsRunner();
  await assert.rejects(() => execute(request("missing", {}, workspace), { runner }), /Unknown action/);
  await assert.rejects(() => execute(request("cluster-deploy", { sourceBranch: "main", services: ["component"], dryRun: true }, workspace), { runner }), /Invalid source branch/);
  await assert.rejects(() => execute({ ...request("collect", {}, workspace), apiVersion: 2 }, { runner }), /Unsupported/);
});
