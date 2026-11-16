import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAppHarness } from './helpers/app-harness.js';
import { validNote, fileHandle, installPicker } from './helpers/note-fixtures.js';

const snapshot = app => app.run('JSON.stringify(serializeForSave())');

function startupApp() {
  const app = createAppHarness();
  app.run(`
    state.loaded=false; currentFileHandle=null; defaultFileReady=false;
    rebuildItems([], 'lines'); history.clear(); state.dirty=false;
    clearTimeout(state.saveTimer); state.saveTimer=null;
    restoreCustomFile=async()=>false;
  `);
  return app;
}

test('opening unrelated JSON leaves the document, target and remembered handle unchanged', async () => {
  const app = createAppHarness();
  const previous = fileHandle(validNote('previous file'), 'previous.json');
  const selected = fileHandle('{"project":"not a notebook"}');
  app.context.previousHandle = previous.handle;
  app.run('currentFileHandle=previousHandle');
  const before = snapshot(app);
  installPicker(app, selected);
  await app.run('openWithPicker()');
  assert.equal(snapshot(app), before);
  assert.equal(app.run('currentFileHandle===previousHandle'), true);
  assert.equal(app.run('state.editingId'), 1);
  assert.equal(app.context.rememberedHandles.length, 0);
  assert.equal(selected.writes, 0);
  assert.match(app.nodes.get('toast').textContent, /version/);
  await app.run('saveNow()');
  assert.equal(previous.writes, 1);
  assert.equal(selected.contents, '{"project":"not a notebook"}');
});

test('a malformed later item cannot partially replace the canvas or image map', () => {
  const app = createAppHarness();
  const before = snapshot(app);
  app.context.invalidDocument = validNote('would replace old text');
  app.context.invalidDocument.items.push(null);
  assert.throws(() => app.run('applySavedData(invalidDocument)'), /items\[1\]/);
  assert.equal(snapshot(app), before);
  assert.equal(app.editor.innerHTML, 'old text');
  assert.equal(app.run('state.editingId'), 1);
});

test('invalid opening resumes an existing autosave only to the previous target', async () => {
  const app = createAppHarness();
  const selected = fileHandle('{bad json');
  installPicker(app, selected);
  app.input('pending original draft');
  await app.run('openWithPicker()');
  await app.autosave();
  assert.equal(app.requests[0].data.items[0].html, 'pending original draft');
  assert.equal(selected.writes, 0);
});

test('valid opening cancels the old timer and never writes the selected file by itself', async () => {
  const app = createAppHarness();
  const selected = fileHandle(validNote('new document'));
  const originalBytes = selected.contents;
  installPicker(app, selected);
  app.input('discarded after confirmation');
  await app.run('openWithPicker()');
  assert.equal(app.editor.innerHTML, 'new document');
  assert.equal(app.run('state.dirty'), false);
  assert.equal(app.run('state.saveTimer'), null);
  assert.equal([...app.timers.values()].filter(timer => timer.delay === 900).length, 0);
  assert.equal(app.requests.length, 0);
  assert.equal(selected.writes, 0);
  assert.equal(selected.contents, originalBytes);
  assert.equal(app.context.rememberedHandles[0], selected.handle);
  app.run('enterEdit(1)');
  app.input('explicitly edited document');
  await app.autosave();
  assert.equal(selected.writes, 1);
  assert.equal(JSON.parse(selected.contents).items[0].html, 'explicitly edited document');
});

test('canceling replacement preserves the current document and pending save', async () => {
  const app = createAppHarness();
  installPicker(app, fileHandle(validNote('not accepted')));
  app.context.confirm = () => false;
  app.input('keep this draft');
  const before = snapshot(app);
  await app.run('openWithPicker()');
  assert.equal(snapshot(app), before);
  assert.equal(app.run('currentFileHandle'), null);
  assert.equal(app.context.rememberedHandles.length, 0);
  await app.autosave();
  assert.equal(app.requests[0].data.items[0].html, 'keep this draft');
});

test('picker cancellation and disk read failures preserve the previous state', async () => {
  for (const failure of ['cancel', 'read']) {
    const app = createAppHarness();
    const before = snapshot(app);
    const selected = fileHandle(validNote());
    installPicker(app, selected);
    if (failure === 'cancel') app.window.showOpenFilePicker = async () => { throw { name: 'AbortError' }; };
    else selected.handle.getFile = async () => { throw new Error('file unavailable'); };
    await app.run('openWithPicker()');
    assert.equal(snapshot(app), before);
    assert.equal(app.run('currentFileHandle'), null);
    assert.equal(app.run('openingFile'), false);
    assert.equal(selected.writes, 0);
  }
});

test('file reading waits for older writes, and no new save starts during the read', async () => {
  const app = createAppHarness();
  let finishOldWrite, finishRead;
  app.context.fetch = () => new Promise(resolve => { finishOldWrite = resolve; });
  app.input('old queued write');
  const oldWrite = app.run('saveNow()');
  await new Promise(resolve => setImmediate(resolve));
  const selected = fileHandle(validNote('read after the write'));
  let reads = 0;
  selected.handle.getFile = async () => {
    reads++;
    return { text: () => new Promise(resolve => { finishRead = resolve; }) };
  };
  installPicker(app, selected);
  const opening = app.run('openWithPicker()');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 0);
  finishOldWrite({ ok: true });
  await oldWrite;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1);
  assert.equal(await app.run('saveNow()'), false);
  finishRead(JSON.stringify(validNote('read after the write')));
  await opening;
  assert.equal(app.editor.innerHTML, 'read after the write');
  assert.equal(selected.writes, 0);
});

test('invalid backup import preserves history and never schedules a new write', async () => {
  const app = createAppHarness();
  app.run('exitEdit(1); setPaper("grid")');
  await app.autosave();
  const before = snapshot(app);
  app.context.badBackup = { text: async () => '{"items":[]}' };
  await app.run('importBackupFile(badBackup)');
  assert.equal(snapshot(app), before);
  assert.equal(app.requests.length, 1);
  assert.equal(app.run('state.dirty'), false);
  app.run('undo()');
  assert.equal(app.run('state.paper'), 'lines');
});

test('a valid fallback import saves the current notebook and remains undoable', async () => {
  const app = createAppHarness();
  app.run('exitEdit(1)');
  app.context.backup = { text: async () => JSON.stringify(validNote('imported backup')) };
  await app.run('importBackupFile(backup)');
  await app.autosave();
  assert.equal(app.requests[0].data.items[0].html, 'imported backup');
  assert.equal(app.run('currentFileHandle'), null);
  app.run('undo()');
  assert.equal(app.editor.innerHTML, 'old text');
});

test('invalid remembered file is never bound as the destination for fallback data', async () => {
  const app = createAppHarness();
  const remembered = fileHandle('{"unrelated":true}', 'bad-remembered.json');
  app.context.remembered = remembered.handle;
  app.run('state.loaded=false; defaultFileReady=false; idbOpen=async()=>({}); idbGet=async()=>remembered');
  app.context.fetch = async () => ({ ok: true, text: async () => JSON.stringify(validNote('default file')) });
  await app.run('loadNotes()');
  assert.equal(app.run('currentFileHandle'), null);
  assert.equal(app.editor.innerHTML, 'default file');
  assert.equal(remembered.writes, 0);
});

test('valid remembered file loads without an automatic write', async () => {
  const app = createAppHarness();
  const remembered = fileHandle(validNote('remembered file'));
  app.context.remembered = remembered.handle;
  app.run('state.loaded=false; defaultFileReady=false; idbOpen=async()=>({}); idbGet=async()=>remembered');
  assert.equal(await app.run('restoreCustomFile()'), true);
  assert.equal(app.editor.innerHTML, 'remembered file');
  assert.equal(app.run('currentFileHandle===remembered'), true);
  assert.equal(remembered.writes, 0);
  assert.equal(app.run('state.saveTimer'), null);
});

for (const [label, response] of [
  ['unrelated default JSON', { ok: true, text: async () => '{"unrelated":true}' }],
  ['malformed default JSON', { ok: true, text: async () => '{broken' }],
  ['server error', { ok: false, status: 500 }],
]) {
  test(`${label} blocks autosave, Ctrl+S and closing writes to the default file`, async () => {
    const app = startupApp();
    const writes = [];
    app.context.fetch = async (url, options) => {
      if (options.method) writes.push(options);
      return response;
    };
    await app.run('loadNotes()');
    assert.equal(app.run('state.loaded'), true);
    assert.equal(app.run('state.items.length'), 0);
    app.run('addTextAt(20,20)');
    app.input('a new draft must not overwrite the bad file');
    await app.autosave();
    await app.saveShortcut();
    app.window.emit('beforeunload');
    assert.equal(writes.length, 0);
    assert.equal(app.beacons.length, 0);
    assert.equal(app.run('state.dirty'), true);
  });
}

test('a missing default file is allowed to create the first notebook', async () => {
  const app = startupApp();
  const writes = [];
  app.context.fetch = async (url, options) => {
    if (options.method) { writes.push(JSON.parse(options.body)); return { ok: true }; }
    return { ok: false, status: 404 };
  };
  await app.run('loadNotes()');
  await app.autosave();
  assert.equal(writes.length, 1);
  assert.equal(writes[0].version, 1);
  assert.equal(writes[0].items.length, 2);
});

test('recovered browser data does not overwrite an invalid default file', async () => {
  const app = startupApp();
  app.localStorage.set('lingdong-notes', JSON.stringify(validNote('recovery copy')));
  let writes = 0;
  app.context.fetch = async (url, options) => {
    if (options.method) writes++;
    return { ok: true, text: async () => '{"unrelated":true}' };
  };
  await app.run('loadNotes()');
  assert.equal(app.editor.innerHTML, 'recovery copy');
  await app.run('saveNow()');
  assert.equal(writes, 0);
});

test('an invalid real JSON file keeps its original bytes after open and save attempts', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'better-notebook-open-'));
  t.after(async () => {
    const resolved = path.resolve(directory);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('better-notebook-open-'));
    await rm(resolved, { recursive: true, force: true });
  });
  const filename = path.join(directory, 'unrelated.json');
  const bytes = '{\n  "project": "preserve exact bytes"\n}\n';
  await writeFile(filename, bytes);
  const app = createAppHarness();
  installPicker(app, { handle: {
    name: 'unrelated.json',
    getFile: async () => ({ text: () => readFile(filename, 'utf8') }),
    createWritable: async () => ({ write: body => writeFile(filename, body), close: async () => {} }),
  } });
  await app.run('openWithPicker()');
  await app.run('saveNow()');
  assert.equal(await readFile(filename, 'utf8'), bytes);
});

test('Ctrl+S before the initial load cannot write an empty notebook', async () => {
  const app = createAppHarness();
  app.run('state.loaded=false');
  await app.saveShortcut();
  assert.equal(app.requests.length, 0);
});

test('Save As recovers a draft without writing the invalid default file', async () => {
  const app = startupApp();
  let defaultWrites = 0;
  app.context.fetch = async (url, options) => {
    if (options.method) defaultWrites++;
    return { ok: true, text: async () => '{"not":"a notebook"}' };
  };
  await app.run('loadNotes()');
  app.run('addTextAt(20,20)');
  app.input('recovered draft');
  const destination = fileHandle(validNote(), 'recovered.json');
  app.window.showSaveFilePicker = async () => destination.handle;
  app.run('idbOpen=async()=>{throw new Error("IDB unavailable in test")}');
  await app.run('saveAs()');
  assert.equal(JSON.parse(destination.contents).items[0].html, 'recovered draft');
  assert.equal(app.run('state.dirty'), false);
  assert.equal(defaultWrites, 0);
});

test('opening another file cannot overtake an unfinished Save As', async () => {
  const app = createAppHarness();
  let finishPicker, openCalls = 0;
  const destination = fileHandle(validNote(), 'new-destination.json');
  app.window.showSaveFilePicker = () => new Promise(resolve => { finishPicker = resolve; });
  app.window.showOpenFilePicker = async () => { openCalls++; return [fileHandle(validNote('other')).handle]; };
  app.run('idbOpen=async()=>{throw new Error("IDB unavailable in test")}');
  const saving = app.run('saveAs()');
  await app.run('openWithPicker()');
  assert.equal(openCalls, 0);
  finishPicker(destination.handle);
  await saving;
  assert.equal(app.run('openingFile'), false);
});
