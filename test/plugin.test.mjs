import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { createCommandRunner, createProgressReporter, execute, executeContract, planPromotion, PluginError } from "../plugin.mjs";

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
  assert.deepEqual(manifest.actions.map((item) => item.id), ["collect", "promote", "version-inspect", "version-apply", "android-build", "test", "cluster-observe", "cluster-logs", "cluster-deploy"]);
  assert.deepEqual(manifest.surfaces, { chat: { test: { actionId: "test" } } });
  assert.deepEqual(manifest.actions.flatMap((action) => action.inputs).map((input) => input.id).filter((id) => !/^[a-z][a-z0-9-]*$/.test(id)), []);
  for (const action of manifest.actions.filter((item) => item.mode === "write")) assert.ok(action.confirm.length > 0);
  assert.equal(manifest.actions.find((item) => item.id === "android-build").inputs.some((input) => input.id === "track"), false);
  const chatTest = manifest.actions.find((item) => item.id === "test");
  assert.equal(chatTest.mode, "write");
  assert.deepEqual(chatTest.inputs.map(({ id, type, required }) => ({ id, type, required })), [
    { id: "environment", type: "enum", required: true },
    { id: "targets", type: "multiselect", required: true },
    { id: "device-id", type: "string", required: false },
    { id: "comment", type: "string", required: true },
    { id: "application-branch", type: "string", required: false },
    { id: "backend-branch", type: "string", required: false },
  ]);
  assert.deepEqual(chatTest.inputs[0].options.map((item) => item.value), ["test.rulet.tv", "peprod.rulet.tv"]);
  assert.equal(chatTest.inputs[0].default, "test.rulet.tv");
  assert.deepEqual(chatTest.inputs[1].options.map((item) => item.value), ["Android"]);
  assert.deepEqual(chatTest.inputs[1].default, ["Android"]);
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
  assert.equal(result.output.gradleAttempts, 1);
  assert.equal(result.output.storeTrack, "internal");
  assert.ok(runner.calls.some((call) => call.command === "gradlew.bat"));
});

test("Android build retries one transient Gradle failure in the same workspace", async () => {
  const workspace = await root();
  let gradleCalls = 0;
  const runner = refsRunner({
    clone: async (target, url) => {
      if (!url.includes("application3")) return;
      await mkdir(path.join(target, "builder"), { recursive: true });
      await mkdir(path.join(target, "android", "app"), { recursive: true });
      await writeFile(path.join(target, "app.json"), JSON.stringify({ expo: { version: "4.4.0+retry.1", android: { versionCode: 42 }, ios: { buildNumber: "42" } } }));
      await writeFile(path.join(target, "android", "gradle.properties"), "org.gradle.daemon=false\n");
    },
    handler: async (command, args, options) => {
      if (command === "gradlew.bat") {
        gradleCalls += 1;
        if (gradleCalls === 1) throw new Error("gradlew transient native build failure");
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
  const result = await execute(value, { runner, platform: "win32", environment: {}, sleep: async () => {} });
  assert.equal(result.output.gradleAttempts, 2);
  assert.equal(gradleCalls, 2);
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

test("cluster logs collect bounded recent logs for every configured deployment", async () => {
  const runner = fakeRunner(async (command, args) => {
    assert.equal(command, "kubectl");
    assert.ok(args.includes("--since=6h"));
    assert.ok(args.includes("--tail=1000"));
    return { code: 0, stdout: `recent log from ${args[2]}\n`, stderr: "" };
  });
  const { response, exitCode } = await executeContract(request("cluster-logs", {}), { runner });
  assert.equal(exitCode, 0);
  assert.equal(response.status, "ok");
  assert.equal(response.output.namespace, "camee");
  assert.equal(response.output.services.length, 4);
  assert.equal(response.output.services.every((item) => item.status === "ok" && item.logs.includes("recent log")), true);
  assert.equal(runner.calls.length, 4);
});

test("cluster observation returns a bounded kubectl failure reason without leaking stderr", async () => {
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
    environment: { PATH: "C:\\tools", ComSpec: "C:\\Windows\\System32\\cmd.exe", KUBECONFIG: "C:\\Temp\\managed-kubeconfig.yaml", TOP_SECRET: "must-not-leak" },
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
  assert.equal(spawnImpl.calls[0].options.env.KUBECONFIG, "C:\\Temp\\managed-kubeconfig.yaml");
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

function htmlResponse(url, options = {}) {
  const body = options.body ?? "<!doctype html><html><head><title>Camble</title></head><body><main>ready</main></body></html>";
  return {
    status: options.status ?? 200,
    url: options.finalUrl ?? url,
    headers: { get: (name) => name.toLowerCase() === "content-type" ? (options.contentType ?? "text/html; charset=utf-8") : null },
    text: async () => body,
  };
}

function browserTestRunner(workspace, options = {}) {
  return refsRunner({
    heads: {
      "application3:refs/heads/feature/chat-test": C,
      "backend:refs/heads/fix/chat-test": D,
    },
    handler: async (command, args) => {
      if (command !== "chrome") return { code: options.chromeMissing ? 1 : 0, stdout: "", stderr: "" };
      if (args[0] === "--version") return { code: options.chromeMissing ? 1 : 0, stdout: "Google Chrome 140.0.0\n", stderr: "" };
      if (args.includes("--dump-dom")) return { code: 0, stdout: options.invalidDom ? "<html><body>chrome-error://chromewebdata ERR_FAILED</body></html>" : "<!doctype html><html><head><title>Camble Test</title></head><body><div id=\"root\">ready</div></body></html>", stderr: "" };
      const screenshot = args.find((item) => item.startsWith("--screenshot="))?.slice("--screenshot=".length);
      if (screenshot) await writeFile(screenshot, `browser-${path.basename(screenshot)}`);
      return { code: 0, stdout: "", stderr: "" };
    },
  });
}

async function prepareMobilerunCaseHome(workspace) {
  const home = path.join(workspace, "home");
  const teamai = path.join(home, ".teamai");
  const trajectoryRoot = path.join(teamai, "camble-mobilerun-trajectories");
  await mkdir(trajectoryRoot, { recursive: true });
  await writeFile(path.join(teamai, "camble-mobilerun-config.yaml"), "credentials:\n  enabled: true\n", { mode: 0o600 });
  await writeFile(path.join(teamai, "camble-mobilerun-credentials.yaml"), [
    "secrets:",
    "  CAMBLE_TEST_EMAIL:",
    '    value: "qa-existing@example.com" # inline comment',
    "    enabled: true",
    "  CAMBLE_TEST_PASSWORD:",
    '    value: "test-password-value"',
    "    enabled: true",
    "",
  ].join("\n"), { mode: 0o600 });
  return { HOME: home };
}

function androidTestRunner(workspace, options = {}) {
  let mobileUI = "initial";
  let screenshotNumber = 0;
  let mobilerunRuns = 0;
  let feedTapAttempts = 0;
  const signedApkContent = options.failure === "runtime-host"
    ? "signed-apk-content https://stage.rulet.tv"
    : "signed-apk-content https://test.rulet.tv";
  return refsRunner({
    heads: {
      "application3:refs/heads/feature/chat-test": C,
      "backend:refs/heads/fix/chat-test": D,
    },
    clone: async (target, url) => {
      if (!url.includes("application3")) return;
      await mkdir(path.join(target, "builder"), { recursive: true });
      await mkdir(path.join(target, "android", "app"), { recursive: true });
      await mkdir(path.join(target, "src", "state"), { recursive: true });
      await writeFile(path.join(target, "app.json"), JSON.stringify({ expo: { version: "5.2.0-test.1", android: { versionCode: 73, package: "com.rulettv.app" }, ios: { buildNumber: "73" } } }));
      await writeFile(path.join(target, "android", "gradle.properties"), "org.gradle.daemon=false\n");
      await writeFile(path.join(target, "src", "state", "firebase.native.ts"), [
        'state.config.next({ "host": "https://prod.rulet.tv", "stage_host": "https://stage.rulet.tv", "stage": false });',
        'state.config.next({ ...state.config.value, ...parseRemoteConfigValues(), });',
        'console.log("Config:", state.config.value);',
        'state.config.next({ ...state.config.value, ...parseRemoteConfigValues(), });',
        '',
      ].join('\n'));
    },
    handler: async (command, args, commandOptions) => {
      if (command === "./gradlew" || command === "gradlew.bat") {
        const applicationRoot = path.dirname(commandOptions.cwd);
        const apkDir = path.join(applicationRoot, "android", "app", "build", "outputs", "apk", "release");
        await mkdir(apkDir, { recursive: true });
        await writeFile(path.join(apkDir, "app-release.apk"), signedApkContent);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "apksigner") {
        if (args[0] === "version") return { code: options.failure === "apksigner" ? 1 : 0, stdout: "0.9\n", stderr: "" };
        return { code: options.failure === "signature" ? 1 : 0, stdout: `Verifies\nSigner #1 certificate SHA-256 digest: ${"3".repeat(64)}\n`, stderr: "" };
      }
      if (command === "rustup") {
        if (args[0] === "--version") return { code: 0, stdout: "rustup 1.29.0\n", stderr: "" };
        return { code: options.failure === "rust-toolchain" ? 1 : 0, stdout: "stable-test (default)\n", stderr: "" };
      }
      if (command === "adb") {
        if (args[0] === "version") return { code: 0, stdout: "Android Debug Bridge version 1.0.41\n", stderr: "" };
        if (args.includes("install")) return { code: options.failure === "install" ? 1 : 0, stdout: "Success\n", stderr: "" };
        if (args.includes("clear")) return { code: options.failure === "clear-state" ? 1 : 0, stdout: options.failure === "clear-state" ? "Failed\n" : "Success\n", stderr: "" };
        if (args.includes("dumpsys")) return { code: 0, stdout: options.failure === "version" ? "versionCode=72 versionName=5.1.0\n" : "versionCode=73 minSdk=26 targetSdk=36\nversionName=5.2.0-test.1\n", stderr: "" };
        if (args.includes("pm") && args.includes("path")) return { code: 0, stdout: "package:/data/app/com.rulettv.app/base.apk\n", stderr: "" };
        if (args.includes("pull")) {
          await writeFile(args.at(-1), options.failure === "installed-artifact" ? "different installed apk" : signedApkContent);
          return { code: 0, stdout: "1 file pulled\n", stderr: "" };
        }
        if (args.includes("pidof")) return { code: options.failure === "runtime-pid" ? 1 : 0, stdout: options.failure === "runtime-pid" ? "" : "4242\n", stderr: "" };
        if (args.includes("logcat")) {
          if (args.includes("-c")) return { code: options.failure === "logcat-clear" ? 1 : 0, stdout: "", stderr: "" };
          const runtimeHost = options.failure === "runtime-config" ? "https://stage.rulet.tv" : "https://test.rulet.tv";
          const runtimeMarker = options.failure === "runtime-marker" ? "Config:" : "TEAMAI_CHAT_TEST_RUNTIME_CONFIG";
          return { code: 0, stdout: `[com.rulettv.app] ${runtimeMarker} {"host":"${runtimeHost}","stage_host":"${runtimeHost}","stage":false}\n`, stderr: "" };
        }
      }
      if (command === "mobilerun") {
        if (args[0] === "--version") return { code: 0, stdout: "mobilerun 1.0\n", stderr: "" };
        if (args[0] === "devices") return { code: 0, stdout: options.failure === "device" ? "No local devices connected.\n" : "Found 1 local device(s):\n  • DEVICE-1\n", stderr: "" };
        if (args[0] === "ping") return { code: options.failure === "ping" ? 1 : 0, stdout: "ready\n", stderr: "" };
        if (args[0] === "device" && args[1] === "install") return { code: options.failure === "install" ? 2 : 0, stdout: "installed\n", stderr: "" };
        if (args[0] === "device" && args[1] === "apps") return { code: 0, stdout: options.failure === "apps" ? "com.android.chrome\n" : "com.rulettv.app  (Camble)\ncom.android.chrome\n", stderr: "" };
        if (args[0] === "device" && args[1] === "start") { mobileUI = "initial"; return { code: 0, stdout: "started\n", stderr: "" }; }
        if (args[0] === "run") {
          mobilerunRuns += 1;
          const omitTrajectory = options.failure === "trajectory";
          const emptyTrajectory = options.failure === "trajectory-once" && mobilerunRuns === 1;
          if (!omitTrajectory) {
            const home = path.join(workspace, "home");
            const directory = path.join(home, ".teamai", "camble-mobilerun-trajectories", `trajectory_20260903_120000_${mobilerunRuns}`);
            const screenshots = path.join(directory, "screenshots");
            await mkdir(screenshots, { recursive: true });
            const secretActions = [
              { action: "type_secret", secret_id: "CAMBLE_TEST_EMAIL" },
              ...(new Set(["credential-evidence", "existing-account-mismatch"]).has(options.failure) ? [] : [{ action: "type_secret", secret_id: "CAMBLE_TEST_PASSWORD" }]),
            ];
            const profileNodes = [
              { class: "TextView", text: "Eva", bounds: { left: 20, top: 20, right: 120, bottom: 80 } },
              { class: "ViewGroup", text: "Chat", bounds: { left: 100, top: 700, right: 250, bottom: 800 } },
              ...(options.failure === "trajectory-controls" ? [] : [{ class: "ViewGroup", text: "Gift", bounds: { left: 300, top: 700, right: 450, bottom: 800 } }]),
              { class: "Button", text: "Close", bounds: { left: 500, top: 700, right: 600, bottom: 800 } },
            ];
            const actions = [
              ...secretActions,
              { action: "tap", x: 150, y: 750, pre_state: { screen: "profile", nodes: profileNodes } },
              options.failure === "trajectory-noop"
                ? { action: "wait", duration: 0.5, pre_state: { screen: "profile", nodes: profileNodes } }
                : { action: "wait", duration: 0.5, pre_state: { screen: "chat", nodes: [{ text: "Conversation with Eva", bounds: { left: 0, top: 0, right: 600, bottom: 900 } }] } },
              { action: "tap", x: 350, y: 750, pre_state: { screen: "profile", nodes: profileNodes } },
              { action: "wait", duration: 0.5, pre_state: { screen: "gifts", nodes: [{ text: "Gifts", bounds: { left: 0, top: 0, right: 600, bottom: 900 } }] } },
              { action: "tap", x: 550, y: 750, pre_state: { screen: "profile", nodes: profileNodes } },
              { action: "wait", duration: 0.5, pre_state: { screen: "feed", nodes: [{ text: "page_feed", bounds: { left: 0, top: 0, right: 600, bottom: 900 } }] } },
              { action: "tap", x: 4, y: 4 }, { action: "tap", x: 5, y: 5 },
            ];
            await writeFile(path.join(directory, "macro.json"), JSON.stringify({ macro_schema_version: "1", version: "1", total_actions: actions.length, actions }));
            const terminal = options.failure === "terminal-boundary"
              ? { type: "ResultEvent", success: false, reason: `${"x".repeat(1_998)}qa-existing@example.com` }
              : options.failure === "existing-account-mismatch"
              ? { type: "ManagerPlanDetailsEvent", success: false, answer: "The provided email is not recognized as an existing account and the flow is attempting to create a new password." }
              : options.failure === "terminal-reason"
                ? { type: "ManagerPlanDetailsEvent", success: false, answer: "The target profile could not be reached." }
                : options.failure === "terminal-missing"
                  ? { type: "ManagerPlanDetailsEvent", success: null, answer: "" }
                  : { type: "ResultEvent", success: options.failure !== "thinking", reason: options.failure === "thinking" ? "The autonomous case failed for qa-existing@example.com with test-password-value." : "" };
            const trajectory = emptyTrajectory
              ? []
              : options.failure === "terminal-missing"
              ? [{ type: "ResultEvent", success: true, answer: "Premature result" }, terminal]
              : [terminal];
            await writeFile(path.join(directory, "trajectory.json"), JSON.stringify(trajectory));
            for (let index = 0; index < 4; index += 1) await writeFile(path.join(screenshots, `${String(index).padStart(4, "0")}.png`), `trajectory-screenshot-${index}`);
          }
          mobileUI = new Set(["final-feed", "final-feed-stubborn"]).has(options.failure) ? "feed" : "final";
          return { code: omitTrajectory || emptyTrajectory || new Set(["thinking", "existing-account-mismatch", "terminal-reason", "terminal-boundary"]).has(options.failure) ? 3 : 0, stdout: "Mobilerun reasoning complete\n", stderr: "" };
        }
        if (args[0] === "device" && args[1] === "tap") {
          const x = Number(args[4]);
          if (mobileUI === "feed") {
            feedTapAttempts += 1;
            if (options.failure === "final-feed-stubborn" && feedTapAttempts === 1) return { code: 0, stdout: "Tapped\n", stderr: "" };
            mobileUI = "opening";
            return { code: 0, stdout: "Tapped\n", stderr: "" };
          }
          mobileUI = options.failure === "button-noop" ? "target" : x < 250 ? "chat-result" : x < 450 ? "gift-result" : "closed";
          return { code: 0, stdout: "tapped\n", stderr: "" };
        }
        if (args[0] === "device" && args[1] === "press") {
          mobileUI = "target";
          return { code: 0, stdout: "back\n", stderr: "" };
        }
        if (args[0] === "device" && args[1] === "ui") {
          let stdout = "";
          if (options.failure !== "apk-ui") {
            if (mobileUI === "feed") stdout = '1. android.view.ViewGroup: "page_feed" - (0,0,600,900)\n2. android.view.ViewGroup: "Eva, Online" - (20,100,580,700)\n';
            else if (mobileUI === "opening") {
              mobileUI = "target";
              stdout = '1. android.view.View: "Eva" - (0,0,600,700)\n';
            }
            else if (mobileUI === "chat-result") stdout = '1. android.view.View: "Conversation with Eva" - (0,0,600,900)\n';
            else if (mobileUI === "gift-result") stdout = '1. android.view.View: "Send a gift to Eva" - (0,0,600,900)\n';
            else if (mobileUI === "closed") stdout = '1. android.view.View: "Feed Eva" - (0,0,600,900)\n';
            else stdout = options.failure === "final-ui"
              ? '1. android.view.View: "Eva" - (0,0,600,700)\n2. android.widget.Button: "Chat" - (100,800,200,900)\n'
              : '1. android.view.View: "Eva" - (0,0,600,700)\n2. android.widget.Button: "Chat" - (100,800,200,900)\n3. android.widget.Button: "Gift" - (300,800,400,900)\n4. android.widget.Button: "Close" - (500,800,600,900)\n';
          }
          return { code: 0, stdout, stderr: "" };
        }
        if (args[0] === "device" && args[1] === "screenshot") {
          screenshotNumber += 1;
          const screenshot = path.join(workspace, `mobilerun-${screenshotNumber}.png`);
          await writeFile(screenshot, `mobile-screenshot-${screenshotNumber}`);
          return { code: 0, stdout: `${screenshot}\n`, stderr: "" };
        }
        return { code: 0, stdout: "ok\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  });
}

function androidTestRequest(workspace) {
  const value = request("test", {
    environment: "test.rulet.tv",
    targets: ["Android"],
    "device-id": "DEVICE-1",
    comment: "release candidate smoke",
    "application-branch": "feature/chat-test",
    "backend-branch": "fix/chat-test",
  }, workspace);
  value.secrets = {
    ANDROID_UPLOAD_KEYSTORE_BASE64: Buffer.alloc(32, 1).toString("base64"),
    ANDROID_UPLOAD_STORE_PASSWORD: "store-secret",
    ANDROID_UPLOAD_KEY_ALIAS: "upload",
    ANDROID_UPLOAD_KEY_PASSWORD: "key-secret",
  };
  return value;
}

test("chat test validation requires an explicit Android case and rejects browser smoke targets before work", async () => {
  const workspace = await root();
  const valid = { environment: "test.rulet.tv", targets: ["Android"], comment: "verify the exact mobile bug" };
  const cases = [
    {},
    { targets: ["Android"], comment: valid.comment },
    { environment: "preprod.rulet.tv", targets: ["Android"], comment: valid.comment },
    { environment: "test.rulet.tv", targets: [], comment: valid.comment },
    { environment: "test.rulet.tv", targets: ["Desktop"], comment: valid.comment },
    { environment: "test.rulet.tv", targets: ["Chrome"], comment: valid.comment },
    { environment: "test.rulet.tv", targets: ["android"], comment: valid.comment },
    { ...valid, comment: "" },
    { ...valid, "device-id": "bad device" },
    { ...valid, "application-branch": "-main" },
    { ...valid, "backend-branch": "../main" },
    { ...valid, comment: "bad\u0000comment" },
    { ...valid, "dry-run": true },
  ];
  for (const input of cases) {
    const runner = fakeRunner(() => assert.fail(`invalid test input invoked a subprocess: ${JSON.stringify(input)}`));
    const result = await executeContract(request("test", input, workspace), { runner });
    assert.equal(result.response.status, "error", JSON.stringify(input));
    assert.equal(result.exitCode, 1);
    assert.equal(runner.calls.length, 0);
  }
});

test("chat scheduler repository branch bindings remain the immutable Android source", async () => {
  const workspace = await root();
  const environment = await prepareMobilerunCaseHome(workspace);
  const runner = androidTestRunner(workspace);
  const value = androidTestRequest(workspace);
  delete value.input["application-branch"];
  delete value.input["backend-branch"];
  value.repositories = value.repositories.map((item) => ({ ...item, defaultBranch: item.id === "application3" ? "feature/chat-test" : "fix/chat-test" }));
  const result = await execute(value, { runner, apksignerPath: "apksigner", mobilerunPath: "mobilerun", environment, sleep: async () => {} });
  assert.equal(result.output.provenance.application.branch, "feature/chat-test");
  assert.equal(result.output.provenance.backend.branch, "fix/chat-test");
  assert.deepEqual(runner.calls.filter((call) => call.command === "git" && call.args[0] === "ls-remote").map((call) => call.args[2]), ["refs/heads/feature/chat-test", "refs/heads/fix/chat-test"]);
});

test("Android uses Mobilerun reasoning, vision, secure credential IDs and durable trajectory evidence", async () => {
  const workspace = await root();
  const environment = await prepareMobilerunCaseHome(workspace);
  const runner = androidTestRunner(workspace);
  const result = await execute(androidTestRequest(workspace), { runner, apksignerPath: "apksigner", mobilerunPath: "mobilerun", environment, sleep: async () => {} });
  assert.equal(result.status, "ok");
  assert.equal(result.summary, "Camble authenticated Mobilerun test case passed");
  assert.equal(result.output.status, "passed");
  assert.deepEqual(result.output.steps.map((item) => [item.id, item.status]), [
    ["resolve-sources", "passed"],
    ["build-android", "passed"],
    ["resolve-device", "passed"],
    ["install-android", "passed"],
    ["mobilerun-thinking", "passed"],
    ["verify-mobile-case", "passed"],
  ]);
  const apk = result.output.provenance.androidArtifact;
  assert.equal(apk.path, `artifacts/camble-${C}-${D}.apk`);
  assert.equal(apk.sha256, createHash("sha256").update("signed-apk-content https://test.rulet.tv").digest("hex"));
  assert.deepEqual(apk.signed, { verified: true, certificateSha256: "3".repeat(64), verifier: "apksigner" });
  assert.equal(apk.applicationSha, C);
  assert.equal(apk.backendSha, D);
  assert.equal(apk.testHostOverlay.target, "https://test.rulet.tv");
  assert.notEqual(apk.testHostOverlay.beforeSha256, apk.testHostOverlay.afterSha256);
  const patchedFirebase = await readFile(path.join(workspace, "chat-test-android", "application", "src", "state", "firebase.native.ts"), "utf8");
  const remoteConfigOverrides = patchedFirebase.match(/\.\.\.parseRemoteConfigValues\(\),\s*(?:\/\/[^\n]*\n\s*)?"host": "https:\/\/test\.rulet\.tv",\s*"stage_host": "https:\/\/test\.rulet\.tv",\s*"stage": false,/gs) || [];
  assert.equal(remoteConfigOverrides.length, 2, "selected host must override both Firebase Remote Config merges");
  assert.match(patchedFirebase, /TEAMAI_CHAT_TEST_RUNTIME_CONFIG.*JSON\.stringify/s);
  assert.deepEqual(apk.testHostArtifact, { selectedHost: "https://test.rulet.tv", observedHosts: ["https://test.rulet.tv"], conflictingHostsAbsent: true, method: "compiled-apk-content" });
  assert.equal((await stat(path.join(workspace, apk.path))).mode & 0o777, 0o400);
  assert.equal((await readFile(path.join(workspace, apk.path), "utf8")), "signed-apk-content https://test.rulet.tv");
  assert.equal(result.artifacts.some((item) => item.type === "apk"), false, "Chat Test must not upload its large transient APK");
  assert.equal(result.artifacts.filter((item) => item.type === "test-evidence").length, 0);
  assert.equal(result.artifacts.filter((item) => item.type === "screenshot").length, 0);
  assert.equal(result.output.screenshots.length, 1);
  assert.ok(result.output.screenshots.every((item) => /^[0-9a-f]{64}$/.test(item.sha256)));
  const durableVerification = result.output.steps.find((item) => item.id === "verify-mobile-case").evidence;
  assert.match(durableVerification.targetScreenshot.sha256, /^[0-9a-f]{64}$/);
  const mobileCalls = runner.calls.filter((call) => call.command === "mobilerun");
  assert.deepEqual(mobileCalls.slice(0, 6).map((call) => call.args.slice(0, 2).join(" ")), ["--version", "devices", "ping -d", "device start", "device screenshot", "run -c"]);
  const adbCalls = runner.calls.filter((call) => call.command === "adb");
  assert.deepEqual(adbCalls.map((call) => call.args.includes("install") ? "install" : call.args.includes("clear") ? "clear-state" : call.args.includes("dumpsys") ? "verify-package" : call.args.includes("pm") && call.args.includes("path") ? "resolve-installed-apk" : call.args.includes("pull") ? "read-installed-apk" : call.args.includes("-c") ? "clear-log" : call.args.includes("pidof") ? "runtime-pid" : call.args.includes("logcat") ? "runtime-host" : "version"), ["version", "install", "clear-state", "verify-package", "resolve-installed-apk", "read-installed-apk", "clear-log", "runtime-pid", "runtime-host"]);
  const installedArtifact = result.output.steps.find((item) => item.id === "install-android").evidence.installedArtifact;
  assert.equal(installedArtifact.installedSha256, apk.sha256);
  assert.equal(installedArtifact.matchesBuiltArtifact, true);
  assert.equal(installedArtifact.backend.selectedHost, "https://test.rulet.tv");
  assert.equal(mobileCalls.filter((call) => call.args[0] === "device" && call.args[1] === "tap").length, 0);
  assert.equal(mobileCalls.filter((call) => call.args[0] === "device" && call.args[1] === "press").length, 0);
  assert.equal(mobileCalls.filter((call) => call.args[0] === "device" && call.args[1] === "ui").length, 0);
  assert.equal(mobileCalls.filter((call) => call.args[0] === "device" && call.args[1] === "screenshot").length, 1);
  const thinking = mobileCalls.find((call) => call.args[0] === "run");
  assert.ok(thinking.args.includes("--reasoning"));
  assert.ok(thinking.args.includes("--vision"));
  assert.ok(thinking.args.includes("--no-stream"));
  assert.deepEqual(thinking.args.slice(thinking.args.indexOf("--steps"), thinking.args.indexOf("--steps") + 2), ["--steps", "80"]);
  assert.match(thinking.args.at(-1), /CAMBLE_TEST_EMAIL/);
  assert.match(thinking.args.at(-1), /CAMBLE_TEST_PASSWORD/);
  assert.match(thinking.args.at(-1), /cookie\/privacy/);
  assert.match(thinking.args.at(-1), /18\+/);
  assert.match(thinking.args.at(-1), /Eva/);
  assert.match(thinking.args.at(-1), /Chat.*Gift.*Close/);
  assert.equal(result.output.steps.find((item) => item.id === "mobilerun-thinking").evidence.runtimeHost, "https://test.rulet.tv");
  assert.deepEqual(result.output.steps.find((item) => item.id === "mobilerun-thinking").evidence.runtimeHostProof.runtime, {
    method: "android-logcat-config",
    processId: 4242,
    selectedHost: "https://test.rulet.tv",
    host: "https://test.rulet.tv",
    stageHost: "https://test.rulet.tv",
    stage: false,
  });
  const verification = result.output.steps.find((item) => item.id === "verify-mobile-case").evidence;
  assert.deepEqual(verification.finalUiAssertions, ["eva", "chat", "gift", "close"]);
  assert.deepEqual(verification.interactionAssertions.map((item) => item.control), ["chat", "gift", "close"]);
  assert.ok(verification.interactionAssertions.every((item) => item.preStateSha256 !== item.nextStateSha256));
  assert.equal(runner.calls.some((call) => call.command === "git" && call.args[0] === "push"), false);
});

test("Android retries Mobilerun once only when the first attempt produces no durable trajectory", async () => {
  const workspace = await root();
  const environment = await prepareMobilerunCaseHome(workspace);
  const runner = androidTestRunner(workspace, { failure: "trajectory-once" });
  const result = await execute(androidTestRequest(workspace), { runner, apksignerPath: "apksigner", mobilerunPath: "mobilerun", environment, sleep: async () => {} });
  assert.equal(result.status, "ok");
  const mobilerunRuns = runner.calls.filter((call) => call.command === "mobilerun" && call.args[0] === "run");
  assert.equal(mobilerunRuns.length, 2);
  assert.equal(result.output.steps.find((item) => item.id === "mobilerun-thinking").evidence.mobilerunAttempts, 2);
});

test("Android proves Chat, Gift and Close taps from durable trajectory bounds", async () => {
  const workspace = await root();
  const environment = await prepareMobilerunCaseHome(workspace);
  const runner = androidTestRunner(workspace);
  const result = await execute(androidTestRequest(workspace), { runner, apksignerPath: "apksigner", mobilerunPath: "mobilerun", environment, sleep: async () => {} });
  assert.equal(result.status, "ok");
  const verification = result.output.steps.find((item) => item.id === "verify-mobile-case").evidence;
  assert.deepEqual(verification.finalUiAssertions, ["eva", "chat", "gift", "close"]);
  assert.deepEqual(verification.interactionAssertions.map((item) => item.control), ["chat", "gift", "close"]);
  for (const item of verification.interactionAssertions) {
    assert.equal(item.tap.x >= item.bounds.left && item.tap.x <= item.bounds.right, true);
    assert.equal(item.tap.y >= item.bounds.top && item.tap.y <= item.bounds.bottom, true);
    assert.notEqual(item.preStateSha256, item.nextStateSha256);
  }
});

test("Android fails terminally when credentials, signing, device, Mobilerun or target-screen evidence is missing", async () => {
  const cases = [
    { failure: "credentials", step: "build-android", message: /Missing ANDROID_UPLOAD_KEYSTORE_BASE64/ },
    { failure: "rust-toolchain", step: "build-android", message: /no active toolchain/ },
    { failure: "apksigner", step: "build-android", message: /apksigner executable not found/ },
    { failure: "signature", step: "build-android", message: /signature verification failed/ },
    { failure: "device", step: "resolve-device", message: /not in the fresh device list/ },
    { failure: "install", step: "install-android", message: /ADB failed to install/ },
    { failure: "clear-state", step: "install-android", message: /clear stale app state/ },
    { failure: "version", step: "install-android", message: /did not match the built version/ },
    { failure: "runtime-host", step: "build-android", message: /does not contain the selected test.rulet.tv backend/ },
    { failure: "installed-artifact", step: "install-android", message: /does not match the exact signed Chat Test artifact/ },
    { failure: "logcat-clear", step: "mobilerun-thinking", message: /failed to clear stale runtime logs/ },
    { failure: "runtime-pid", step: "mobilerun-thinking", message: /process com.rulettv.app was not found/ },
    { failure: "runtime-config", step: "mobilerun-thinking", message: /selected a runtime backend conflicting with test.rulet.tv/ },
    { failure: "runtime-marker", step: "mobilerun-thinking", message: /did not emit runtime backend config for test.rulet.tv/ },
    { failure: "credential-evidence", step: "mobilerun-thinking", message: /does not prove use of the configured test account/ },
    { failure: "thinking", step: "mobilerun-thinking", message: /The autonomous case failed/ },
    { failure: "existing-account-mismatch", step: "mobilerun-thinking", message: /existing-account environment mismatch: The provided email is not recognized as an existing account and the flow is attempting to create a new password/ },
    { failure: "terminal-reason", step: "mobilerun-thinking", message: /Mobilerun terminal failure: The target profile could not be reached/ },
    { failure: "terminal-boundary", step: "mobilerun-thinking", message: /Mobilerun terminal failure:/ },
    { failure: "terminal-missing", step: "mobilerun-thinking", message: /did not produce a terminal verdict/ },
    { failure: "trajectory-controls", step: "verify-mobile-case", message: /does not prove tappable interactions for: gift/ },
    { failure: "trajectory-noop", step: "verify-mobile-case", message: /chat tap did not change the UI state/ },
  ];
  for (const fixture of cases) {
    const workspace = await root();
    const environment = await prepareMobilerunCaseHome(workspace);
    const value = androidTestRequest(workspace);
    if (fixture.failure === "credentials") delete value.secrets.ANDROID_UPLOAD_KEYSTORE_BASE64;
    const runner = androidTestRunner(workspace, { failure: fixture.failure });
    const result = await executeContract(value, { runner, apksignerPath: "apksigner", mobilerunPath: "mobilerun", environment, sleep: async () => {} });
    assert.equal(result.response.status, "error", fixture.failure);
    assert.match(result.response.summary, fixture.message, fixture.failure);
    assert.equal(result.response.output.status, "failed", fixture.failure);
    assert.equal(result.response.output.steps.find((item) => item.id === fixture.step).status, "failed", fixture.failure);
    assert.equal(result.response.output.verdict, "failed", fixture.failure);
    assert.equal(result.response.artifacts.length, 0, `${fixture.failure} failure must not be replaced by a secondary artifact transport error`);
    if (new Set(["thinking", "existing-account-mismatch", "terminal-reason", "terminal-boundary", "terminal-missing", "credential-evidence"]).has(fixture.failure)) {
      const evidence = result.response.output.steps.find((item) => item.id === "mobilerun-thinking").evidence;
      assert.equal(evidence.trajectory.evidenceFiles.length, 2, `${fixture.failure} must retain trajectory hashes`);
      assert.equal(evidence.trajectory.screenshotEvidence.length, 4, `${fixture.failure} must retain screenshot hashes`);
      assert.ok(evidence.trajectory.evidenceFiles.every((item) => /^[0-9a-f]{64}$/.test(item.sha256)));
      assert.ok(evidence.trajectory.screenshotEvidence.every((item) => /^[0-9a-f]{64}$/.test(item.sha256)));
      assert.equal("authenticatedWithCredentialIds" in evidence, false, `${fixture.failure} must not claim successful authentication`);
      assert.deepEqual(evidence.attemptedCredentialIds, evidence.trajectory.secretIds, `${fixture.failure} must report only observed secret actions`);
      assert.equal(JSON.stringify(evidence).includes("qa-existing@example.com"), false, `${fixture.failure} evidence must redact the email`);
      assert.equal(JSON.stringify(evidence).includes("test-password-value"), false, `${fixture.failure} evidence must redact the password`);
    }
    assert.equal(result.exitCode, 1, fixture.failure);
  }
});

test("TEAMAI_PROGRESS reporter emits redacted JSON only on the prefixed stderr contract", async () => {
  const chunks = [];
  const value = { secrets: { API_TOKEN: "progress-private-value" }, repositories: [] };
  const reporter = createProgressReporter(value, {}, { write: (chunk) => chunks.push(chunk) });
  await reporter({ apiVersion: 1, actionId: "test", event: "step", error: "failed progress-private-value" });
  assert.equal(chunks.length, 1);
  assert.match(chunks[0], /^TEAMAI_PROGRESS /);
  assert.equal(chunks[0].includes("progress-private-value"), false);
  const decoded = JSON.parse(chunks[0].slice("TEAMAI_PROGRESS ".length));
  assert.equal(decoded.error, "failed [REDACTED]");
});

test("command runner enforces bounded subprocess timeouts", async () => {
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => queueMicrotask(() => child.emit("close", null));
    return child;
  };
  const runner = createCommandRunner({ environment: { PATH: "/bin" }, spawnImpl });
  await assert.rejects(() => runner("chrome", ["--dump-dom"], { timeoutMs: 5 }), /timed out after 5ms/);
});
