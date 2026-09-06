import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, realpath } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { createCommandRunner, execute, executeContract } from '../plugin.mjs';

// Execute the actual UI serializer, not a parallel hand-written payload.
const uiSource = await readFile(new URL('../src/confirmed-plan.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(uiSource, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { confirmedPlan } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
const gitPath = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim();
const pluginPath = new URL('../plugin.mjs', import.meta.url).pathname;
const baseEnv = { PATH: process.env.PATH, HOME: os.tmpdir(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
function git(cwd, args, input) { return execFileSync(gitPath, args, { cwd, env: baseEnv, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'camble-real-git-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repositories = [];
  const states = {};
  const env = { ...baseEnv, GIT_CONFIG_COUNT: '4', GIT_CONFIG_KEY_0: 'protocol.file.allow', GIT_CONFIG_VALUE_0: 'always', GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null' };
  for (const [i, id] of ['application3', 'backend'].entries()) {
    const remote = path.join(root, `${id}.git`);
    const checkout = path.join(root, 'repositories', id);
    await mkdir(checkout, { recursive: true });
    git(root, ['init', '--bare', remote]);
    git(checkout, ['init']);
    const tree = git(remote, ['mktree'], '');
    const old = git(remote, ['commit-tree', tree], `${id} old\n`);
    const sha = git(remote, ['commit-tree', tree, '-p', old], `${id} approved\n`);
    const newer = git(remote, ['commit-tree', tree, '-p', sha], `${id} unapproved\n`);
    for (const [ref, value] of [['dev', sha], ['tags/component', old], ['prod/component', old]]) git(remote, ['update-ref', `refs/heads/${ref}`, value]);
    const url = `https://github.com/fixture/${id}`;
    env[`GIT_CONFIG_KEY_${i + 2}`] = `url.${remote}.insteadOf`;
    env[`GIT_CONFIG_VALUE_${i + 2}`] = url;
    repositories.push({ id, url, path: checkout, workspacePath: checkout });
    states[id] = { remote, checkout, old, sha, newer };
  }
  const services = Object.entries(states).map(([id, s]) => ({ id: id === 'backend' ? 'component' : id, sourceSha: s.sha, targetSha: s.old }));
  const request = { apiVersion: 1, actionId: 'promote', workspace: { path: root, root }, repositories, tools: { git: gitPath }, input: { environment: 'preprod', items: ['application3', 'component'], 'dry-run': false, 'confirmed-plan': confirmedPlan('preprod', ['application3', 'component'], services) } };
  const runner = createCommandRunner({ environment: env, tools: request.tools });
  return { root, states, request, env, runner, services };
}
function head(state, ref = 'tags/component') { return git(state.remote, ['rev-parse', `refs/heads/${ref}`]); }

test('real Git promotion uses displayed UI SHAs and repository-specific object databases; prod preserves component mapping', async (t) => {
  const f = await fixture(t);
  const pushes = [];
  const result = await execute(f.request, { runner: async (command, args, options) => {
    if (args[0] === 'push') pushes.push({ args, cwd: options.cwd });
    return f.runner(command, args, options);
  } });
  assert.equal(result.output.refStatus, 'refs_updated');
  assert.equal(result.output.deploymentStatus, 'unverified');
  assert.match(result.summary, /deployment unverified/);
  for (const s of Object.values(f.states)) assert.equal(head(s), s.sha);
  assert.deepEqual(pushes.map(p => p.cwd), Object.values(f.states).map(s => s.checkout));
  assert.ok(pushes.every(p => p.args.some(a => a.endsWith(':refs/heads/tags/component'))));
  assert.equal(git(f.states.application3.remote, ['for-each-ref', '--format=%(refname)', 'refs/heads/tags/application']), '');
  f.request.input = { ...f.request.input, environment: 'prod', 'confirmed-plan': confirmedPlan('prod', f.request.input.items, f.services) };
  const prod = await execute(f.request, { environment: f.env });
  assert.equal(prod.status, 'ok');
  for (const s of Object.values(f.states)) assert.equal(head(s, 'prod/component'), s.sha);
});

for (const changed of ['source', 'target']) test(`confirmed ${changed} movement fails before any publication`, async (t) => {
  const f = await fixture(t);
  git(f.states.backend.remote, ['update-ref', `refs/heads/${changed === 'source' ? 'dev' : 'tags/component'}`, f.states.backend.newer]);
  const result = await executeContract(f.request, { environment: f.env });
  assert.equal(result.exitCode, 1);
  assert.match(result.response.summary, /refs moved/);
  assert.equal(head(f.states.application3), f.states.application3.old);
});

test('missing or zero UI confirmation cannot publish', async (t) => {
  const f = await fixture(t);
  delete f.request.input['confirmed-plan'];
  assert.equal((await executeContract(f.request, { environment: f.env })).exitCode, 1);
  f.request.input['confirmed-plan'] = JSON.stringify({ version: 1, environment: 'preprod', services: [['application3', '0'.repeat(40), null], ['component', f.states.backend.sha, f.states.backend.old]] });
  assert.match((await executeContract(f.request, { environment: f.env })).response.summary, /Zero/);
  assert.equal(head(f.states.application3), f.states.application3.old);
});

test('real partial push failure compensates only this operation and records durable state', async (t) => {
  const f = await fixture(t);
  const result = await executeContract(f.request, { runner: async (command, args, options) => {
    if (args[0] === 'push' && options.cwd === f.states.backend.checkout) return { code: 1, stdout: '', stderr: '' };
    return f.runner(command, args, options);
  } });
  assert.equal(result.exitCode, 1);
  assert.equal(head(f.states.application3), f.states.application3.old);
  assert.equal(result.response.output.failure.rollback[0].outcome, 'restored');
  assert.equal(JSON.parse(await readFile(path.join(f.root, 'plugin-recovery.json'), 'utf8')).output.recoveryRequired, false);
});

test('cancel after actual push with lost acknowledgement reconciles then restores under independent cleanup signal', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  let interrupted = false;
  const result = await executeContract(f.request, { signal: controller.signal, runner: async (command, args, options) => {
    const result = await f.runner(command, args, options);
    if (args[0] === 'push' && !interrupted) { interrupted = true; controller.abort(); throw new Error('lost acknowledgement'); }
    return result;
  } });
  assert.equal(result.exitCode, 1);
  assert.equal(result.response.output.cancelled, true);
  assert.equal(result.response.output.recoveryRequired, false);
  for (const s of Object.values(f.states)) assert.equal(head(s), s.old);
});

test('rollback lease conflict retains concurrent writer and reports recovery required', async (t) => {
  const f = await fixture(t);
  const result = await executeContract(f.request, { runner: async (command, args, options) => {
    if (args[0] === 'push' && options.cwd === f.states.backend.checkout) {
      git(f.states.application3.remote, ['update-ref', 'refs/heads/tags/component', f.states.application3.newer]);
      return { code: 1, stdout: '', stderr: '' };
    }
    return f.runner(command, args, options);
  } });
  assert.equal(head(f.states.application3), f.states.application3.newer);
  assert.equal(result.response.output.failure.rollback[0].outcome, 'lease-conflict');
  assert.equal(result.response.output.recoveryRequired, true);
});

test('SIGKILL leaves fsynced in-flight recovery evidence after a real remote write', async (t) => {
  const f = await fixture(t);
  const childScript = path.join(f.root, 'kill-fixture.mjs');
  await writeFile(childScript, `import { createCommandRunner, execute } from ${JSON.stringify(pluginPath)};\nconst request = ${JSON.stringify(f.request)}; const runner = createCommandRunner({environment: process.env, tools: request.tools});\nawait execute(request, {runner: async (command,args,options) => { const result = await runner(command,args,options); if(args[0] === 'push') { process.send('pushed'); await new Promise(() => {}); } return result; }});\n`);
  const child = spawn(process.execPath, [childScript], { env: f.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  await Promise.race([once(child, 'message'), once(child, 'exit').then(() => { throw new Error('fixture exited before push'); }), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('fixture timeout')), 15_000); timer.unref(); })]);
  child.kill('SIGKILL');
  await once(child, 'exit');
  assert.equal(head(f.states.application3), f.states.application3.sha);
  const report = JSON.parse(await readFile(path.join(f.root, 'plugin-recovery.json'), 'utf8'));
  assert.equal(report.output.steps[0].applyStatus, 'in-flight');
  assert.equal(report.output.recoveryRequired, true);
  assert.equal(report.output.recovery.cancellationDoesNotProveRollback, true);
});

test('real CLI SIGTERM reconciles an interrupted Git acknowledgement and persists restored refs', async (t) => {
  const f = await fixture(t);
  const wrapper = path.join(f.root, 'git-wrapper');
  await writeFile(wrapper, `#!${process.execPath}\nimport { execFileSync } from 'node:child_process';\nconst args=process.argv.slice(2); try { const out=execFileSync(${JSON.stringify(gitPath)},args,{env:process.env}); process.stdout.write(out); if(args[0]==='push' && args.includes(${JSON.stringify(`${f.states.application3.sha}:refs/heads/tags/component`)})) { process.kill(process.ppid,'SIGTERM'); setTimeout(()=>process.exit(0),10000); } } catch { process.exit(1); }\n`);
  await chmod(wrapper, 0o700);
  f.request.tools.git = wrapper;
  const child = spawn(process.execPath, [pluginPath], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.resume();
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  child.stdin.end(JSON.stringify(f.request));
  const [code] = await Promise.race([once(child, 'exit'), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('SIGTERM recovery timeout')), 15000); timer.unref(); })]);
  assert.equal(code, 1);
  const response = JSON.parse(stdout);
  assert.equal(response.output.cancelled, true);
  assert.equal(response.output.recoveryRequired, false);
  assert.equal(response.output.failure.rollback[0].outcome, 'restored');
  for (const s of Object.values(f.states)) assert.equal(head(s), s.old);
});

test('host Git helper credentials and hardening reach only Git, configured kubectl wins over PATH', async (t) => {
  const f = await fixture(t);
  const env = { ...f.env, TEAMAI_GIT_TOKEN_0: 'fixture-secret', TEAMAI_GIT_CREDENTIAL_MAP: 'fixture-map', TEAMAI_AGENT_EXECUTABLE: process.execPath, GIT_CONFIG_COUNT: '6', GIT_CONFIG_KEY_4: 'credential.helper', GIT_CONFIG_VALUE_4: '', GIT_CONFIG_KEY_5: 'credential.helper', GIT_CONFIG_VALUE_5: '!f() { printf "username=fixture\\npassword=%s\\n" "$TEAMAI_GIT_TOKEN_0"; }; f' };
  const runner = createCommandRunner({ environment: env, tools: { git: gitPath, node: process.execPath } });
  const auth = await runner('git', ['-c', `alias.fixture=!printf 'url=https://example.invalid/repo\\n\\n' | '${gitPath}' credential fill`, 'fixture']);
  assert.match(auth.stdout, /password=fixture-secret/);
  assert.equal((await runner('git', ['config', '--get', 'core.hooksPath'])).stdout.trim(), '/dev/null');
  const nonGit = await runner('node', ['-e', 'console.log(JSON.stringify(process.env))']);
  assert.doesNotMatch(nonGit.stdout, /fixture-secret|TEAMAI_GIT|GIT_CONFIG|TEAMAI_AGENT_EXECUTABLE/);
  const tool = path.join(f.root, 'configured kubectl');
  await writeFile(tool, `#!${process.execPath}\nconsole.log('configured-tool');\n`); await chmod(tool, 0o700);
  const selected = createCommandRunner({ environment: { PATH: '/nonexistent' }, tools: { kubectl: tool } });
  assert.equal((await selected('kubectl', ['version'])).stdout.trim(), 'configured-tool');
  await assert.rejects(createCommandRunner({ tools: { kubectl: 'relative' } })('kubectl', []), /absolute tool path/);
});
