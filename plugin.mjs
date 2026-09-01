#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile, copyFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHA = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const ITEM = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const BRANCH = /^(?:dev|(?:test|testing|qa|feature|fix|bugfix)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,199})$/;
const PLAY_TRACK = "internal";
const INHERITED_ENV = [
  "PATH", "PATHEXT", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "SystemRoot", "WINDIR", "COMSPEC", "ComSpec", "TEMP", "TMP", "TMPDIR", "KUBECONFIG",
  "JAVA_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT", "GRADLE_USER_HOME",
  "LANG", "LC_ALL", "CI",
];
const SECRET_ENV = [
  "ANDROID_UPLOAD_KEYSTORE_BASE64", "ANDROID_UPLOAD_STORE_PASSWORD",
  "ANDROID_UPLOAD_KEY_ALIAS", "ANDROID_UPLOAD_KEY_PASSWORD",
  "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON", "GITHUB_TOKEN",
];
const CLUSTER = {
  namespace: "camee",
  timeoutSeconds: 900,
  services: [
    { id: "application3", repository: "application3", deployment: "application-camee", container: "application", targetBranch: "tags/component" },
    { id: "admin-ui", repository: "backend", deployment: "admin-camee", container: "admin", targetBranch: "tags/admin-ui" },
    { id: "component", repository: "backend", deployment: "component-camee", container: "component", targetBranch: "tags/component" },
  ],
};

export class PluginError extends Error {
  constructor(message, output = {}, artifacts = []) {
    super(message);
    this.name = "PluginError";
    this.output = output;
    this.artifacts = artifacts;
  }
}
const fail = (message) => { throw new PluginError(message); };
const clean = (value, label, pattern = ITEM) => {
  if (typeof value !== "string" || !pattern.test(value)) fail(`Invalid ${label}`);
  return value;
};
const boolean = (value, fallback = false) => {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") fail("Invalid boolean value");
  return value;
};
const unique = (values) => [...new Set(values)];

function subprocessEnvironment(environment, additions = {}) {
  const selected = { GIT_TERMINAL_PROMPT: "0" };
  for (const name of INHERITED_ENV) if (typeof environment[name] === "string") selected[name] = environment[name];
  for (const [name, value] of Object.entries(additions)) if (value !== undefined) selected[name] = String(value);
  return selected;
}
function quoteWindowsCommandArgument(value) {
  const text = String(value);
  if (/[\0\r\n"%!]/.test(text)) fail("Invalid Windows command argument");
  return `"${text}"`;
}
function commandInvocation(platform, environment, command, args) {
  if (platform !== "win32") return { command, args };
  const shim = command === "npm" ? "npm.cmd" : command;
  if (!/\.(?:bat|cmd)$/i.test(shim)) return { command, args };
  const commandLine = [shim, ...args].map(quoteWindowsCommandArgument).join(" ");
  return { command: environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe", args: ["/d", "/s", "/c", `"${commandLine}"`], windowsVerbatimArguments: true };
}

export function createCommandRunner(options = {}) {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const spawnImpl = options.spawnImpl ?? spawn;
  return async (command, args, options = {}) => new Promise((resolve, reject) => {
    const invocation = commandInvocation(platform, environment, command, args);
    const child = spawnImpl(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: subprocessEnvironment(environment, options.env),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments ?? false,
    });
    const stdout = [];
    const stderr = [];
    let size = 0;
    const cap = options.maxOutput ?? 2 * 1024 * 1024;
    const collect = (target) => (chunk) => {
      size += chunk.length;
      if (size > cap) child.kill("SIGKILL");
      else if (target) target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.on("error", () => reject(new PluginError("Subprocess could not be started")));
    child.on("close", (code) => {
      const result = {
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (size > cap) return reject(new PluginError(`${command} output exceeded limit`));
      if (result.code !== 0 && !options.allowFailure) return reject(new PluginError(`${path.basename(command)} failed with exit code ${result.code}`));
      resolve(result);
    });
  });
}

function actionId(request) {
  const value = request.actionId ?? request.action?.id ?? request.action;
  return clean(value, "action id");
}
function inputs(request) {
  const value = request.input ?? request.inputs ?? {};
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("Invalid input object");
  const aliases = {
    applicationSha: "application-sha",
    backendSha: "backend-sha",
    dryRun: "dry-run",
    versionName: "version-name",
    buildNumber: "build-number",
    sourceBranch: "source-branch",
  };
  return new Proxy(value, {
    get(target, property, receiver) {
      const direct = Reflect.get(target, property, receiver);
      return direct !== undefined || typeof property !== "string" || !aliases[property]
        ? direct
        : target[aliases[property]];
    },
  });
}
function repository(request, id) {
  const found = request.repositories?.find((item) => item.id === id);
  if (!found || typeof found.url !== "string" || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(found.url)) fail(`Missing or invalid ${id} repository`);
  return found;
}
function workspace(request) {
  const root = request.workspace?.path ?? request.workspacePath ?? request.workspace;
  if (typeof root !== "string" || !path.isAbsolute(root)) fail("Missing absolute workspace path");
  return root;
}
function ok(summary, output = {}, artifacts = []) {
  return { apiVersion: 1, status: "ok", summary, output, artifacts };
}
function parseLsRemote(text) {
  return text.trim().split("\n").filter(Boolean).map((line) => {
    const [sha, ref] = line.split(/\s+/);
    if (!SHA.test(sha) || !ref?.startsWith("refs/")) fail("git ls-remote returned invalid data");
    return { sha, ref };
  });
}
async function remoteRefs(runner, repo, pattern) {
  return parseLsRemote((await runner("git", ["ls-remote", repo.url, pattern])).stdout);
}
async function optionalRef(runner, repo, ref) {
  const refs = await remoteRefs(runner, repo, ref);
  if (refs.length === 0) return null;
  if (refs.length !== 1 || refs[0].ref !== ref) fail(`Remote ref ${repo.id}:${ref} is ambiguous`);
  return refs[0].sha;
}
async function exactRef(runner, repo, branch) {
  const ref = `refs/heads/${branch}`;
  const sha = await optionalRef(runner, repo, ref);
  if (sha === null) fail(`Branch ${repo.id}:${branch} was not found`);
  return sha;
}
async function cloneExact(runner, repo, sha, target) {
  clean(sha, "commit SHA", SHA);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await runner("git", ["clone", "--no-checkout", "--filter=blob:none", repo.url, target]);
  await runner("git", ["fetch", "--depth=1", "origin", sha], { cwd: target });
  await runner("git", ["checkout", "--detach", sha], { cwd: target });
}
async function verifySource(runner, repo, branch, expected) {
  clean(expected, `${repo.id} SHA`, SHA);
  const actual = await exactRef(runner, repo, branch);
  if (actual !== expected) fail(`${repo.id}:${branch} moved; collect a new snapshot`);
}
function pushSpec(ref, sha, force = true) {
  return `${force ? "+" : ""}${sha}:${ref}`;
}
async function pushRef(runner, repo, ref, sha, force) {
  await runner("git", ["push", repo.url, pushSpec(ref, sha, force)]);
}
class RefUpdateError extends Error {
  constructor(outcome, expectedSha, actualSha = null) {
    super(outcome);
    this.name = "RefUpdateError";
    this.outcome = outcome;
    this.expectedSha = expectedSha;
    this.actualSha = actualSha;
  }
}
class ProvenanceMismatchError extends Error {
  constructor(records) {
    super("immutable-tag-mismatch");
    this.name = "ProvenanceMismatchError";
    this.records = records;
  }
}
async function pushRefWithLease(runner, repo, ref, sha, expectedSha) {
  clean(sha, "target SHA", SHA);
  if (expectedSha !== null) clean(expectedSha, "expected SHA", SHA);
  try {
    const result = await runner("git", ["push", `--force-with-lease=${ref}:${expectedSha ?? ""}`, repo.url, `${sha}:${ref}`], { allowFailure: true });
    if (result.code === 0) return;
  } catch {
    // Classify the failure by re-reading the guarded ref below.
  }
  try {
    const actualSha = await optionalRef(runner, repo, ref);
    if (actualSha !== expectedSha) throw new RefUpdateError("lease-conflict", expectedSha, actualSha);
  } catch (error) {
    if (error instanceof RefUpdateError) throw error;
    throw new RefUpdateError("push-failed", expectedSha);
  }
  throw new RefUpdateError("push-failed", expectedSha, expectedSha);
}
async function nextTag(runner, repo, item) {
  const refs = await remoteRefs(runner, repo, `refs/tags/${item}-*`);
  let max = 0;
  for (const { ref } of refs) {
    const match = new RegExp(`^refs/tags/${item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)$`).exec(ref);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

function serviceCoordinates(environment, item) {
  const repositoryId = item === "application3" ? "application3" : "backend";
  const serviceName = item === "application3" ? "component" : item;
  return {
    repositoryId,
    sourceBranch: environment === "preprod" ? "dev" : `tags/${serviceName}`,
    targetBranch: environment === "preprod" ? `tags/${serviceName}` : `prod/${serviceName}`,
  };
}

async function collect(request, deps) {
  const input = inputs(request);
  const environment = input.environment ?? "preprod";
  if (!new Set(["preprod", "prod"]).has(environment)) fail("Invalid environment");
  const app = repository(request, "application3");
  const backend = repository(request, "backend");
  const [applicationDevSha, backendDevSha] = await Promise.all([exactRef(deps.runner, app, "dev"), exactRef(deps.runner, backend, "dev")]);
  const root = path.join(workspace(request), "collect-backend");
  await cloneExact(deps.runner, backend, backendDevSha, root);
  const entries = await readdir(path.join(root, "services"), { withFileTypes: true });
  const items = ["application3", ...entries.filter((item) => item.isDirectory() && ITEM.test(item.name)).map((item) => item.name).sort()];
  const services = [];
  for (const item of items) {
    const coordinates = serviceCoordinates(environment, item);
    const repo = coordinates.repositoryId === "application3" ? app : backend;
    const sourceSha = environment === "preprod"
      ? (coordinates.repositoryId === "application3" ? applicationDevSha : backendDevSha)
      : await optionalRef(deps.runner, repo, `refs/heads/${coordinates.sourceBranch}`);
    const targetSha = await optionalRef(deps.runner, repo, `refs/heads/${coordinates.targetBranch}`);
    services.push({
      id: item,
      repository: coordinates.repositoryId,
      sourceRef: coordinates.sourceBranch,
      targetRef: coordinates.targetBranch,
      sourceSha,
      targetSha,
      status: sourceSha === null ? "missing-source" : sourceSha === targetSha ? "current" : "stale",
    });
  }
  return ok(`Collected Camble ${environment} refs`, {
    environment,
    sourceBranch: environment === "preprod" ? "dev" : "tags/*",
    applicationSha: applicationDevSha,
    backendSha: backendDevSha,
    items,
    services,
  });
}

export async function planPromotion(request, deps) {
  const input = inputs(request);
  const environment = input.environment ?? "preprod";
  if (!new Set(["preprod", "prod"]).has(environment)) fail("Invalid environment");
  if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > 100) fail("Select at least one item");
  const selectedItems = unique(input.items.map((item) => clean(item, "item")));
  const updates = [];
  for (const item of selectedItems) {
    const coordinates = serviceCoordinates(environment, item);
    const repo = repository(request, coordinates.repositoryId);
    const sourceSha = await exactRef(deps.runner, repo, coordinates.sourceBranch);
    const originalSha = await optionalRef(deps.runner, repo, `refs/heads/${coordinates.targetBranch}`);
    updates.push({
      item,
      repository: coordinates.repositoryId,
      kind: "branch",
      sourceRef: `refs/heads/${coordinates.sourceBranch}`,
      ref: `refs/heads/${coordinates.targetBranch}`,
      sha: sourceSha,
      originalSha,
    });
  }
  return { environment, selectedItems, updates };
}
function promotionSteps(plan, dryRun) {
  return plan.updates.map((update, index) => ({
    order: index + 1,
    repository: update.repository,
    ref: update.ref,
    originalSha: update.originalSha ?? null,
    targetSha: update.sha,
    applyStatus: dryRun ? "planned" : "pending",
    rollback: { expectedSha: update.sha, targetSha: update.originalSha, status: dryRun ? "available" : "not-needed" },
  }));
}
async function applyPromotion(request, deps, plan, output) {
  const applied = [];
  const failureRecord = (update, error) => ({
    item: update.item,
    repository: update.repository,
    ref: update.ref,
    expectedSha: update.originalSha,
    targetSha: update.sha,
    outcome: error instanceof RefUpdateError ? error.outcome : "push-failed",
    ...(error instanceof RefUpdateError ? { actualSha: error.actualSha } : {}),
  });
  for (let index = 0; index < plan.updates.length; index += 1) {
    const update = plan.updates[index];
    const step = output.steps[index];
    if (update.originalSha === update.sha) {
      step.applyStatus = "unchanged";
      continue;
    }
    try {
      await pushRefWithLease(deps.runner, repository(request, update.repository), update.ref, update.sha, update.originalSha);
      step.applyStatus = "succeeded";
      applied.push({ update, step });
    } catch (error) {
      step.applyStatus = error instanceof RefUpdateError && error.outcome === "lease-conflict" ? "lease-conflict" : "failed";
      const rollback = [];
      for (const previous of [...applied].reverse()) {
        previous.step.rollback.status = "pending";
        try {
          if (previous.update.originalSha === null) {
            await pushRefWithLease(deps.runner, repository(request, previous.update.repository), previous.update.ref, "0".repeat(40), previous.update.sha);
          } else {
            await pushRefWithLease(deps.runner, repository(request, previous.update.repository), previous.update.ref, previous.update.originalSha, previous.update.sha);
          }
          previous.step.rollback.status = "succeeded";
          rollback.push({ item: previous.update.item, repository: previous.update.repository, ref: previous.update.ref, outcome: "restored" });
        } catch (rollbackError) {
          const outcome = rollbackError instanceof RefUpdateError && rollbackError.outcome === "lease-conflict" ? "lease-conflict" : "restore-failed";
          previous.step.rollback.status = outcome;
          rollback.push({ item: previous.update.item, repository: previous.update.repository, ref: previous.update.ref, outcome });
        }
      }
      output.failure = { original: failureRecord(update, error), rollback };
      throw new PluginError(`Camble ${plan.environment} promotion failed for ${update.item}`, output);
    }
  }
}
async function promote(request, deps) {
  const dryRun = boolean(inputs(request).dryRun, true);
  const plan = await planPromotion(request, deps);
  const output = { ...plan, dryRun, steps: promotionSteps(plan, dryRun) };
  if (!dryRun) await applyPromotion(request, deps, plan, output);
  return ok(`${dryRun ? "Planned" : "Applied"} Camble ${plan.environment} promotion`, output);
}

async function github(request, deps, repo, endpoint, options = {}) {
  const token = repo.token ?? request.secrets?.githubToken ?? request.secrets?.GITHUB_TOKEN;
  if (!token) fail(`Missing GitHub token for ${repo.id}`);
  const response = await deps.fetch(`https://api.github.com/repos/${repo.owner ?? "ruletvorg"}/${repo.name ?? (repo.id === "application3" ? "application3" : "backend")}${endpoint}`, {
    method: options.method ?? "GET",
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) fail(`GitHub API failed (${response.status})`);
  return response.status === 204 ? null : response.json();
}
function appVersion(decoded, label) {
  const versionName = decoded?.expo?.version;
  const rawBuildNumber = decoded?.expo?.android?.versionCode;
  const buildNumber = typeof rawBuildNumber === "string" && /^\d{1,9}$/.test(rawBuildNumber) ? Number(rawBuildNumber) : rawBuildNumber;
  const iosBuildNumber = decoded?.expo?.ios?.buildNumber;
  if (typeof versionName !== "string" || !VERSION.test(versionName) || !Number.isSafeInteger(buildNumber) || buildNumber < 1) fail(`Invalid ${label} version`);
  if (typeof iosBuildNumber !== "string" || iosBuildNumber !== String(buildNumber)) fail(`${label} iOS buildNumber must equal Android versionCode`);
  return { versionName, buildNumber };
}
async function readAppVersion(request, deps) {
  const app = repository(request, "application3");
  const sha = await exactRef(deps.runner, app, "dev");
  const root = path.join(workspace(request), "version-application");
  await cloneExact(deps.runner, app, sha, root);
  const decoded = JSON.parse(await readFile(path.join(root, "app.json"), "utf8"));
  const { versionName, buildNumber } = appVersion(decoded, "Camble app.json");
  return { versionName, buildNumber: String(buildNumber), nextBuildNumber: String(buildNumber + 1), commitSha: sha };
}
async function versionInspect(request, deps) {
  return ok("Read Camble application version", await readAppVersion(request, deps));
}
async function versionApply(request, deps) {
  const input = inputs(request);
  const dryRun = boolean(input.dryRun, true);
  clean(input.versionName, "version name", VERSION);
  const requestedBuild = String(input.buildNumber ?? "");
  if (!/^\d{1,9}$/.test(requestedBuild)) fail("Invalid build number");
  const current = await readAppVersion(request, deps);
  if (Number(requestedBuild) !== Number(current.buildNumber) + 1) fail(`Build number must be ${current.nextBuildNumber}`);
  const dispatch = { ref: "dev", inputs: { versionName: input.versionName, buildNumber: requestedBuild, expectedSha: current.commitSha } };
  if (!dryRun) await github(request, deps, repository(request, "application3"), "/actions/workflows/version-apply.yml/dispatches", { method: "POST", body: dispatch });
  return ok(`${dryRun ? "Planned" : "Dispatched"} Camble version ${input.versionName} (${input.buildNumber})`, { dryRun, workflow: "version-apply.yml", ...dispatch, previous: current });
}

function secret(request, deps, name, required = true) {
  const value = request.secrets?.[name] ?? deps.environment[name];
  if (required && (typeof value !== "string" || !value)) fail(`Missing ${name}`);
  return value ?? "";
}
function gradleProperty(value) { return value.replaceAll("\\", "\\\\").replaceAll("\r", "\\r").replaceAll("\n", "\\n").replaceAll("=", "\\=").replaceAll(":", "\\:"); }
async function assertFile(file) { const value = await stat(file).catch(() => null); if (!value?.isFile() || value.size < 1) fail(`Missing build output ${path.basename(file)}`); }
async function androidBuild(request, deps) {
  const input = inputs(request);
  const dryRun = boolean(input.dryRun, true);
  if (input.track !== undefined && input.track !== PLAY_TRACK) fail("Google Play track is fixed to internal");
  const app = repository(request, "application3");
  const backend = repository(request, "backend");
  const [applicationSha, backendSha] = await Promise.all([exactRef(deps.runner, app, "dev"), exactRef(deps.runner, backend, "dev")]);
  if (input.applicationSha !== undefined && input.applicationSha !== applicationSha) fail("application3:dev moved; refresh build data");
  if (input.backendSha !== undefined && input.backendSha !== backendSha) fail("backend:dev moved; refresh build data");
  const root = workspace(request);
  const applicationRoot = path.join(root, "application");
  const backendRoot = path.join(root, "backend");
  if (dryRun) return ok("Planned application3 dev build", { dryRun, applicationSha, backendSha, verifiedBranch: "dev", storeTrack: PLAY_TRACK, steps: ["resolve current dev SHAs", "clone exact SHAs", "npm ci/preinit", "signed APK+AAB", "optional Google Play Internal upload"] });
  await cloneExact(deps.runner, app, applicationSha, applicationRoot);
  await cloneExact(deps.runner, backend, backendSha, backendRoot);
  await deps.runner("npm", ["ci", "--no-audit", "--no-fund"], { cwd: applicationRoot });
  await deps.runner("npm", ["install", "--no-package-lock", "--no-audit", "--no-fund"], { cwd: path.join(applicationRoot, "builder") });
  await deps.runner("npm", ["run", "preinit"], { cwd: applicationRoot, env: { BACKEND_DIR: backendRoot, BACKEND_BRANCH: backendSha } });
  const appJson = JSON.parse(await readFile(path.join(applicationRoot, "app.json"), "utf8"));
  const { versionName, buildNumber } = appVersion(appJson, "Generated Camble app.json");
  const keystore = Buffer.from(secret(request, deps, "ANDROID_UPLOAD_KEYSTORE_BASE64"), "base64");
  if (keystore.length < 32 || keystore.length > 1024 * 1024) fail("Invalid Android upload keystore");
  await writeFile(path.join(applicationRoot, "android", "app", "upload.jks"), keystore, { mode: 0o600 });
  const propertiesPath = path.join(applicationRoot, "android", "gradle.properties");
  const properties = await readFile(propertiesPath, "utf8").catch(() => "");
  const storePassword = secret(request, deps, "ANDROID_UPLOAD_STORE_PASSWORD");
  const keyAlias = secret(request, deps, "ANDROID_UPLOAD_KEY_ALIAS");
  const keyPassword = secret(request, deps, "ANDROID_UPLOAD_KEY_PASSWORD");
  await writeFile(propertiesPath, `${properties}\nAPP_UPLOAD_STORE_PASSWORD=${gradleProperty(storePassword)}\nAPP_UPLOAD_KEY_ALIAS=${gradleProperty(keyAlias)}\nAPP_UPLOAD_KEY_PASSWORD=${gradleProperty(keyPassword)}\n`, { mode: 0o600 });
  const gradle = deps.platform === "win32" ? "gradlew.bat" : "./gradlew";
  await deps.runner(gradle, ["app:bundleRelease", "app:assembleRelease", "--no-daemon", "--max-workers=2", "-Dorg.gradle.parallel=false", "-Dorg.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=768m -Dfile.encoding=UTF-8", "-Pkotlin.compiler.execution.strategy=in-process", `-PAPP_VERSION_CODE=${buildNumber}`, "-PreactNativeArchitectures=arm64-v8a", "-PAPP_UPLOAD_STORE_FILE=upload.jks"], { cwd: path.join(applicationRoot, "android") });
  const apkSource = path.join(applicationRoot, "android/app/build/outputs/apk/release/app-release.apk");
  const aabSource = path.join(applicationRoot, "android/app/build/outputs/bundle/release/app-release.aab");
  await Promise.all([assertFile(apkSource), assertFile(aabSource)]);
  const artifactRoot = path.join(root, "artifacts"); await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  const apk = path.join(artifactRoot, "camble.apk"); const aab = path.join(artifactRoot, "camble.aab");
  await Promise.all([copyFile(apkSource, apk), copyFile(aabSource, aab)]);
  let storeStatus = "skipped";
  const serviceAccount = secret(request, deps, "GOOGLE_PLAY_SERVICE_ACCOUNT_JSON", false);
  if (serviceAccount) {
    await writeFile(path.join(applicationRoot, "builder", "service.json"), serviceAccount, { mode: 0o600 });
    const apkDir = path.join(applicationRoot, "builder", "apk"); await mkdir(apkDir, { recursive: true, mode: 0o700 });
    await copyFile(aab, path.join(apkDir, "release.aab"));
    await deps.runner("npm", ["run", "playstore", "--prefix", "builder"], { cwd: applicationRoot, env: { GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: serviceAccount, RELEASE_TRACK: PLAY_TRACK, RELEASE_TYPE: "completed" } });
    storeStatus = "uploaded";
  }
  const artifacts = [
    { path: path.relative(root, apk), type: "apk", versionName, buildNumber: String(buildNumber) },
    { path: path.relative(root, aab), type: "aab", versionName, buildNumber: String(buildNumber) },
  ];
  return ok(`Built signed Camble Android ${versionName} (${buildNumber})`, { dryRun, applicationSha, backendSha, verifiedBranch: "dev", versionName, buildNumber: String(buildNumber), storeTrack: PLAY_TRACK, storeStatus }, artifacts);
}

async function clusterPlan(request, deps) {
  const input = inputs(request);
  const branch = clean(input.sourceBranch, "source branch", BRANCH);
  if (!Array.isArray(input.services) || input.services.length === 0) fail("Select cluster services");
  const mappings = new Map(CLUSTER.services.map((item) => [item.id, item]));
  return Promise.all(unique(input.services).map(async (id) => {
    const mapping = mappings.get(clean(id, "cluster service"));
    if (!mapping) fail(`Unknown cluster service ${id}`);
    const repo = repository(request, mapping.repository);
    const branchRef = `refs/heads/${mapping.targetBranch}`;
    const sha = await exactRef(deps.runner, repo, branch);
    const tagRef = `refs/tags/${id}-${sha}`;
    const [originalBranchSha, originalTagSha] = await Promise.all([
      optionalRef(deps.runner, repo, branchRef),
      optionalRef(deps.runner, repo, tagRef),
    ]);
    if (originalBranchSha === null) fail(`Branch ${repo.id}:${mapping.targetBranch} was not found`);
    return { ...mapping, sha, tagRef, branchRef, originalBranchSha, originalTagSha, expectedDigest: null };
  }));
}
function sourceShaFromImage(image) {
  if (typeof image !== "string") return null;
  const withoutDigest = image.split("@", 1)[0];
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");
  if (colon <= slash) return null;
  const match = /^([0-9a-fA-F]{40})(?:[-.][0-9A-Za-z][0-9A-Za-z._-]*)?$/.exec(withoutDigest.slice(colon + 1));
  return match?.[1].toLowerCase() ?? null;
}
function digestFromImageId(imageID) {
  if (typeof imageID !== "string") return null;
  const match = /(?:^|[@/])(sha256:[0-9a-fA-F]{64})$/.exec(imageID);
  const digest = match?.[1].toLowerCase() ?? null;
  return digest && IMAGE_DIGEST.test(digest) ? digest : null;
}
function podMatchesSelector(pod, selector) {
  const labels = pod.metadata?.labels ?? {};
  const entries = Object.entries(selector ?? {});
  return entries.length > 0 && entries.every(([name, value]) => labels[name] === value);
}
function deploymentState(item, pods, mapping, expectation) {
  const container = item.spec?.template?.spec?.containers?.find((value) => value.name === mapping.container);
  if (!container) fail(`Container ${mapping.container} absent from ${mapping.deployment}`);
  const desired = item.spec?.replicas ?? 1;
  const status = item.status ?? {};
  const available = status.conditions?.some((value) => value.type === "Available" && value.status === "True") ?? false;
  const progressing = status.conditions?.some((value) => value.type === "Progressing" && value.status === "True") ?? false;
  const deploymentReady = desired > 0 && status.observedGeneration >= item.metadata.generation && status.updatedReplicas === desired && status.availableReplicas === desired && status.readyReplicas === desired && (status.unavailableReplicas ?? 0) === 0 && available && progressing;
  const selector = item.spec?.selector?.matchLabels;
  const selectedPods = pods.filter((pod) => !pod.metadata?.deletionTimestamp && podMatchesSelector(pod, selector));
  const podStates = selectedPods.map((pod) => {
    const podContainer = pod.spec?.containers?.find((value) => value.name === mapping.container);
    const containerStatus = pod.status?.containerStatuses?.find((value) => value.name === mapping.container);
    const digest = digestFromImageId(containerStatus?.imageID);
    const image = podContainer?.image ?? containerStatus?.image ?? null;
    return {
      pod: pod.metadata?.name ?? null,
      phase: pod.status?.phase ?? null,
      image,
      imageID: containerStatus?.imageID ?? null,
      digest,
      ready: pod.status?.phase === "Running" && containerStatus?.ready === true && image === container.image && digest !== null,
    };
  });
  const digests = unique(podStates.map((pod) => pod.digest).filter(Boolean));
  const resolvedDigest = digests.length === 1 ? digests[0] : null;
  const sourceSha = sourceShaFromImage(container.image);
  const sourceMatches = expectation ? sourceSha === expectation.sha : sourceSha !== null;
  const digestMatches = expectation?.expectedDigest ? resolvedDigest === expectation.expectedDigest : resolvedDigest !== null;
  const podsReady = podStates.length >= desired && podStates.every((pod) => pod.ready);
  const provenanceReady = sourceMatches && digestMatches && podsReady && resolvedDigest !== null;
  return {
    service: mapping.id,
    deployment: mapping.deployment,
    container: mapping.container,
    image: container.image,
    sourceSha,
    expectedSourceSha: expectation?.sha ?? null,
    resolvedDigest,
    expectedDigest: expectation?.expectedDigest ?? null,
    sourceMatches,
    digestMatches,
    pods: podStates,
    generation: item.metadata.generation,
    observedGeneration: status.observedGeneration ?? 0,
    desiredReplicas: desired,
    updatedReplicas: status.updatedReplicas ?? 0,
    availableReplicas: status.availableReplicas ?? 0,
    readyReplicas: status.readyReplicas ?? 0,
    unavailableReplicas: status.unavailableReplicas ?? 0,
    conditionsReady: available && progressing,
    deploymentReady,
    provenanceReady,
    ready: deploymentReady && provenanceReady,
  };
}
function kubectlFailureReason(stderr) {
  const message = String(stderr ?? "").toLowerCase();
  if (/no such file|kubeconfig.*(?:missing|not found)|stat .*kube/.test(message)) return "KUBECONFIG_NOT_FOUND";
  if (/context .* does not exist|current-context .* not found|no context exists/.test(message)) return "KUBECONFIG_CONTEXT_INVALID";
  if (/certificate|x509|tls handshake/.test(message)) return "TLS_VALIDATION_FAILED";
  if (/unauthorized|provide credentials|the server has asked for the client to provide credentials/.test(message)) return "AUTHENTICATION_FAILED";
  if (/forbidden|cannot (?:get|list|watch)/.test(message)) return "AUTHORIZATION_FAILED";
  if (/connection refused|actively refused/.test(message)) return "CONNECTION_REFUSED";
  if (/i\/o timeout|context deadline exceeded|timed out/.test(message)) return "CONNECTION_TIMEOUT";
  if (/no route to host|network is unreachable|couldn't get current server api group list|unable to connect to the server/.test(message)) return "CLUSTER_UNREACHABLE";
  if (/not found/.test(message)) return "RESOURCE_NOT_FOUND";
  return "UNCLASSIFIED";
}

async function kubectlJSON(deps, args) {
  const result = await deps.runner("kubectl", args, { allowFailure: true });
  if (result.code !== 0) {
    const reason = kubectlFailureReason(result.stderr);
    throw new PluginError(`kubectl failed: ${reason}`, { reason, exitCode: result.code });
  }
  return result.stdout;
}

async function observe(request, deps, expected = []) {
  const deploymentArgs = ["--request-timeout=10s", "get", "deployments", ...CLUSTER.services.map((item) => item.deployment), "-n", CLUSTER.namespace, "-o", "json"];
  const podArgs = ["--request-timeout=10s", "get", "pods", "-n", CLUSTER.namespace, "-o", "json"];
  const [deploymentJSON, podJSON] = await Promise.all([
    kubectlJSON(deps, deploymentArgs),
    kubectlJSON(deps, podArgs),
  ]);
  const decoded = JSON.parse(deploymentJSON);
  const decodedPods = JSON.parse(podJSON);
  if (!Array.isArray(decoded.items)) fail("kubectl returned invalid deployment JSON");
  if (!Array.isArray(decodedPods.items)) fail("kubectl returned invalid pod JSON");
  const byName = new Map(decoded.items.map((item) => [item.metadata?.name, item]));
  const expectations = new Map(expected.map((item) => [item.id, item]));
  const services = CLUSTER.services.map((mapping) => {
    const item = byName.get(mapping.deployment); if (!item) fail(`Deployment ${mapping.deployment} absent`);
    return deploymentState(item, decodedPods.items, mapping, expectations.get(mapping.id));
  });
  const checked = expected.length > 0 ? expected.map((item) => item.id) : CLUSTER.services.map((item) => item.id);
  const rolledOut = checked.every((id) => services.find((item) => item.service === id)?.ready);
  return { namespace: CLUSTER.namespace, observedAt: new Date().toISOString(), rolledOut, services };
}
async function clusterObserve(request, deps) { return ok("Observed Camble cluster", await observe(request, deps)); }

function boundedLogText(value, maxBytes = 32 * 1024) {
  const buffer = Buffer.from(String(value ?? ""), "utf8");
  if (buffer.length <= maxBytes) return { text: buffer.toString("utf8"), truncated: false };
  return { text: buffer.subarray(buffer.length - maxBytes).toString("utf8"), truncated: true };
}

async function clusterLogs(request, deps) {
  const runner = deps.runner ?? createCommandRunner();
  const services = [];
  const workloads = [
    ...CLUSTER.services,
    { id: "stream-room-watcher", deployment: "stream-room-watcher-camee", container: "stream-room-watcher" },
  ];
  for (const item of workloads) {
    const result = await runner("kubectl", [
      "--request-timeout=15s", "logs", `deployment/${item.deployment}`,
      "-n", CLUSTER.namespace, "--all-pods=true", "--prefix=true", "--timestamps=true",
      "--since=30m", "--tail=100", "-c", item.container,
    ], { allowFailure: true, maxOutput: 256 * 1024 });
    const bounded = boundedLogText(result.stdout);
    services.push({
      service: item.id,
      deployment: item.deployment,
      status: result.code === 0 ? "ok" : "error",
      reason: result.code === 0 ? null : kubectlFailureReason(result.stderr),
      logs: bounded.text,
      truncated: bounded.truncated,
    });
  }
  return ok("Collected recent Camble cluster logs", {
    namespace: CLUSTER.namespace,
    observedAt: new Date().toISOString(),
    since: "30m",
    tailLinesPerPod: 100,
    services,
  });
}

function clusterSteps(plan, dryRun) {
  const tags = plan.map((item, index) => ({
    order: index + 1,
    phase: "immutable-tag",
    service: item.id,
    repository: item.repository,
    ref: item.tagRef,
    expectedSha: null,
    targetSha: item.sha,
    applyStatus: item.originalTagSha === item.sha ? "preexisting" : dryRun ? "planned" : "pending",
  }));
  const branches = plan.map((item, index) => ({
    order: tags.length + index + 1,
    phase: "branch",
    service: item.id,
    repository: item.repository,
    ref: item.branchRef,
    expectedSha: item.originalBranchSha,
    targetSha: item.sha,
    applyStatus: item.originalBranchSha === item.sha ? "unchanged" : dryRun ? "planned" : "pending",
    rollback: { expectedSha: item.sha, targetSha: item.originalBranchSha, status: dryRun ? "available" : "not-needed" },
  }));
  return [...tags, ...branches];
}
function refFailure(item, phase, error) {
  const expectedSha = phase === "immutable-tag" ? null : item.originalBranchSha;
  const ref = phase === "immutable-tag" ? item.tagRef : item.branchRef;
  return {
    phase,
    service: item.id,
    repository: item.repository,
    ref,
    expectedSha,
    targetSha: item.sha,
    outcome: error instanceof RefUpdateError ? error.outcome : "push-failed",
    ...(error instanceof RefUpdateError ? { actualSha: error.actualSha } : {}),
  };
}
async function rollbackClusterBranches(request, deps, plan, output) {
  const outcomes = [];
  for (const item of [...plan].reverse()) {
    const step = output.steps.find((value) => value.phase === "branch" && value.service === item.id);
    if (step.applyStatus !== "succeeded") continue;
    step.rollback.status = "pending";
    try {
      await pushRefWithLease(deps.runner, repository(request, item.repository), item.branchRef, item.originalBranchSha, item.sha);
      step.rollback.status = "succeeded";
      outcomes.push({ service: item.id, repository: item.repository, ref: item.branchRef, expectedSha: item.sha, targetSha: item.originalBranchSha, outcome: "restored" });
    } catch (error) {
      const leaseConflict = error instanceof RefUpdateError && error.outcome === "lease-conflict";
      step.rollback.status = leaseConflict ? "lease-conflict" : "failed";
      outcomes.push({
        service: item.id,
        repository: item.repository,
        ref: item.branchRef,
        expectedSha: item.sha,
        targetSha: item.originalBranchSha,
        outcome: leaseConflict ? "lease-conflict" : "restore-failed",
        ...(error instanceof RefUpdateError ? { actualSha: error.actualSha } : {}),
      });
    }
  }
  if (outcomes.length === 0) return { outcome: "not-needed", steps: [] };
  if (outcomes.every((item) => item.outcome === "restored")) return { outcome: "restored", steps: outcomes };
  if (outcomes.every((item) => item.outcome === "lease-conflict")) return { outcome: "lease-conflict", steps: outcomes };
  if (outcomes.every((item) => item.outcome !== "restored")) return { outcome: "restore-failed", steps: outcomes };
  return { outcome: "partial", steps: outcomes };
}
function clusterFailureSummary(original, rollback) {
  const failure = original.outcome === "lease-conflict" ? `${original.phase} lease conflict` : `${original.phase} failure`;
  if (rollback.outcome === "restored") return `Camble cluster deployment ${failure}; plugin-updated branches were restored`;
  if (rollback.outcome === "not-needed") return `Camble cluster deployment ${failure}; rollback was not needed`;
  if (rollback.outcome === "lease-conflict") return `Camble cluster deployment ${failure}; rollback was blocked by a lease conflict`;
  return `Camble cluster deployment ${failure}; branch rollback was ${rollback.outcome}`;
}
async function clusterDeploy(request, deps) {
  const dryRun = boolean(inputs(request).dryRun, true);
  const plan = await clusterPlan(request, deps);
  const output = {
    dryRun,
    sourceBranch: inputs(request).sourceBranch,
    updates: plan.map(({ id, repository: repositoryId, sha, tagRef, branchRef, originalBranchSha, expectedDigest }) => ({
      service: id,
      repository: repositoryId,
      sha,
      tagRef,
      branchRef,
      originalBranchSha,
      provenance: { sourceSha: sha, immutableTagRef: tagRef, expectedDigest },
    })),
    steps: clusterSteps(plan, dryRun),
    retainedImmutableTags: [],
  };
  const collision = plan.find((item) => item.originalTagSha !== null && item.originalTagSha !== item.sha);
  if (collision) {
    const step = output.steps.find((item) => item.phase === "immutable-tag" && item.service === collision.id);
    step.applyStatus = "collision";
    output.failure = {
      original: { phase: "preflight", service: collision.id, repository: collision.repository, ref: collision.tagRef, expectedSha: null, targetSha: collision.sha, actualSha: collision.originalTagSha, outcome: "immutable-tag-collision" },
      rollback: { outcome: "not-needed", steps: [] },
    };
    throw new PluginError("Camble cluster deployment found an immutable provenance tag collision", output);
  }
  if (dryRun) return ok("Planned Camble cluster deployment", output);

  for (const item of plan) {
    const step = output.steps.find((value) => value.phase === "immutable-tag" && value.service === item.id);
    if (step.applyStatus === "preexisting") continue;
    try {
      await pushRefWithLease(deps.runner, repository(request, item.repository), item.tagRef, item.sha, null);
      step.applyStatus = "created";
      output.retainedImmutableTags.push({ service: item.id, repository: item.repository, ref: item.tagRef, sha: item.sha });
    } catch (error) {
      step.applyStatus = error instanceof RefUpdateError && error.outcome === "lease-conflict" ? "lease-conflict" : "failed";
      const original = refFailure(item, "immutable-tag", error);
      const rollback = { outcome: "not-needed", steps: [] };
      output.failure = { original, rollback };
      throw new PluginError(clusterFailureSummary(original, rollback), output);
    }
  }
  for (const item of plan) {
    const step = output.steps.find((value) => value.phase === "branch" && value.service === item.id);
    if (step.applyStatus === "unchanged") continue;
    try {
      await pushRefWithLease(deps.runner, repository(request, item.repository), item.branchRef, item.sha, item.originalBranchSha);
      step.applyStatus = "succeeded";
    } catch (error) {
      step.applyStatus = error instanceof RefUpdateError && error.outcome === "lease-conflict" ? "lease-conflict" : "failed";
      const original = refFailure(item, "branch", error);
      const rollback = await rollbackClusterBranches(request, deps, plan, output);
      output.failure = { original, rollback };
      throw new PluginError(clusterFailureSummary(original, rollback), output);
    }
  }

  try {
    const deadline = deps.now() + CLUSTER.timeoutSeconds * 1000;
    do {
      output.cluster = await observe(request, deps, plan);
      if (output.cluster.rolledOut) {
        const unresolved = plan.filter((item) => item.expectedDigest === null);
        if (unresolved.length === 0) break;
        for (const item of unresolved) {
          const state = output.cluster.services.find((service) => service.service === item.id);
          if (!state?.resolvedDigest) fail(`Deployment ${item.deployment} has no stable image digest`);
          item.expectedDigest = state.resolvedDigest;
          output.updates.find((update) => update.service === item.id).provenance.expectedDigest = state.resolvedDigest;
        }
        continue;
      }
      if (deps.now() >= deadline) break;
      await deps.sleep(10_000);
    } while (true);
    output.cluster.timedOut = !output.cluster.rolledOut;
    if (!output.cluster.rolledOut) throw new Error("rollout-timeout");
    output.provenanceRefs = await Promise.all(plan.map(async (item) => {
      const actualTagSha = await optionalRef(deps.runner, repository(request, item.repository), item.tagRef);
      return {
        service: item.id,
        repository: item.repository,
        immutableTagRef: item.tagRef,
        sourceSha: item.sha,
        actualTagSha,
        expectedDigest: item.expectedDigest,
        verified: actualTagSha === item.sha,
      };
    }));
    const mismatches = output.provenanceRefs.filter((item) => !item.verified);
    if (mismatches.length > 0) throw new ProvenanceMismatchError(mismatches);
  } catch (error) {
    const original = error instanceof ProvenanceMismatchError
      ? { phase: "post-rollout-provenance", outcome: "immutable-tag-mismatch", mismatches: error.records }
      : { phase: "rollout", outcome: error?.message === "rollout-timeout" ? "timed-out" : "observation-failed" };
    const rollback = await rollbackClusterBranches(request, deps, plan, output);
    output.failure = { original, rollback };
    const detail = original.outcome === "timed-out" ? ` did not become ready within ${CLUSTER.timeoutSeconds} seconds`
      : original.outcome === "immutable-tag-mismatch" ? " provenance verification failed"
        : " observation failed";
    throw new PluginError(`Camble cluster rollout${detail}; branch rollback was ${rollback.outcome}`, output);
  }
  return ok("Applied Camble cluster deployment", output);
}

export async function execute(request, overrides = {}) {
  if (!request || request.apiVersion !== 1) fail("Unsupported request apiVersion");
  const platform = overrides.platform ?? process.platform;
  const environment = overrides.environment ?? process.env;
  const deps = { runner: overrides.runner ?? createCommandRunner({ platform, environment }), fetch: overrides.fetch ?? globalThis.fetch, sleep: overrides.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))), now: overrides.now ?? Date.now, platform, environment };
  const handlers = { collect, promote, "version-inspect": versionInspect, "version-apply": versionApply, "android-build": androidBuild, "cluster-observe": clusterObserve, "cluster-logs": clusterLogs, "cluster-deploy": clusterDeploy };
  const id = actionId(request); const handler = handlers[id];
  if (!handler) fail(`Unknown action ${id}`);
  return handler(request, deps);
}

function knownSecretValues(request, environment) {
  const values = [];
  const seen = new WeakSet();
  const add = (value) => {
    if (typeof value === "string") {
      if (value.length > 0) values.push(value);
      return;
    }
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const nested of Object.values(value)) add(nested);
  };
  add(request?.secrets);
  for (const repo of request?.repositories ?? []) add(repo?.token);
  for (const name of SECRET_ENV) add(environment[name]);
  return unique(values).sort((left, right) => right.length - left.length);
}
function redactResponse(value, secrets) {
  if (typeof value === "string") {
    let redacted = value;
    for (const secretValue of secrets) redacted = redacted.replaceAll(secretValue, "[REDACTED]");
    return redacted;
  }
  if (Array.isArray(value)) return value.map((item) => redactResponse(item, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactResponse(item, secrets)]));
  return value;
}
function errorResponse(error) {
  return {
    apiVersion: 1,
    status: "error",
    summary: error instanceof PluginError ? error.message : "Camble plugin failed",
    output: error instanceof PluginError ? error.output : {},
    artifacts: error instanceof PluginError ? error.artifacts : [],
  };
}
export async function executeContract(request, overrides = {}) {
  const environment = overrides.environment ?? process.env;
  let response;
  try {
    response = await execute(request, overrides);
  } catch (error) {
    response = errorResponse(error);
  }
  response = redactResponse(response, knownSecretValues(request, environment));
  return { response, exitCode: response.status === "ok" ? 0 : 1 };
}

async function main() {
  try {
    let raw = "";
    for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 1024 * 1024) fail("Request exceeds limit"); }
    const request = JSON.parse(raw);
    const result = await executeContract(request);
    process.stdout.write(`${JSON.stringify(result.response)}\n`);
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(errorResponse(error))}\n`);
    process.exitCode = 1;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
