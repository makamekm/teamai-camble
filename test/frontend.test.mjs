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

test("Camble mini-frontend exposes version, build, Preprod and Prod workflows", () => {
  const component = source("src/camble-release-console.tsx");
  const css = source("src/camble-release-console.css");
  for (const label of [
    "Версионирование", "Билд", "Preprod", "Prod", "Обновить из application3/dev",
    "Проставить версию и билд", "Свободный агент", "Собрать application",
    "dev → tags/[service]", "tags/[service] → prod/[service]", "Мультиселект сервисов",
    "Выделить все", "Сбросить выделение", "Отстал от dev", "Отстал от Preprod",
    "Актуальный", "Развернуть выбранные", "История и прогресс",
  ]) assert.ok(component.includes(label), `missing Camble workflow label: ${label}`);
  assert.match(component, /const REQUIRED_ACTIONS = \["version-inspect", "version-apply", "android-build", "collect", "promote"\]/);
  assert.match(component, /role="tablist" aria-label="Camble release workspace"/);
  assert.match(component, /useEffect\(\(\) => \{ setSelectedItems\(\[\]\); \}, \[tab, collectOperation\?\.id\]\)/);
  assert.match(component, /setSelectedItems\(availableServices\.map/);
  assert.match(component, /compatible\(id\)\.find\(isAgentFree\)/);
  assert.match(component, /Текущий commit:/);
  assert.match(component, /Исходный commit:/);
  assert.match(component, /sourceRef: text\(item\.sourceRef\)/);
  assert.match(component, /targetRef: text\(item\.targetRef\)/);
  assert.match(component, /operation\.progress\.map/);
  assert.match(css, /\.plugin-action-button\s*\{[^}]*border:\s*1px solid/);
  assert.match(css, /\.camble-workspace-tabs/);
  assert.match(css, /\.camble-ref-status\.stale/);
  assert.match(css, /@media \(max-width: 560px\)/);
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
