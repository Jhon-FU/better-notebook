import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
export function request(port, url, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path: url, method, agent: false,
      headers: body === undefined ? {} : {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(5000, () => req.destroy(new Error('HTTP request timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

export async function freePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

export async function startTestServer(t, { root = projectRoot, dataDir, port } = {}) {
  port ??= await freePort();
  const ownsDirectory = !dataDir;
  dataDir ??= await mkdtemp(path.join(os.tmpdir(), 'better-notebook-test-'));
  const child = spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'server.ps1'),
    '-Port', String(port), '-DataDirectory', dataDir,
  ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; }
    if (ownsDirectory) {
      const resolved = path.resolve(dataDir);
      assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith('better-notebook-test-'));
      await rm(resolved, { recursive: true, force: true });
    }
  });
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${errors}`);
    try { if ((await request(port, '/notebook.html')).status === 200) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(ready, true, errors);
  return { port, dataDir, child };
}
