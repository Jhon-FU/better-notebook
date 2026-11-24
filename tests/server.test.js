import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

function request(port, url, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: url, method, agent: false,
      headers: body === undefined ? {} : {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode, type: res.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.setTimeout(2000, () => req.destroy(new Error('HTTP request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

test('PowerShell server serves split assets and isolates test notes', {
  skip: process.platform !== 'win32', timeout: 20000,
}, async t => {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'better-notebook-test-'));
  const child = spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'server.ps1'),
    '-Port', String(port), '-DataDirectory', dataDir,
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null) {
      const ended = once(child, 'exit');
      child.kill();
      await ended;
    }
    const resolved = path.resolve(dataDir);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('better-notebook-test-')) {
      throw new Error('Unexpected test cleanup directory');
    }
    await rm(resolved, { recursive: true, force: true });
  });
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${errors}`);
    try {
      if ((await request(port, '/notebook.html')).status === 200) { ready = true; break; }
    } catch { /* Server is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, errors);

  const html = await request(port, '/notebook.html');
  assert.match(html.body, /type="module" src="src\/js\/app\.js"/);
  assert.match(html.body, /href="src\/styles\/notebook\.css"/);
  for (const [url, type] of [
    ['/src/styles/notebook.css', 'text/css'],
    ['/src/js/app.js', 'text/javascript'],
    ['/src/js/editor-sync.js', 'text/javascript'],
    ['/src/js/history.js', 'text/javascript'],
    ['/src/js/note-format.js', 'text/javascript'],
    ['/src/js/recovery.js', 'text/javascript'],
    ['/src/js/ink.js', 'text/javascript'],
    ['/icon.ico', 'image/x-icon'],
  ]) {
    const result = await request(port, url);
    assert.equal(result.status, 200, url);
    assert.ok(result.type.startsWith(type), url);
    assert.ok(result.body.length > 0, url);
  }
  for (const url of ['/profile/Default/Preferences', '/server.ps1', '/.git/config']) {
    assert.equal((await request(port, url)).status, 404, url);
  }
  assert.equal((await request(port, '/notes.json')).status, 404);
  const note = { version: 1, paper: 'lines', items: [{ id: 1, type: 'text', html: '独立测试笔记' }], images: {} };
  assert.equal((await request(port, '/notes.json', 'PUT', JSON.stringify(note))).status, 200);
  assert.deepEqual(JSON.parse((await request(port, '/notes.json')).body), note);
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, 'notes.json'), 'utf8')), note);
  const inkNote = { version: 2, paper: 'lines', items: [
    { id: 1, type: 'ink', x: 10, y: 20, w: 100, h: 80, z: 1, rot: 0,
      color: '#dc2626', strokeWidth: 4, points: [[0.1, 0.2], [0.9, 0.8]] },
  ], images: {} };
  assert.equal((await request(port, '/notes.json', 'PUT', JSON.stringify(inkNote))).status, 200);
  assert.deepEqual(JSON.parse((await request(port, '/notes.json')).body), inkNote);
  assert.deepEqual(JSON.parse(await readFile(path.join(dataDir, 'notes.json'), 'utf8')), inkNote);
});
