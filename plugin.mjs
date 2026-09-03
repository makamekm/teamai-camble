#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, readFile, readdir, writeFile, copyFile, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHA = /^[0-9a-f]{40}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const ITEM = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const BRANCH = /^(?:dev|(?:test|testing|qa|feature|fix|bugfix)\/[A-Za-z0-9][A-Za-z0-9._/-]{0,199})$/;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const ANDROID_PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
const PLAY_TRACK = "internal";
const TEST_ENVIRONMENTS = new Set(["test.rulet.tv", "peprod.rulet.tv"]);
const TEST_TARGETS = ["Android"];
const TEST_INPUTS = new Set(["environment", "targets", "device-id", "comment", "application-branch", "backend-branch"]);
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
  "MOBILERUN_CLOUD_API_KEY", "MOBILERUN_PORTAL_TOKEN",
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
    let settled = false;
    let timedOut = false;
    const timeoutMs = options.timeoutMs;
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60 * 60 * 1000)) {
      child.kill("SIGKILL");
      return reject(new PluginError("Invalid subprocess timeout"));
    }
    const timer = timeoutMs === undefined ? null : setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(new PluginError("Subprocess could not be started"));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (timedOut) return reject(new PluginError(`${path.basename(command)} timed out after ${timeoutMs}ms`));
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
async function sha256File(file) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}
async function executableCandidate(runner, candidates, versionArgs, label) {
  for (const candidate of unique(candidates.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))) {
    try {
      const result = await runner(candidate, versionArgs, { allowFailure: true, timeoutMs: 5_000, maxOutput: 64 * 1024 });
      if (result.code === 0) return candidate;
    } catch {
      // Try the next trusted candidate and report one explicit terminal error below.
    }
  }
  fail(`${label} executable not found`);
}
async function resolveApksigner(request, deps) {
  const candidates = [deps.apksignerPath, request.tools?.apksigner];
  const sdkRoots = unique([request.tools?.android, deps.environment.ANDROID_SDK_ROOT, deps.environment.ANDROID_HOME].filter((value) => typeof value === "string" && path.isAbsolute(value)));
  for (const sdkRoot of sdkRoots) {
    const buildTools = path.join(sdkRoot, "build-tools");
    const versions = await readdir(buildTools, { withFileTypes: true }).catch(() => []);
    for (const version of versions.filter((item) => item.isDirectory()).map((item) => item.name).sort().reverse()) {
      candidates.push(path.join(buildTools, version, deps.platform === "win32" ? "apksigner.bat" : "apksigner"));
    }
  }
  candidates.push(deps.platform === "win32" ? "apksigner.bat" : "apksigner");
  return executableCandidate(deps.runner, candidates, ["version"], "Android apksigner");
}
async function buildSignedAndroid(request, deps, options) {
  const root = workspace(request);
  const buildRoot = path.join(root, options.directory);
  const applicationRoot = path.join(buildRoot, "application");
  const backendRoot = path.join(buildRoot, "backend");
  const rustup = await executableCandidate(deps.runner, [deps.rustupPath, request.tools?.rustup, "rustup"], ["--version"], "Rustup");
  const rustToolchain = await deps.runner(rustup, ["show", "active-toolchain"], { allowFailure: true, timeoutMs: 30_000, maxOutput: 64 * 1024 });
  if (rustToolchain.code !== 0) fail("Rustup has no active toolchain for Android native modules");
  await cloneExact(deps.runner, repository(request, "application3"), options.applicationSha, applicationRoot);
  await cloneExact(deps.runner, repository(request, "backend"), options.backendSha, backendRoot);
  await deps.runner("npm", ["ci", "--no-audit", "--no-fund"], { cwd: applicationRoot, timeoutMs: 10 * 60 * 1000 });
  await deps.runner("npm", ["install", "--no-package-lock", "--no-audit", "--no-fund"], { cwd: path.join(applicationRoot, "builder"), timeoutMs: 5 * 60 * 1000 });
  await deps.runner("npm", ["run", "preinit"], { cwd: applicationRoot, env: { BACKEND_DIR: backendRoot, BACKEND_BRANCH: options.backendSha }, timeoutMs: 5 * 60 * 1000 });
  const testHostOverlay = options.testEnvironment
    ? await applyAndroidTestHostOverlay(applicationRoot, options.testEnvironment)
    : null;
  const appJson = JSON.parse(await readFile(path.join(applicationRoot, "app.json"), "utf8"));
  const { versionName, buildNumber } = appVersion(appJson, "Generated Camble app.json");
  const packageName = appJson?.expo?.android?.package;
  if (options.requirePackage && (typeof packageName !== "string" || !ANDROID_PACKAGE.test(packageName))) fail("Generated Camble app.json has an invalid Android package");
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
  const tasks = options.includeBundle ? ["app:bundleRelease", "app:assembleRelease"] : ["app:assembleRelease"];
  await deps.runner(gradle, [...tasks, "--no-daemon", "--max-workers=2", "-Dorg.gradle.parallel=false", "-Dorg.gradle.jvmargs=-Xmx4096m -XX:MaxMetaspaceSize=768m -Dfile.encoding=UTF-8", "-Pkotlin.compiler.execution.strategy=in-process", `-PAPP_VERSION_CODE=${buildNumber}`, "-PreactNativeArchitectures=arm64-v8a", "-PAPP_UPLOAD_STORE_FILE=upload.jks"], { cwd: path.join(applicationRoot, "android"), timeoutMs: 30 * 60 * 1000 });
  const apkSource = path.join(applicationRoot, "android/app/build/outputs/apk/release/app-release.apk");
  await assertFile(apkSource);
  const artifactRoot = path.join(root, "artifacts");
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  const apk = path.join(artifactRoot, options.apkFileName);
  await copyFile(apkSource, apk);
  await assertFile(apk);
  let aab = null;
  if (options.includeBundle) {
    const aabSource = path.join(applicationRoot, "android/app/build/outputs/bundle/release/app-release.aab");
    await assertFile(aabSource);
    aab = path.join(artifactRoot, options.aabFileName);
    await copyFile(aabSource, aab);
  }
  let signing = null;
  if (options.verifySignature) {
    const apksigner = await resolveApksigner(request, deps);
    const verified = await deps.runner(apksigner, ["verify", "--verbose", "--print-certs", apk], { allowFailure: true, timeoutMs: 60_000, maxOutput: 256 * 1024 });
    if (verified.code !== 0) fail("APK signature verification failed");
    const certificate = /certificate SHA-256 digest:\s*([0-9a-f]{64})/i.exec(`${verified.stdout}\n${verified.stderr}`)?.[1]?.toLowerCase() ?? null;
    signing = { verified: true, certificateSha256: certificate, verifier: "apksigner" };
  }
  const apkSha256 = await sha256File(apk);
  const testHostArtifact = options.testEnvironment
    ? await proveAndroidTestHostArtifact(apk, options.testEnvironment)
    : null;
  if (options.immutable) await chmod(apk, 0o400);
  return { root, applicationRoot, artifactRoot, apk, aab, apkSha256, signing, versionName, buildNumber: String(buildNumber), packageName, testHostOverlay, testHostArtifact };
}
async function androidBuild(request, deps) {
  const input = inputs(request);
  const dryRun = boolean(input.dryRun, true);
  if (input.track !== undefined && input.track !== PLAY_TRACK) fail("Google Play track is fixed to internal");
  const app = repository(request, "application3");
  const backend = repository(request, "backend");
  const [applicationSha, backendSha] = await Promise.all([exactRef(deps.runner, app, "dev"), exactRef(deps.runner, backend, "dev")]);
  if (input.applicationSha !== undefined && input.applicationSha !== applicationSha) fail("application3:dev moved; refresh build data");
  if (input.backendSha !== undefined && input.backendSha !== backendSha) fail("backend:dev moved; refresh build data");
  if (dryRun) return ok("Planned application3 dev build", { dryRun, applicationSha, backendSha, verifiedBranch: "dev", storeTrack: PLAY_TRACK, steps: ["resolve current dev SHAs", "clone exact SHAs", "npm ci/preinit", "signed APK+AAB", "optional Google Play Internal upload"] });
  const built = await buildSignedAndroid(request, deps, { directory: "android-build", applicationSha, backendSha, includeBundle: true, apkFileName: "camble.apk", aabFileName: "camble.aab", requirePackage: false, verifySignature: false, immutable: false });
  const { root, applicationRoot, apk, aab, versionName, buildNumber } = built;
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
    { path: path.relative(root, apk), type: "apk", versionName, buildNumber },
    { path: path.relative(root, aab), type: "aab", versionName, buildNumber },
  ];
  return ok(`Built signed Camble Android ${versionName} (${buildNumber})`, { dryRun, applicationSha, backendSha, verifiedBranch: "dev", versionName, buildNumber, storeTrack: PLAY_TRACK, storeStatus }, artifacts);
}

function optionalText(value, label, maxLength) {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(`Invalid ${label}`);
  return value;
}
function testBranch(value, label) {
  if (typeof value !== "string" || value.length < 1 || value.length > 255 || value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".") || value.endsWith(".lock")
    || /\.\.|@\{|[\\~^:?*\[\]\u0000-\u0020\u007f]/.test(value)
    || value.split("/").some((part) => part === "" || part === "." || part === ".." || part.startsWith("."))) fail(`Invalid ${label}`);
  return value;
}
function testActionInputs(request) {
  const raw = request.input ?? request.inputs ?? {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("Invalid input object");
  for (const key of Object.keys(raw)) if (!TEST_INPUTS.has(key)) fail(`Unknown test input ${key}`);
  if (!TEST_ENVIRONMENTS.has(raw.environment)) fail("Invalid test environment");
  if (!Array.isArray(raw.targets) || raw.targets.length < 1 || raw.targets.length > TEST_TARGETS.length) fail("Select at least one test target");
  if (new Set(raw.targets).size !== raw.targets.length || raw.targets.some((target) => !TEST_TARGETS.includes(target))) fail("Invalid test targets");
  const targets = TEST_TARGETS.filter((target) => raw.targets.includes(target));
  const declaredDeviceId = optionalText(raw["device-id"], "device id", 200);
  const scheduledDeviceId = request.device?.id ?? request.device?.serial ?? request.deviceId ?? request.scheduler?.deviceId;
  const deviceId = declaredDeviceId ?? scheduledDeviceId ?? null;
  if (deviceId !== null && (typeof deviceId !== "string" || !DEVICE_ID.test(deviceId))) fail("Invalid device id");
  const applicationBranch = testBranch(raw["application-branch"] ?? repository(request, "application3").defaultBranch ?? "dev", "application branch");
  const backendBranch = testBranch(raw["backend-branch"] ?? repository(request, "backend").defaultBranch ?? "dev", "backend branch");
  const comment = optionalText(raw.comment, "test case", 20_000);
  if (!comment?.trim()) fail("Authenticated Android Chat Test requires a non-empty test case");
  return {
    environment: raw.environment,
    targets,
    deviceId,
    comment: comment.trim(),
    applicationBranch,
    backendBranch,
  };
}
function lifecycleTimestamp(deps) { return new Date(deps.now()).toISOString(); }
function conciseError(error) {
  const value = error instanceof Error ? error.message : "Unknown test failure";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 2_000) || "Unknown test failure";
}
function relativeArtifactPath(root, file) { return path.relative(root, file).split(path.sep).join("/"); }
function nativeTestHost(environment) { return `https://${environment}`; }
const ANDROID_BACKEND_URLS = [
  "https://prod.rulet.tv",
  "https://stage.rulet.tv",
  ...[...TEST_ENVIRONMENTS].map(nativeTestHost),
];

async function scanArtifactForAscii(file, values) {
  const needles = values.map((value) => ({ value, bytes: Buffer.from(value, "ascii") }));
  const found = new Set();
  const overlap = Math.max(...needles.map((item) => item.bytes.length)) - 1;
  let carry = Buffer.alloc(0);
  for await (const chunk of createReadStream(file, { highWaterMark: 1024 * 1024 })) {
    const data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    for (const item of needles) if (data.indexOf(item.bytes) >= 0) found.add(item.value);
    carry = overlap > 0 && data.length > overlap ? data.subarray(data.length - overlap) : data;
  }
  return [...found];
}

async function proveAndroidTestHostArtifact(apk, environment) {
  const selectedHost = nativeTestHost(environment);
  const observedHosts = await scanArtifactForAscii(apk, ANDROID_BACKEND_URLS);
  if (!observedHosts.includes(selectedHost)) fail(`Signed APK does not contain the selected ${environment} backend`);
  const conflictingHosts = observedHosts.filter((host) => host !== selectedHost);
  if (conflictingHosts.length) fail(`Signed APK contains a backend conflicting with ${environment}`);
  return { selectedHost, observedHosts, conflictingHostsAbsent: true, method: "compiled-apk-content" };
}

async function applyAndroidTestHostOverlay(applicationRoot, environment) {
  const target = nativeTestHost(environment);
  const source = path.join(applicationRoot, "src", "state", "firebase.native.ts");
  const before = await readFile(source, "utf8");
  let after = before;
  const replacements = [
    [/(["']host["']\s*:\s*)["']https:\/\/prod\.rulet\.tv["']/, `$1"${target}"`],
    [/(["']stage_host["']\s*:\s*)["']https:\/\/stage\.rulet\.tv["']/, `$1"${target}"`],
  ];
  for (const [pattern, replacement] of replacements) {
    if (!pattern.test(after)) fail("Android test host overlay no longer matches firebase.native.ts");
    after = after.replace(pattern, replacement);
  }
  const remoteMerge = /([ \t]*)\.\.\.parseRemoteConfigValues\(\),/g;
  const remoteMerges = [...after.matchAll(remoteMerge)].length;
  if (remoteMerges !== 2) fail("Android test host overlay no longer matches both Firebase Remote Config merges");
  after = after.replace(remoteMerge, (_match, indent) => [
    `${indent}...parseRemoteConfigValues(),`,
    `${indent}// TeamAI Chat Test must win over cached and live Firebase Remote Config.`,
    `${indent}"host": "${target}",`,
    `${indent}"stage_host": "${target}",`,
    `${indent}"stage": false,`,
  ].join("\n"));
  const configLog = /([ \t]*)console\.log\("Config:", state\.config\.value\);/;
  if (!configLog.test(after)) fail("Android test host overlay no longer matches the runtime Config log");
  after = after.replace(configLog, (_match, indent) => [
    `${indent}console.log("TEAMAI_CHAT_TEST_RUNTIME_CONFIG " + JSON.stringify({`,
    `${indent}  host: state.config.value.host,`,
    `${indent}  stage_host: state.config.value.stage_host,`,
    `${indent}  stage: state.config.value.stage,`,
    `${indent}}));`,
    `${indent}console.log("Config:", state.config.value);`,
  ].join("\n"));
  await writeFile(source, after, { mode: 0o600 });
  return {
    environment,
    target,
    source: "src/state/firebase.native.ts",
    beforeSha256: createHash("sha256").update(before, "utf8").digest("hex"),
    afterSha256: createHash("sha256").update(after, "utf8").digest("hex"),
  };
}

function normalizeRuntimeHost(value) {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.pathname !== "/" && parsed.pathname !== "")) return null;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function runtimeConfigFromLogcat(logcat) {
  const rows = `${logcat ?? ""}`.split(/\r?\n/).reverse();
  for (const row of rows) {
    const source = /\bTEAMAI_CHAT_TEST_RUNTIME_CONFIG\s+(\{.*\})\s*$/.exec(row)?.[1];
    if (!source) continue;
    try {
      const config = JSON.parse(source);
      return {
        host: normalizeRuntimeHost(config.host),
        stageHost: normalizeRuntimeHost(config.stage_host),
        stage: config.stage,
      };
    } catch {
      // Keep looking for an earlier complete runtime marker.
    }
  }
  return null;
}

async function proveAndroidRuntimeHost(request, deps, adb, mobile, packageName, environment) {
  const expectedHost = nativeTestHost(environment);
  let processId = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const process = await deps.runner(adb, ["-s", mobile.deviceId, "shell", "pidof", packageName], {
      allowFailure: true,
      timeoutMs: 30_000,
      maxOutput: 64 * 1024,
    });
    const candidate = process.stdout.trim().split(/\s+/)[0];
    if (process.code === 0 && /^\d+$/.test(candidate)) {
      processId = candidate;
      break;
    }
    await deps.sleep(1_000);
  }
  if (!processId) fail(`Running APK process ${packageName} was not found for runtime backend verification`);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const logs = await deps.runner(adb, ["-s", mobile.deviceId, "logcat", "-d", "--pid", processId, "-v", "brief", "-t", "4000"], {
      allowFailure: true,
      timeoutMs: 30_000,
      maxOutput: 2 * 1024 * 1024,
    });
    const config = logs.code === 0 ? runtimeConfigFromLogcat(logs.stdout) : null;
    if (config) {
      if (config.host !== expectedHost || config.stageHost !== expectedHost || config.stage !== false) {
        fail(`Running APK selected a runtime backend conflicting with ${environment}`);
      }
      return { method: "android-logcat-config", processId: Number(processId), selectedHost: expectedHost, ...config };
    }
    await deps.sleep(1_000);
  }
  fail(`Running APK did not emit runtime backend config for ${environment}`);
}
function testStepDefinitions(targets) {
  const definitions = [{ id: "resolve-sources", label: "Resolve immutable source SHAs", target: null }];
  if (targets.includes("Android")) definitions.push({ id: "build-android", label: "Build and verify immutable signed APK", target: "Android" });
  if (targets.includes("Android")) definitions.push(
    { id: "resolve-device", label: "Resolve and ping Mobilerun device", target: "Android" },
    { id: "install-android", label: "Deliver and install exact APK", target: "Android" },
    { id: "mobilerun-thinking", label: "Run authenticated test case with Mobilerun reasoning and vision", target: "Android" },
    { id: "verify-mobile-case", label: "Verify target screen and durable Mobilerun evidence", target: "Android" },
  );
  return definitions.map((definition, index) => ({ order: index + 1, ...definition, status: "pending", startedAt: null, completedAt: null, evidence: null, error: null }));
}
async function emitTestProgress(deps, lifecycle, step) {
  await deps.progress({
    apiVersion: 1,
    actionId: "test",
    event: "step",
    lifecycleStatus: lifecycle.status,
    step: { order: step.order, id: step.id, label: step.label, target: step.target, status: step.status },
    ...(step.error ? { error: step.error } : {}),
  });
}
async function runTestStep(lifecycle, id, deps, operation) {
  const step = lifecycle.steps.find((item) => item.id === id);
  if (!step) fail(`Missing lifecycle step ${id}`);
  step.status = "running";
  step.startedAt = lifecycleTimestamp(deps);
  if (step.target) lifecycle.targets.find((item) => item.target === step.target).status = "running";
  await emitTestProgress(deps, lifecycle, step);
  try {
    const evidence = await operation();
    step.status = "passed";
    step.evidence = evidence ?? {};
    lifecycle.evidence.push({ stepId: id, target: step.target, ...step.evidence });
    step.completedAt = lifecycleTimestamp(deps);
    await emitTestProgress(deps, lifecycle, step);
    return evidence;
  } catch (error) {
    step.status = "failed";
    step.error = { code: "STEP_FAILED", message: conciseError(error) };
    step.completedAt = lifecycleTimestamp(deps);
    lifecycle.errors.push({ stepId: id, target: step.target, ...step.error });
    await emitTestProgress(deps, lifecycle, step);
    throw error;
  }
}
function finalizeTestLifecycle(lifecycle, passed, deps) {
  for (const step of lifecycle.steps) {
    if (step.status === "pending") {
      step.status = "skipped";
      step.error = passed ? null : { code: "NOT_RUN", message: "Skipped after an earlier terminal failure" };
    }
  }
  for (const target of lifecycle.targets) {
    const steps = lifecycle.steps.filter((step) => step.target === target.target);
    target.status = steps.some((step) => step.status === "failed") ? "failed"
      : steps.length > 0 && steps.every((step) => step.status === "passed") ? "passed"
        : lifecycle.errors.some((error) => error.target === null) ? "failed" : "skipped";
    target.stepIds = steps.map((step) => step.id);
  }
  lifecycle.status = passed ? "passed" : "failed";
  lifecycle.completedAt = lifecycleTimestamp(deps);
  lifecycle.verdict = lifecycle.status;
  lifecycle.verdictEvidence = { evidence: lifecycle.evidence, errors: lifecycle.errors };
}
async function resolveChrome(request, deps) {
  const candidates = [deps.chromePath, request.tools?.chrome, deps.environment.TEAMAI_CHROME_BIN];
  if (deps.platform === "darwin") {
    candidates.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium");
  } else if (deps.platform === "win32") {
    for (const root of [deps.environment.PROGRAMFILES, deps.environment.LOCALAPPDATA]) {
      if (root) candidates.push(path.join(root, "Google", "Chrome", "Application", "chrome.exe"));
    }
  } else {
    candidates.push("google-chrome", "google-chrome-stable", "chromium", "chromium-browser");
  }
  for (const candidate of unique(candidates.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))) {
    try {
      const result = await deps.runner(candidate, ["--version"], { allowFailure: true, timeoutMs: 5_000, maxOutput: 64 * 1024 });
      if (result.code === 0) return { executable: candidate, version: `${result.stdout}\n${result.stderr}`.trim().slice(0, 240) };
    } catch {
      // Continue through the bounded trusted candidate list.
    }
  }
  fail("Google Chrome/Chromium executable not found");
}
async function withTimeout(promise, timeoutMs, message, controller = null) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => { controller?.abort(); reject(new PluginError(message)); }, timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function httpEvidence(deps, deepLink, environment) {
  const controller = new AbortController();
  const response = await withTimeout(deps.fetch(deepLink, { redirect: "follow", signal: controller.signal, headers: { Accept: "text/html" } }), 15_000, "HTTP check timed out", controller);
  if (!response || typeof response.status !== "number" || response.status < 200 || response.status >= 300) fail(`HTTP check failed with status ${response?.status ?? "unknown"}`);
  const finalUrl = response.url || deepLink;
  let parsed;
  try { parsed = new URL(finalUrl); } catch { fail("HTTP check returned an invalid final URL"); }
  if (parsed.protocol !== "https:" || parsed.hostname !== environment || parsed.username || parsed.password) fail("HTTP check escaped the selected environment");
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (!/^text\/html(?:;|$)/i.test(contentType)) fail("HTTP check did not return HTML");
  const body = await withTimeout(response.text(), 15_000, "HTTP body check timed out", controller);
  const bodyBytes = Buffer.byteLength(body ?? "", "utf8");
  if (bodyBytes < 1 || bodyBytes > 2 * 1024 * 1024 || !/<(?:!doctype\s+html|html)\b/i.test(body) || !/<body\b/i.test(body)) fail("HTTP check returned an invalid HTML document");
  return { status: response.status, finalUrl, contentType: contentType.slice(0, 160), bodyBytes, htmlDocument: true };
}
function titleFromDom(dom) {
  return /<title[^>]*>([^<]{0,500})<\/title>/i.exec(dom)?.[1]?.trim() ?? null;
}
function chromeArguments(profile, viewport) {
  return ["--headless=new", "--disable-gpu", "--disable-extensions", "--disable-component-update", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-sync", "--metrics-recording-only", `--window-size=${viewport}`, `--user-data-dir=${profile}`];
}

async function captureChromeWithRunner({ chrome, profile, screenshot, deepLink, viewport, deps }) {
  const common = chromeArguments(profile, viewport).filter((argument) => !argument.startsWith("--user-data-dir="));
  const domResult = await deps.runner(chrome.executable, [...common, `--user-data-dir=${path.join(profile, "dom")}`, "--virtual-time-budget=10000", "--dump-dom", deepLink], { allowFailure: true, timeoutMs: 30_000, maxOutput: 4 * 1024 * 1024 });
  const dom = domResult.stdout;
  await deps.runner(chrome.executable, [...common, `--user-data-dir=${path.join(profile, "screenshot")}`, "--virtual-time-budget=10000", `--screenshot=${screenshot}`, deepLink], { timeoutMs: 30_000, maxOutput: 256 * 1024 });
  return { dom: domResult.code === 0 ? dom : "", finalUrl: deepLink };
}

async function waitForFile(file, deps, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await readFile(file, "utf8"); } catch {}
    await deps.sleep(100);
  }
  fail("Chrome DevTools endpoint did not start");
}

async function chromeDevToolsSession(webSocketUrl, timeoutMs) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 0;
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new PluginError("Chrome DevTools connection timed out")), timeoutMs);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new PluginError("Chrome DevTools connection failed")); }, { once: true });
  });
  socket.addEventListener("message", (event) => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { return; }
    if (!message.id || !pending.has(message.id)) return;
    const item = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(new PluginError(`Chrome DevTools ${message.error.message ?? "command failed"}`));
    else item.resolve(message.result ?? {});
  });
  await opened;
  return {
    async call(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new PluginError(`Chrome DevTools ${method} timed out`)); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new PluginError("Chrome DevTools session closed")); }
      pending.clear();
      socket.close();
    },
  };
}

async function captureChromeCdp({ chrome, profile, screenshot, deepLink, viewport, deps }) {
  const [width, height] = viewport.split(",").map(Number);
  const args = [...chromeArguments(profile, viewport), "--remote-debugging-port=0", "about:blank"];
  const child = spawn(chrome.executable, args, { env: subprocessEnvironment(deps.environment), stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (chunk) => { if (stderr.length < 64 * 1024) stderr += chunk.toString("utf8"); });
  let session = null;
  try {
    const active = await waitForFile(path.join(profile, "DevToolsActivePort"), deps, 15_000);
    const port = Number(active.split(/\r?\n/, 1)[0]);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) fail("Chrome returned an invalid DevTools port");
    const pages = await withTimeout(globalThis.fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()), 5_000, "Chrome DevTools discovery timed out");
    const page = Array.isArray(pages) ? pages.find((item) => item?.type === "page" && typeof item.webSocketDebuggerUrl === "string") : null;
    if (!page) fail("Chrome DevTools page target was not found");
    session = await chromeDevToolsSession(page.webSocketDebuggerUrl, 15_000);
    await session.call("Page.enable");
    await session.call("Runtime.enable");
    await session.call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await session.call("Page.navigate", { url: deepLink });
    const deadline = Date.now() + 45_000;
    let document = null;
    while (Date.now() < deadline) {
      const evaluated = await session.call("Runtime.evaluate", { expression: `(() => {
        const marker = globalThis.__CAMEE_APP_READY__;
        const route = String(marker?.route || location.pathname || '').toLowerCase();
        const loading = [...document.querySelectorAll('[class*="load" i], [id*="load" i]')].some((element) => {
          const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
        });
        const ready = Boolean(marker?.route) || (!loading && /(login|auth|guest|register|age-gate|random|feed|live)/.test(route));
        const navigation = performance.getEntriesByType('navigation')[0];
        return {ready,route,readyState:document.readyState,html:document.documentElement?.outerHTML||'',title:document.title,url:location.href,status:navigation?.responseStatus||0,contentType:document.contentType||''};
      })()`, returnByValue: true });
      const value = evaluated?.result?.value;
      if (value?.ready === true && value.readyState === "complete" && typeof value.html === "string" && /<body\b/i.test(value.html)) { document = value; break; }
      await deps.sleep(250);
    }
    if (!document) fail("Chrome page did not report an application-ready route");
    if (/(?:chrome-error:\/\/|ERR_[A-Z_]+|This site can['’]t be reached)/i.test(document.url + "\n" + document.html)) fail("Browser DOM check failed");
    const captured = await session.call("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
    if (typeof captured.data !== "string" || captured.data.length < 100) fail("Chrome did not return screenshot evidence");
    await writeFile(screenshot, Buffer.from(captured.data, "base64"), { mode: 0o600 });
    if (!Number.isFinite(document.status) || document.status < 200 || document.status >= 300) fail(`Chrome navigation failed with status ${document.status || "unknown"}`);
    return { dom: document.html, finalUrl: document.url, http: { status: document.status, finalUrl: document.url, contentType: String(document.contentType).slice(0, 160), bodyBytes: Buffer.byteLength(document.html, "utf8"), htmlDocument: true, source: "chrome-navigation" } };
  } catch (error) {
    if (error instanceof PluginError) throw error;
    throw new PluginError(`Chrome DevTools test failed: ${conciseError(error)}${stderr ? ` (${stderr.slice(-300)})` : ""}`);
  } finally {
    session?.close();
    child.kill("SIGKILL");
  }
}

async function captureBrowserTarget(request, deps, lifecycle, artifacts, chrome, target, deepLink) {
  const root = workspace(request);
  const targetSlug = target.toLowerCase();
  const profile = path.join(root, "browser-profiles", targetSlug);
  const screenshot = path.join(root, "artifacts", `${targetSlug}-${lifecycle.environment}.png`);
  await Promise.all([mkdir(profile, { recursive: true, mode: 0o700 }), mkdir(path.dirname(screenshot), { recursive: true, mode: 0o700 })]);
  const viewport = target === "Desktop" ? "1440,1000" : "1280,800";
  const captured = await deps.browserCapture({ chrome, profile, screenshot, deepLink, viewport, deps });
  const dom = captured.dom;
  if (!/<html\b/i.test(dom) || !/<body\b/i.test(dom) || /(?:chrome-error:\/\/|ERR_[A-Z_]+|This site can['’]t be reached)/i.test(dom)) fail(`${target} DOM check failed`);
  const finalUrl = new URL(captured.finalUrl ?? deepLink);
  if (finalUrl.protocol !== "https:" || finalUrl.hostname !== lifecycle.environment) fail(`${target} browser escaped the selected environment`);
  let http = captured.http ?? deps.httpEvidenceCache.get(deepLink);
  if (!http) {
    http = await httpEvidence(deps, deepLink, lifecycle.environment);
    deps.httpEvidenceCache.set(deepLink, http);
  }
  await assertFile(screenshot);
  const screenshotSha256 = await sha256File(screenshot);
  const relative = relativeArtifactPath(root, screenshot);
  artifacts.push({ path: relative, type: "screenshot" });
  lifecycle.screenshots.push({ target, kind: "browser", path: relative, sha256: screenshotSha256 });
  return { http, dom: { htmlDocument: true, bytes: Buffer.byteLength(dom, "utf8"), title: titleFromDom(dom), finalUrl: finalUrl.href }, screenshot: { path: relative, sha256: screenshotSha256 } };
}
function parseMobilerunDevices(output) {
  const stripped = String(output ?? "").replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  const found = [];
  for (const line of stripped.split(/\r?\n/)) {
    const match = /^\s*[•*]\s+([^\s]+)/.exec(line);
    if (match && DEVICE_ID.test(match[1])) found.push(match[1]);
  }
  return unique(found);
}
async function resolveMobilerun(request, deps, requestedDeviceId) {
  const executable = await executableCandidate(deps.runner, [deps.mobilerunPath, request.tools?.mobilerun, "mobilerun"], ["--version"], "Mobilerun");
  const listed = await deps.runner(executable, ["devices"], { allowFailure: true, timeoutMs: 20_000, maxOutput: 256 * 1024 });
  if (listed.code !== 0) fail("Mobilerun device discovery failed");
  const devices = parseMobilerunDevices(listed.stdout);
  const deviceId = requestedDeviceId ?? (devices.length === 1 ? devices[0] : null);
  if (!deviceId) fail(devices.length === 0 ? "No Mobilerun device available" : "Multiple Mobilerun devices are available; select device-id");
  if (!devices.includes(deviceId)) fail(`Mobilerun device ${deviceId} is not in the fresh device list`);
  const ping = await deps.runner(executable, ["ping", "-d", deviceId], { allowFailure: true, timeoutMs: 20_000, maxOutput: 256 * 1024 });
  if (ping.code !== 0) fail(`Mobilerun device ${deviceId} is unavailable`);
  return { executable, deviceId, discoveredDevices: devices.length };
}
async function resolveAdb(request, deps) {
  const candidates = [deps.adbPath, request.tools?.adb];
  for (const root of [request.tools?.android, deps.environment.ANDROID_SDK_ROOT, deps.environment.ANDROID_HOME]) {
    if (typeof root === "string" && path.isAbsolute(root)) candidates.push(path.join(root, "platform-tools", deps.platform === "win32" ? "adb.exe" : "adb"));
  }
  candidates.push(deps.platform === "win32" ? "adb.exe" : "adb");
  return executableCandidate(deps.runner, candidates, ["version"], "Android adb");
}

async function proveInstalledAndroidArtifact(request, deps, adb, mobile, built) {
  const located = await deps.runner(adb, ["-s", mobile.deviceId, "shell", "pm", "path", built.packageName], { allowFailure: true, timeoutMs: 30_000, maxOutput: 64 * 1024 });
  const remoteApk = located.code === 0
    ? located.stdout.split(/\r?\n/).map((line) => /^package:(\/.*\/base\.apk)$/.exec(line.trim())?.[1]).find(Boolean)
    : null;
  if (!remoteApk) fail("ADB could not resolve the installed base APK");
  const pulledApk = path.join(workspace(request), `.installed-${built.apkSha256}.apk`);
  try {
    const pulled = await deps.runner(adb, ["-s", mobile.deviceId, "pull", remoteApk, pulledApk], { allowFailure: true, timeoutMs: 2 * 60_000, maxOutput: 128 * 1024 });
    if (pulled.code !== 0) fail("ADB could not read back the installed base APK");
    await assertFile(pulledApk);
    const installedSha256 = await sha256File(pulledApk);
    if (installedSha256 !== built.apkSha256) fail("Installed base APK does not match the exact signed Chat Test artifact");
    const backend = await proveAndroidTestHostArtifact(pulledApk, built.testHostOverlay.environment);
    return { installedSha256, matchesBuiltArtifact: true, backend };
  } finally {
    await unlink(pulledApk).catch(() => {});
  }
}

async function mobilerunCommand(mobile, deps, args, label, timeoutMs = 30_000) {
  const result = await deps.runner(mobile.executable, args, { allowFailure: true, timeoutMs, maxOutput: 512 * 1024 });
  if (result.code !== 0) fail(`Mobilerun ${label} failed`);
  return result;
}
async function captureMobileScreenshot(request, deps, lifecycle, artifacts, mobile, kind) {
  const captured = await mobilerunCommand(mobile, deps, ["device", "screenshot", "-d", mobile.deviceId], `${kind} screenshot`);
  const returned = captured.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)?.trim();
  if (!returned) fail("Mobilerun did not return a screenshot path");
  const source = path.isAbsolute(returned) ? returned : path.resolve(workspace(request), returned);
  const sourceStat = await stat(source).catch(() => null);
  if (!sourceStat?.isFile() || sourceStat.size < 1 || sourceStat.size > 20 * 1024 * 1024 || path.extname(source).toLowerCase() !== ".png") fail("Mobilerun returned an invalid screenshot");
  const destination = path.join(workspace(request), "artifacts", `android-${kind}-${lifecycle.environment}.png`);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination);
  const sha256 = await sha256File(destination);
  const relative = relativeArtifactPath(workspace(request), destination);
  artifacts.push({ path: relative, type: "screenshot" });
  lifecycle.screenshots.push({ target: "Android", kind, path: relative, sha256 });
  return { path: relative, sha256 };
}

const CAMBLE_MOBILERUN_SECRET_IDS = ["CAMBLE_TEST_EMAIL", "CAMBLE_TEST_PASSWORD"];

async function secureMobilerunCaseConfig(deps) {
  const home = deps.environment.HOME ?? deps.environment.USERPROFILE;
  if (typeof home !== "string" || !path.isAbsolute(home)) fail("Mobilerun test home is unavailable");
  const config = path.join(home, ".teamai", "camble-mobilerun-config.yaml");
  const trajectoryRoot = path.join(home, ".teamai", "camble-mobilerun-trajectories");
  const [configStat, trajectoryStat] = await Promise.all([stat(config).catch(() => null), stat(trajectoryRoot).catch(() => null)]);
  if (!configStat?.isFile() || configStat.size < 1 || configStat.size > 1024 * 1024 || (configStat.mode & 0o077) !== 0) {
    fail("Secure Mobilerun test config is missing or has unsafe permissions");
  }
  if (!trajectoryStat?.isDirectory()) fail("Mobilerun trajectory directory is unavailable");
  return { config, trajectoryRoot };
}

async function trajectoryDirectories(root) {
  return new Set((await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name));
}

async function newMobilerunTrajectory(root, before, deps) {
  const deadline = Date.now() + 20_000;
  do {
    const candidates = [];
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || before.has(entry.name)) continue;
      const directory = path.join(root, entry.name);
      const macro = path.join(directory, "macro.json");
      const details = await stat(macro).catch(() => null);
      if (details?.isFile() && details.size > 0) candidates.push({ directory, modified: details.mtimeMs });
    }
    if (candidates.length) return candidates.sort((left, right) => right.modified - left.modified)[0].directory;
    if (Date.now() >= deadline) break;
    await deps.sleep(250);
  } while (true);
  fail("Mobilerun did not produce durable trajectory evidence");
}

function secretIdsIn(value, found = new Set()) {
  if (Array.isArray(value)) for (const item of value) secretIdsIn(item, found);
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if ((key === "secret_id" || key === "secretId") && typeof item === "string") found.add(item);
      secretIdsIn(item, found);
    }
  }
  return found;
}

function selectTrajectoryScreenshots(files, limit = 12) {
  if (files.length <= limit) return files;
  const selected = new Set([0, files.length - 1]);
  for (let index = 1; index < limit - 1; index += 1) selected.add(Math.round((index * (files.length - 1)) / (limit - 1)));
  return [...selected].sort((left, right) => left - right).map((index) => files[index]);
}

async function collectMobilerunTrajectory(directory) {
  const macroSource = path.join(directory, "macro.json");
  const trajectorySource = path.join(directory, "trajectory.json");
  const macro = JSON.parse(await readFile(macroSource, "utf8"));
  const actionCount = Array.isArray(macro.actions) ? macro.actions.length : 0;
  if (!Number.isSafeInteger(macro.total_actions) || macro.total_actions !== actionCount || actionCount < 8) {
    fail("Mobilerun trajectory does not contain enough executed actions");
  }
  const secretIds = secretIdsIn(macro);
  if (CAMBLE_MOBILERUN_SECRET_IDS.some((id) => !secretIds.has(id))) {
    fail("Mobilerun trajectory does not prove use of the configured test account");
  }
  const evidenceFiles = [];
  for (const [source, kind] of [[macroSource, "macro"], [trajectorySource, "trajectory"]]) {
    const details = await stat(source).catch(() => null);
    if (!details?.isFile() || details.size < 1 || details.size > 20 * 1024 * 1024) fail("Mobilerun trajectory metadata is missing or oversized");
    evidenceFiles.push({ kind, bytes: details.size, sha256: await sha256File(source) });
  }
  const screenshotsRoot = path.join(directory, "screenshots");
  const screenshotFiles = (await readdir(screenshotsRoot, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && /^\d{4}\.png$/.test(entry.name)).map((entry) => entry.name).sort();
  if (screenshotFiles.length < 4) fail("Mobilerun trajectory has insufficient screenshot evidence");
  const screenshotEvidence = [];
  for (const fileName of selectTrajectoryScreenshots(screenshotFiles)) {
    const source = path.join(screenshotsRoot, fileName);
    const details = await stat(source).catch(() => null);
    if (!details?.isFile() || details.size < 1 || details.size > 20 * 1024 * 1024) fail("Mobilerun trajectory screenshot is invalid");
    screenshotEvidence.push({ frame: fileName, bytes: details.size, sha256: await sha256File(source) });
  }
  return { actionCount, secretIds: CAMBLE_MOBILERUN_SECRET_IDS, screenshotCount: screenshotFiles.length, screenshotEvidence, evidenceFiles };
}

function authenticatedMobilerunPrompt(input, packageName) {
  return [
    "Execute this Android UI test fail-closed. Use planning/reasoning and vision for every decision.",
    `Launch ${packageName}; the installed test build is already pinned to ${input.environment}.`,
    "Confirm every cookie/privacy dialog and confirm the 18+ age gate.",
    "Authenticate through the existing-account / Welcome back email flow using CAMBLE_TEST_EMAIL and CAMBLE_TEST_PASSWORD via type_secret; never expose their values.",
    "Do not create or register an account, create/reset a password, or continue through an email-code flow. If the email is not recognized as an existing account, stop failed.",
    "Navigate to Feed/Лента. Find Eva, open her profile modal, and scroll the modal to the bottom until Chat/Чат, Gift/Подарок and Close/Закрыть are visible.",
    "Tap Chat and prove that the UI reacts, then return to Eva. Tap Gift and prove that the gift UI opens, then close it and return to Eva. Tap Close and prove the profile modal closes.",
    "Finally reopen Eva, scroll to the same bottom position, and leave the profile modal open with all three buttons visible for independent verification.",
    "Do not report success if authentication, any gate, Eva, scrolling, any of the three taps, or the final target screen was not actually observed.",
    `Test case from TeamAI chat: ${input.comment}`,
  ].join("\n");
}

function mobileControl(ui, id, pattern) {
  const line = String(ui ?? "").split(/\r?\n/).find((candidate) => pattern.test(candidate));
  const bounds = line && /-\s*\((\d+),(\d+),(\d+),(\d+)\)\s*$/.exec(line);
  if (!bounds) fail(`Mobilerun final UI does not expose ${id} with tappable bounds`);
  const [left, top, right, bottom] = bounds.slice(1).map(Number);
  if (right <= left || bottom <= top) fail(`Mobilerun final UI returned invalid ${id} bounds`);
  return { id, x: Math.floor((left + right) / 2), y: Math.floor((top + bottom) / 2) };
}

function assertFinalMobileCaseUi(ui) {
  const text = String(ui ?? "").toLocaleLowerCase();
  if (!/\beva\b/i.test(text)) fail("Mobilerun final UI did not prove the target screen: eva");
  const controls = [
    mobileControl(ui, "chat", /(?:["']chat["']|["']чат["'])/i),
    mobileControl(ui, "gift", /(?:["']gift["']|["'][^"']*подар[^"']*["'])/i),
    mobileControl(ui, "close", /(?:["']close["']|["'][^"']*закры[^"']*["'])/i),
  ];
  return { assertions: ["eva", ...controls.map((control) => control.id)], controls };
}

function uiEvidenceHash(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

async function verifyButtonReaction(request, deps, lifecycle, artifacts, mobile, baselineUi, control, kind) {
  await mobilerunCommand(mobile, deps, ["device", "tap", "-d", mobile.deviceId, String(control.x), String(control.y)], `${control.id} tap`);
  await deps.sleep(1_000);
  const changed = await mobilerunCommand(mobile, deps, ["device", "ui", "-d", mobile.deviceId], `${control.id} reaction UI`);
  if (!changed.stdout.trim() || uiEvidenceHash(changed.stdout) === uiEvidenceHash(baselineUi)) fail(`Mobilerun ${control.id} tap did not change the UI`);
  const screenshot = await captureMobileScreenshot(request, deps, lifecycle, artifacts, mobile, kind);
  return { control: control.id, beforeUiSha256: uiEvidenceHash(baselineUi), afterUiSha256: uiEvidenceHash(changed.stdout), screenshot };
}

async function returnToTargetMobileUi(mobile, deps, label) {
  await mobilerunCommand(mobile, deps, ["device", "press", "-d", mobile.deviceId, "back"], `${label} back`);
  await deps.sleep(1_000);
  const returned = await mobilerunCommand(mobile, deps, ["device", "ui", "-d", mobile.deviceId], `${label} return UI`);
  return { ui: returned.stdout, target: assertFinalMobileCaseUi(returned.stdout) };
}

async function cambleTest(request, deps) {
  const input = testActionInputs(request);
  const deepLink = `https://${input.environment}/?env=${encodeURIComponent(input.environment)}`;
  const lifecycle = {
    lifecycleVersion: 1,
    environment: input.environment,
    deepLink,
    comment: input.comment,
    requestedDeviceId: input.deviceId,
    sourceBranches: { application: input.applicationBranch, backend: input.backendBranch },
    status: "running",
    startedAt: lifecycleTimestamp(deps),
    completedAt: null,
    steps: testStepDefinitions(input.targets),
    targets: input.targets.map((target) => ({ target, status: "pending", stepIds: [] })),
    provenance: { application: null, backend: null, androidArtifact: null },
    screenshots: [],
    evidence: [],
    errors: [],
    verdict: null,
    verdictEvidence: null,
  };
  const artifacts = [];
  let built = null;
  let mobile = null;
  let adb = null;
  let trajectoryEvidence = null;
  try {
    await runTestStep(lifecycle, "resolve-sources", deps, async () => {
      const [applicationSha, backendSha] = await Promise.all([
        exactRef(deps.runner, repository(request, "application3"), input.applicationBranch),
        exactRef(deps.runner, repository(request, "backend"), input.backendBranch),
      ]);
      lifecycle.provenance.application = { repository: "application3", branch: input.applicationBranch, sha: applicationSha };
      lifecycle.provenance.backend = { repository: "backend", branch: input.backendBranch, sha: backendSha };
      return { applicationSha, backendSha };
    });
    if (input.targets.includes("Android")) {
      await runTestStep(lifecycle, "build-android", deps, async () => {
        const applicationSha = lifecycle.provenance.application.sha;
        const backendSha = lifecycle.provenance.backend.sha;
        const result = await buildSignedAndroid(request, deps, {
          directory: "chat-test-android",
          applicationSha,
          backendSha,
          includeBundle: false,
          apkFileName: `camble-${applicationSha}-${backendSha}.apk`,
          requirePackage: true,
          verifySignature: true,
          immutable: true,
          testEnvironment: input.environment,
        });
        built = result;
        const relative = relativeArtifactPath(result.root, result.apk);
        lifecycle.provenance.androidArtifact = {
          path: relative,
          sha256: result.apkSha256,
          immutable: true,
          signed: result.signing,
          versionName: result.versionName,
          buildNumber: result.buildNumber,
          packageName: result.packageName,
          applicationSha,
          backendSha,
          testHostOverlay: result.testHostOverlay,
          testHostArtifact: result.testHostArtifact,
        };
        return lifecycle.provenance.androidArtifact;
      });
    }
    if (input.targets.includes("Android")) {
      await runTestStep(lifecycle, "resolve-device", deps, async () => {
        const result = await resolveMobilerun(request, deps, input.deviceId);
        mobile = result;
        return { deviceId: result.deviceId, discoveredDevices: result.discoveredDevices, executable: path.basename(result.executable) };
      });
      await runTestStep(lifecycle, "install-android", deps, async () => {
        adb = await resolveAdb(request, deps);
        const installed = await deps.runner(adb, ["-s", mobile.deviceId, "install", "-r", built.apk], { allowFailure: true, timeoutMs: 3 * 60_000, maxOutput: 512 * 1024 });
        if (installed.code !== 0) fail("ADB failed to install the exact Chat Test APK");
        const cleared = await deps.runner(adb, ["-s", mobile.deviceId, "shell", "pm", "clear", built.packageName], { allowFailure: true, timeoutMs: 30_000, maxOutput: 64 * 1024 });
        if (cleared.code !== 0 || !/\bSuccess\b/.test(cleared.stdout)) fail("ADB failed to clear stale app state before Chat Test");
        const details = await deps.runner(adb, ["-s", mobile.deviceId, "shell", "dumpsys", "package", built.packageName], { allowFailure: true, timeoutMs: 30_000, maxOutput: 2 * 1024 * 1024 });
        if (details.code !== 0 || !new RegExp(`versionName=${built.versionName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$)`).test(details.stdout)
          || !new RegExp(`versionCode=${built.buildNumber}(?:\\s|$)`).test(details.stdout)) {
          fail(`Installed APK package ${built.packageName} did not match the built version`);
        }
        const installedArtifact = await proveInstalledAndroidArtifact(request, deps, adb, mobile, built);
        return { deviceId: mobile.deviceId, packageName: built.packageName, versionName: built.versionName, buildNumber: built.buildNumber, artifactSha256: built.apkSha256, installed: true, staleStateCleared: true, installer: path.basename(adb), installedArtifact };
      });
      await runTestStep(lifecycle, "mobilerun-thinking", deps, async () => {
        const secure = await secureMobilerunCaseConfig(deps);
        const before = await trajectoryDirectories(secure.trajectoryRoot);
        const clearedLogs = await deps.runner(adb, ["-s", mobile.deviceId, "logcat", "-c"], { allowFailure: true, timeoutMs: 30_000, maxOutput: 64 * 1024 });
        if (clearedLogs.code !== 0) fail("ADB failed to clear stale runtime logs before Chat Test");
        await mobilerunCommand(mobile, deps, ["device", "start", "-d", mobile.deviceId, built.packageName], "APK launch");
        const expectedHost = nativeTestHost(input.environment);
        if (built.testHostArtifact?.selectedHost !== expectedHost) fail(`Running APK did not prove the selected ${input.environment} backend`);
        const runtimeHostProof = await proveAndroidRuntimeHost(request, deps, adb, mobile, built.packageName, input.environment);
        const initialScreenshot = await captureMobileScreenshot(request, deps, lifecycle, artifacts, mobile, "before-thinking");
        const prompt = authenticatedMobilerunPrompt(input, built.packageName);
        const result = await deps.runner(mobile.executable, [
          "run", "-c", secure.config, "-d", mobile.deviceId,
          "--steps", "80", "--reasoning", "--vision", "--no-stream",
          "--save-trajectory", "action", prompt,
        ], { allowFailure: true, timeoutMs: 20 * 60_000, maxOutput: 2 * 1024 * 1024 });
        const directory = await newMobilerunTrajectory(secure.trajectoryRoot, before, deps);
        trajectoryEvidence = await collectMobilerunTrajectory(directory);
        if (result.code !== 0) fail("Mobilerun authenticated test case did not complete successfully");
        return {
          deviceId: mobile.deviceId,
          packageName: built.packageName,
          mode: "reasoning",
          vision: true,
          maxSteps: 80,
          authenticatedWithCredentialIds: CAMBLE_MOBILERUN_SECRET_IDS,
          selectedEnvironment: input.environment,
          runtimeHost: expectedHost,
          runtimeHostProof: {
            runtime: runtimeHostProof,
            installedArtifact: { method: "installed-apk-sha256-and-compiled-content", artifactSha256: built.apkSha256, backend: built.testHostArtifact },
          },
          initialScreenshot,
          trajectory: trajectoryEvidence,
        };
      });
      await runTestStep(lifecycle, "verify-mobile-case", deps, async () => {
        const ui = await mobilerunCommand(mobile, deps, ["device", "ui", "-d", mobile.deviceId], "APK UI verification");
        if (!ui.stdout.trim()) fail("Installed APK returned an empty UI tree");
        const target = assertFinalMobileCaseUi(ui.stdout);
        const targetScreenshot = await captureMobileScreenshot(request, deps, lifecycle, artifacts, mobile, "target-before-buttons");
        const chatReaction = await verifyButtonReaction(request, deps, lifecycle, artifacts, mobile, ui.stdout, target.controls.find((control) => control.id === "chat"), "chat-reaction");
        const afterChat = await returnToTargetMobileUi(mobile, deps, "chat");
        const giftReaction = await verifyButtonReaction(request, deps, lifecycle, artifacts, mobile, afterChat.ui, afterChat.target.controls.find((control) => control.id === "gift"), "gift-reaction");
        const afterGift = await returnToTargetMobileUi(mobile, deps, "gift");
        const closeReaction = await verifyButtonReaction(request, deps, lifecycle, artifacts, mobile, afterGift.ui, afterGift.target.controls.find((control) => control.id === "close"), "close-reaction");
        return {
          deviceId: mobile.deviceId,
          packageName: built.packageName,
          authenticated: true,
          gatesConfirmedByReachability: ["cookie-or-privacy", "age-18-plus"],
          finalUiAssertions: target.assertions,
          trajectoryActionCount: trajectoryEvidence.actionCount,
          targetScreenshot,
          interactionAssertions: [chatReaction, giftReaction, closeReaction],
        };
      });
    }
    finalizeTestLifecycle(lifecycle, true, deps);
    return ok("Camble authenticated Mobilerun test case passed", lifecycle, artifacts);
  } catch (error) {
    finalizeTestLifecycle(lifecycle, false, deps);
    throw new PluginError(`Camble chat test failed: ${conciseError(error)}`, lifecycle, []);
  }
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
      "--since=6h", "--tail=1000", "-c", item.container,
    ], { allowFailure: true, maxOutput: 2 * 1024 * 1024 });
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
    since: "6h",
    tailLinesPerPod: 1000,
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
  const deps = {
    runner: overrides.runner ?? createCommandRunner({ platform, environment }),
    fetch: overrides.fetch ?? globalThis.fetch,
    sleep: overrides.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    now: overrides.now ?? Date.now,
    progress: overrides.progress ?? (async () => {}),
    browserCapture: overrides.browserCapture ?? (overrides.runner ? captureChromeWithRunner : captureChromeCdp),
    httpEvidenceCache: new Map(),
    chromePath: overrides.chromePath,
    mobilerunPath: overrides.mobilerunPath,
    apksignerPath: overrides.apksignerPath,
    rustupPath: overrides.rustupPath,
    adbPath: overrides.adbPath,
    platform,
    environment,
  };
  const handlers = { collect, promote, "version-inspect": versionInspect, "version-apply": versionApply, "android-build": androidBuild, test: cambleTest, "cluster-observe": clusterObserve, "cluster-logs": clusterLogs, "cluster-deploy": clusterDeploy };
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

export function createProgressReporter(request, environment, stream) {
  const secrets = knownSecretValues(request, environment);
  return async (event) => {
    const safe = redactResponse(event, secrets);
    stream.write(`TEAMAI_PROGRESS ${JSON.stringify(safe)}\n`);
  };
}

async function main() {
  try {
    let raw = "";
    for await (const chunk of process.stdin) { raw += chunk; if (raw.length > 1024 * 1024) fail("Request exceeds limit"); }
    const request = JSON.parse(raw);
    const result = await executeContract(request, { progress: createProgressReporter(request, process.env, process.stderr) });
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
