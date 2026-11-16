import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { startTestServer, request } from './helpers/server-harness.js';
import { validNote } from './helpers/note-fixtures.js';

const windows = { skip: process.platform !== 'win32', timeout: 30000 };
test('atomic writes preserve exact previous bytes and keep only twenty generated backups', windows, async t => {
  const { port, dataDir } = await startTestServer(t);
  const versions = [];
  for (let index = 0; index < 24; index++) {
    const body = JSON.stringify(validNote(`版本 ${index}`), null, 2);
    versions.push(body);
    assert.equal((await request(port, '/notes.json', 'PUT', body)).status, 200);
    assert.equal(await readFile(path.join(dataDir, 'notes.json'), 'utf8'), body);
    if (index === 1) await writeFile(path.join(dataDir, 'backups', 'my-manual-backup.json'), 'leave alone');
  }
  const names = (await readdir(path.join(dataDir, 'backups'))).filter(name => name.startsWith('notes-')).sort();
  assert.equal(names.length, 20);
  const backups = await Promise.all(names.map(name => readFile(path.join(dataDir, 'backups', name), 'utf8')));
  assert.deepEqual(backups, versions.slice(3, 23));
  assert.equal(await readFile(path.join(dataDir, 'backups', 'my-manual-backup.json'), 'utf8'), 'leave alone');
  assert.equal((await request(port, '/notes.json', 'POST', versions.at(-1))).status, 200);
  assert.deepEqual((await readdir(path.join(dataDir, 'backups'))).filter(name => name.startsWith('notes-')).sort(), names);
  assert.equal((await readdir(dataDir)).some(name => name.endsWith('.tmp')), false);
  assert.equal((await request(port, '/backups/' + names[0])).status, 404);
  assert.equal((await request(port, '/scripts/storage.ps1')).status, 404);
});

test('backup creation failure returns an error and leaves the original untouched', windows, async t => {
  const { port, dataDir } = await startTestServer(t);
  const original = JSON.stringify(validNote('original'));
  await writeFile(path.join(dataDir, 'notes.json'), original);
  await writeFile(path.join(dataDir, 'backups'), 'directory path intentionally occupied');
  assert.equal((await request(port, '/notes.json', 'PUT', JSON.stringify(validNote('new')))).status, 500);
  assert.equal(await readFile(path.join(dataDir, 'notes.json'), 'utf8'), original);
  assert.equal((await readdir(dataDir)).some(name => name.endsWith('.tmp')), false);
});

test('a locked destination fails replacement without truncating the notebook', windows, async t => {
  const { port, dataDir } = await startTestServer(t);
  const filename = path.join(dataDir, 'notes.json');
  const original = JSON.stringify(validNote('locked original'));
  await writeFile(filename, original);
  const locker = spawn('powershell.exe', ['-NoProfile', '-Command',
    `$f=[IO.File]::Open('${filename.replaceAll("'", "''")}',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); [Console]::WriteLine('LOCKED'); try { $null=[Console]::ReadLine() } finally { $f.Dispose() }`,
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    await Promise.race([
      once(locker.stdout, 'data').then(([data]) => assert.match(data.toString(), /LOCKED/)),
      once(locker, 'exit').then(() => { throw new Error('Lock helper exited early'); }),
    ]);
    assert.equal((await request(port, '/notes.json', 'PUT', JSON.stringify(validNote('new')))).status, 500);
    assert.equal(await readFile(filename, 'utf8'), original);
    assert.equal((await readdir(dataDir)).some(name => name.endsWith('.tmp')), false);
  } finally {
    if (locker.exitCode === null) { const ended = once(locker, 'exit'); locker.stdin.end('\n'); await ended; }
  }
});

test('invalid JSON and interrupted requests cannot change the existing file', windows, async t => {
  const { port, dataDir } = await startTestServer(t);
  const original = JSON.stringify(validNote('preserve me'));
  await writeFile(path.join(dataDir, 'notes.json'), original);
  for (const body of ['{broken', 'null', '{"unrelated":true}', '']) {
    assert.equal((await request(port, '/notes.json', 'PUT', body)).status, 400);
  }
  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect');
  const reply = [];
  socket.on('data', data => reply.push(data));
  const ended = once(socket, 'end');
  socket.end('PUT /notes.json HTTP/1.1\r\nContent-Length: 100\r\n\r\n{"version":1');
  await ended;
  assert.match(Buffer.concat(reply).toString(), /400/);
  assert.equal(await readFile(path.join(dataDir, 'notes.json'), 'utf8'), original);
  assert.equal((await readdir(dataDir)).some(name => name.endsWith('.tmp')), false);
});
