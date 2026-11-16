import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppHarness } from './helpers/app-harness.js';
import { validNote, fileHandle, installPicker } from './helpers/note-fixtures.js';

const note = (html, updatedAt) => ({ ...validNote(html), updatedAt });
function startup(file, local, accept = true) {
  const app = createAppHarness();
  const prompts = [], writes = [];
  app.run('state.loaded=false; restoreCustomFile=async()=>false');
  if (local) app.localStorage.set('lingdong-notes', typeof local === 'string' ? local : JSON.stringify(local));
  app.context.confirm = message => { prompts.push(message); return accept; };
  app.context.fetch = async (url, options) => {
    if (options.method) { writes.push(JSON.parse(options.body)); return { ok: true }; }
    return { ok: true, text: async () => JSON.stringify(file) };
  };
  return { app, prompts, writes };
}

test('failed default save is offered on restart even when the server returns an older file', async () => {
  const initial = createAppHarness();
  initial.input('new offline draft');
  initial.context.fetch = async () => { throw new Error('offline'); };
  await initial.autosave();
  const copy = JSON.parse(initial.localStorage.get('lingdong-notes'));
  assert.ok(copy.updatedAt > 0);
  assert.equal(initial.run('state.dirty'), true);
  const { app, prompts, writes } = startup(note('old disk content', 1), copy);
  await app.run('loadNotes()');
  assert.match(prompts[0], /浏览器副本较新/);
  assert.equal(app.editor.innerHTML, 'new offline draft');
  assert.equal(app.run('state.dirty'), true);
  assert.equal(app.run('state.saveTimer'), null);
  installPicker(app, fileHandle('{bad json'));
  await app.run('openWithPicker()');
  assert.equal(app.run('state.saveTimer'), null);
  app.document.hidden = true;
  app.document.emit('visibilitychange');
  app.window.emit('beforeunload');
  assert.equal(writes.length, 0);
  assert.equal(app.beacons.length, 0);
  await app.saveShortcut();
  assert.equal(writes[0].items[0].html, 'new offline draft');
  assert.equal(app.localStorage.has('lingdong-notes'), false);
});

test('declining recovery keeps the disk version and retains the copy until the next save', async () => {
  const { app, writes } = startup(note('disk', 10), note('local', 20), false);
  const copy = app.localStorage.get('lingdong-notes');
  await app.run('loadNotes()');
  assert.equal(app.editor.innerHTML, 'disk');
  assert.equal(app.run('state.dirty'), false);
  assert.equal(app.localStorage.get('lingdong-notes'), copy);
  assert.equal(writes.length, 0);
  await app.saveShortcut();
  assert.equal(app.localStorage.has('lingdong-notes'), false);
});

test('older, equal-time conflicting and legacy copies show the appropriate comparison', async () => {
  for (const [localTime, fileTime, message] of [[10, 20, '文件版本较新'], [20, 20, '时间相同'], [undefined, undefined, '时间无法比较']]) {
    const { app, prompts } = startup(note('disk', fileTime), note('local', localTime), false);
    await app.run('loadNotes()');
    assert.ok(prompts[0].includes(message));
    assert.equal(app.editor.innerHTML, 'disk');
  }
});

test('identical content clears an acknowledged recovery copy without prompting or rewriting', async () => {
  const { app, prompts, writes } = startup(note('same', 20), note('same', 10));
  await app.run('loadNotes()');
  assert.equal(prompts.length, 0);
  assert.equal(writes.length, 0);
  assert.equal(app.localStorage.has('lingdong-notes'), false);
  assert.equal(app.run('state.updatedAt'), 20);
});

test('a corrupt browser copy cannot prevent loading a valid server file', async () => {
  const { app, prompts } = startup(note('disk', 20), '{bad json');
  await app.run('loadNotes()');
  assert.equal(app.editor.innerHTML, 'disk');
  assert.equal(prompts.length, 0);
});

test('successful saves clear fallback data so it cannot resurrect later', async () => {
  const app = createAppHarness();
  app.input('success');
  await app.autosave();
  assert.equal(app.localStorage.has('lingdong-notes'), false);
  assert.equal(app.run('state.dirty'), false);
});

test('an older completed save cannot erase the latest queued recovery copy', async () => {
  const app = createAppHarness();
  let finishFirst, calls = 0;
  app.context.fetch = async () => {
    if (++calls === 1) return new Promise(resolve => { finishFirst = resolve; });
    throw new Error('offline');
  };
  app.input('first');
  const first = app.run('saveNow()');
  await new Promise(resolve => setImmediate(resolve));
  app.input('second');
  const second = app.run('saveNow()');
  finishFirst({ ok: true });
  await Promise.all([first, second]);
  assert.equal(JSON.parse(app.localStorage.get('lingdong-notes')).items[0].html, 'second');
  assert.equal(app.run('state.dirty'), true);
});

test('storage quota failure does not block disk saving and is explicit if both fail', async () => {
  for (const diskWorks of [true, false]) {
    const app = createAppHarness();
    app.context.localStorage.setItem = () => { throw new Error('quota'); };
    app.context.fetch = async () => ({ ok: diskWorks, status: diskWorks ? 200 : 500 });
    app.input('draft');
    await app.autosave();
    assert.equal(app.run('state.dirty'), !diskWorks);
    if (!diskWorks) assert.match(app.nodes.get('status').textContent, /副本也未能写入/);
  }
});

test('a custom-file save leaves the default notebook recovery copy alone', async () => {
  const app = createAppHarness();
  const copy = JSON.stringify(note('default backup', 20));
  app.localStorage.set('lingdong-notes', copy);
  app.context.handle = fileHandle(validNote()).handle;
  app.run('currentFileHandle=handle');
  app.input('custom draft');
  await app.autosave();
  assert.equal(app.localStorage.get('lingdong-notes'), copy);
});

test('closing checkpoints the exact beacon payload for unacknowledged writes', async () => {
  const app = createAppHarness();
  app.input('closing draft');
  app.window.emit('beforeunload');
  assert.equal(app.localStorage.get('lingdong-notes'), await app.beacons[0].blob.text());
});

test('edit timestamps advance even when the system clock moves backward', () => {
  const app = createAppHarness();
  app.run('state.updatedAt=Date.now()+100000');
  const before = app.run('state.updatedAt');
  app.input('first');
  app.input('second');
  assert.ok(app.run('state.updatedAt') > before);
});
