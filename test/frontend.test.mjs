import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const source = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

test("React mini-frontend declares and registers the versioned TeamAI host contract", () => {
  const manifest = JSON.parse(source("teamai-plugin.json"));
  const entry = source("src/index.tsx");
  assert.deepEqual(manifest.frontend, {
    apiVersion: 1,
    engine: "react",
    entrypoint: "dist/frontend.js",
    stylesheet: "dist/frontend.css",
  });
  assert.match(entry, /const PLUGIN_ID = "camble-release"/);
  assert.match(entry, /TeamAIPluginHost\.register\(PLUGIN_ID/);
  assert.match(entry, /apiVersion: 1/);
  assert.match(entry, /createRoot\(container\)/);
  assert.match(entry, /update\(nextContext\)/);
  assert.match(entry, /root\.unmount\(\)/);
});

test("Camble mini-frontend preserves release console functionality and visual affordances", () => {
  const component = source("src/camble-release-console.tsx");
  const css = source("src/camble-release-console.css");
  for (const label of [
    "Preprod", "Prod", "Собрать данные", "Выберите сервисы",
    "Полный состав окружения", "TeamAI обновит только отмеченные refs.",
    "Развернуть", "История и прогресс", "Проверить версию",
    "Текущая версия", "Текущий commit", "Следующий build", "План версии",
    "Применить версию", "Android из последнего Preprod snapshot",
    "Google Play Internal", "Агент сборки", "План сборки", "Собрать Android",
    "Состояние кластера", "Deployment", "Image", "Full SHA", "Digest",
    "Readiness", "Pods", "Маппинг сервисов", "План deploy",
    "Применить deploy", "Полная история и прогресс", "Structured output",
    "Failure", "Rollback", "Artifacts",
  ]) assert.ok(component.includes(label), `missing Camble label: ${label}`);
  assert.doesNotMatch(component, /Собрать точный snapshot|<h4>1\. Snapshot<\/h4>/);
  assert.match(component, /role="tablist" aria-label="Camble release environment"/);
  assert.match(component, /snapshot\.items\)\.map/);
  assert.match(component, /latestCollectSnapshot/);
  assert.match(component, /latestVersionInspection/);
  assert.match(component, /latestPreprodSnapshot/);
  assert.match(component, /operation\.progress\.map/);
  assert.match(component, /operation\.result\?\.output/);
  assert.match(component, /operation\.result\.artifacts/);
  assert.match(component, /inspection\.commitSha/);
  assert.match(component, /text\(pod\.pod\) \|\| text\(pod\.name\)/);
  assert.match(component, /output\.rollback \?\? object\(output\.failure\)\.rollback/);
  assert.match(component, /operation\.actionId !== null && \["cluster-observe", "cluster-deploy"\]\.includes\(operation\.actionId\)/);
  assert.match(component, /REQUIRED_ACTIONS\.filter/);
  assert.match(css, /\.plugin-action-button\s*\{[^}]*border:\s*1px solid/);
  assert.match(css, /\.camble-release-console/);
  assert.match(css, /\.camble-cluster-card/);
  assert.match(css, /@media \(max-width: 900px\)[^{]*\{[^}]*\.camble-release-grid/);
});

test("production bundle contains the registered mini-frontend and stylesheet", () => {
  const script = source("dist/frontend.js");
  const style = source("dist/frontend.css");
  assert.ok(Buffer.byteLength(script) > 100_000);
  assert.ok(Buffer.byteLength(script) < 2 * 1024 * 1024);
  assert.ok(Buffer.byteLength(style) > 1_000);
  assert.ok(Buffer.byteLength(style) < 512 * 1024);
  assert.match(script, /camble-release/);
  assert.match(script, /TeamAIPluginHost/);
  assert.doesNotMatch(script, /process\.env\.NODE_ENV/, "browser bundle must not depend on Node.js process globals");
  assert.match(style, /camble-release-console/);
});
