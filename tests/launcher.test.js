import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, cp, mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { projectRoot, freePort, request, startTestServer } from './helpers/server-harness.js';

const windows = { skip: process.platform !== 'win32', timeout: 45000 };
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'better-notebook-launcher-'));
  const root = path.join(directory, '笔记 有空格 & 副本');
  const processes = new Set();
  t.after(async () => {
    for (const pid of processes) {
      try { process.kill(pid); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('better-notebook-launcher-'));
    await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await mkdir(root);
  for (const name of ['scripts', 'src', 'launcher.ps1', 'server.ps1', 'notebook.html', 'icon.ico', 'package.json']) {
    await cp(path.join(projectRoot, name), path.join(root, name), { recursive: true });
  }
  return { root, processes };
}

async function launch(f, port, timeout = 10) {
  const child = spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(f.root, 'launcher.ps1'),
    '-Port', String(port), '-CheckOnly', '-StartupTimeoutSeconds', String(timeout),
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data.toString(); });
  child.stderr.on('data', data => { output += data.toString(); });
  const watchdog = setTimeout(() => child.kill(), 20000);
  const closed = once(child, 'close');
  let code;
  try { [code] = await once(child, 'exit'); } finally { clearTimeout(watchdog); }
  if (code === 0) {
    // Windows can retain inherited pipe handles in the detached server. The
    // launcher has exited; do not wait for that long-lived child to close them.
    child.stdout.destroy();
    child.stderr.destroy();
    const health = JSON.parse((await request(port, '/health')).body);
    assert.equal(health.root, f.root);
    assert.ok(Number.isInteger(health.pid) && health.pid > 0);
    f.processes.add(health.pid);
  } else await closed;
  return { code, output };
}

test('launcher starts from a Unicode path containing spaces and reuses only the matching server', windows, async t => {
  const f = await fixture(t);
  const port = await freePort();
  const first = await launch(f, port);
  assert.equal(first.code, 0, first.output);
  const health = JSON.parse((await request(port, '/health')).body);
  assert.equal(health.app, 'better-notebook');
  assert.equal(health.protocol, 1);
  assert.equal(health.dataDirectory, f.root);
  assert.match(health.build, /^[a-f0-9]{64}$/);
  assert.equal((await request(port, '/notebook.html')).status, 200);
  const second = await launch(f, port);
  assert.equal(second.code, 0, second.output);
  assert.equal(JSON.parse((await request(port, '/health')).body).pid, health.pid);
  await assert.rejects(access(path.join(f.root, 'profile')));
  assert.equal(await readFile(path.join(f.root, 'logs', `server-${port}.error.log`), 'utf8'), '');
  assert.equal((await request(port, '/logs/server-' + port + '.error.log')).status, 404);
});

test('launcher refuses an unrelated HTTP server instead of treating an open port as ready', windows, async t => {
  const f = await fixture(t);
  const unrelated = http.createServer((req, res) => res.end('{"app":"unrelated"}'));
  unrelated.listen(0, '127.0.0.1');
  await once(unrelated, 'listening');
  t.after(() => new Promise(resolve => unrelated.close(resolve)));
  const result = await launch(f, unrelated.address().port);
  assert.equal(result.code, 1);
  assert.match(result.output, /unrecognized service/);
  await assert.rejects(access(path.join(f.root, 'logs')));
});

test('launcher does not follow health redirects', windows, async t => {
  const f = await fixture(t);
  let redirected = false;
  const other = http.createServer((req, res) => {
    if (req.url === '/redirected') redirected = true;
    res.writeHead(302, { Location: '/redirected' });
    res.end();
  });
  other.listen(0, '127.0.0.1');
  await once(other, 'listening');
  t.after(() => new Promise(resolve => other.close(resolve)));
  const result = await launch(f, other.address().port);
  assert.equal(result.code, 1);
  assert.equal(redirected, false);
});

test('an open TCP port without an HTTP health response is never considered ready', windows, async t => {
  const f = await fixture(t);
  const sockets = new Set();
  const other = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  other.listen(0, '127.0.0.1');
  await once(other, 'listening');
  t.after(() => new Promise(resolve => {
    for (const socket of sockets) socket.destroy();
    other.close(resolve);
  }));
  const result = await launch(f, other.address().port);
  assert.equal(result.code, 1);
  assert.match(result.output, /health check failed or timed out/);
});

test('launcher rejects another notebook installation on the selected port', windows, async t => {
  const first = await fixture(t);
  const second = await fixture(t);
  const port = await freePort();
  const start = await launch(first, port);
  assert.equal(start.code, 0, start.output);
  const result = await launch(second, port);
  assert.equal(result.code, 1);
  assert.match(result.output, /another notebook directory/);
  assert.equal(JSON.parse((await request(port, '/health')).body).root, first.root);
});

test('launcher rejects a server using a different data directory', windows, async t => {
  const f = await fixture(t);
  const server = await startTestServer(t, { root: f.root });
  f.processes.add(server.child.pid);
  const result = await launch(f, server.port);
  assert.equal(result.code, 1);
  assert.match(result.output, /another notebook directory/);
});

test('launcher detects a server left running after the application files changed', windows, async t => {
  const f = await fixture(t);
  const port = await freePort();
  const start = await launch(f, port);
  assert.equal(start.code, 0, start.output);
  const previous = JSON.parse((await request(port, '/health')).body);
  await appendFile(path.join(f.root, 'src/js/app.js'), '\n// Test a new build on disk.\n');
  const result = await launch(f, port);
  assert.equal(result.code, 1);
  assert.match(result.output, /outdated notebook service/);
  assert.deepEqual(JSON.parse((await request(port, '/health')).body), previous);
});

test('server startup failure reports the exit code and saves stderr for diagnosis', windows, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'scripts/server.ps1'), "param([int]$Port)\nWrite-Error 'deliberate startup failure'\nexit 7\n");
  const port = await freePort();
  const result = await launch(f, port);
  assert.equal(result.code, 1);
  assert.match(result.output, /exited before becoming ready/);
  assert.match(result.output, /exit 7/);
  assert.match(result.output, /error\.log/);
  const diagnostic = await readFile(path.join(f.root, 'logs', `server-${port}.error.log`), 'utf8');
  assert.ok(diagnostic.replace(/\s/g, '').includes('deliberatestartupfailure'));
});

test('startup timeout stops only the stalled child created by that launcher', windows, async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, 'scripts/server.ps1'), "param([int]$Port)\n[IO.File]::WriteAllText((Join-Path $PSScriptRoot '../stalled.pid'),[string]$PID)\nStart-Sleep -Seconds 30\n");
  const result = await launch(f, await freePort(), 1);
  assert.equal(result.code, 1);
  assert.match(result.output, /startup timed out/);
  const pid = Number(await readFile(path.join(f.root, 'stalled.pid'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('the server entry point propagates a port binding failure', windows, async t => {
  const f = await fixture(t);
  const port = await freePort();
  const first = await launch(f, port);
  assert.equal(first.code, 0, first.output);
  const child = spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(f.root, 'server.ps1'), '-Port', String(port),
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  child.stderr.on('data', data => { errors += data.toString(); });
  const [code] = await once(child, 'close');
  assert.equal(code, 1);
  assert.match(errors, /could not bind/);
  assert.equal((await request(port, '/health')).status, 200);
});
