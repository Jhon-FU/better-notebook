import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppHarness } from './helpers/app-harness.js';
import { syncActiveEditor } from '../src/js/editor-sync.js';

test('typing updates the model and autosaves without blur', async () => {
  const app = createAppHarness();
  app.input('新的中文笔记 <b>加粗</b>');
  assert.equal(app.run('state.items[0].html'), app.editor.innerHTML);
  assert.equal(app.nodes.get('status').textContent, '未保存');
  assert.equal(app.run('state.dirty'), true);
  await app.autosave();
  assert.equal(app.requests[0].data.items[0].html, app.editor.innerHTML);
  assert.equal(app.run('state.dirty'), false);
  assert.equal(app.run('state.editingId'), 1);
  assert.equal(app.editor.contentEditable, 'true');
});

test('Ctrl+S flushes visible text even without an input event', async () => {
  const app = createAppHarness();
  app.editor.innerHTML = '<p>still editing, newest text</p>';
  assert.equal(await app.saveShortcut(), true);
  assert.equal(app.requests[0].data.items[0].html, app.editor.innerHTML);
  assert.equal(app.run('state.editingId'), 1);
  assert.match(app.nodes.get('status').textContent, /^已保存到默认位置/);
});

test('Chinese composition completion schedules the final text', async () => {
  const app = createAppHarness();
  app.input('中文输入完成', 'compositionend');
  await app.autosave();
  assert.equal(app.requests[0].data.items[0].html, '中文输入完成');
});

test('rapid input uses one debounce timer and persists the last value', async () => {
  const app = createAppHarness();
  for (const text of ['一', '一二', '一二三']) app.input(text);
  assert.equal([...app.timers.values()].filter(timer => timer.delay === 900).length, 1);
  await app.autosave();
  assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].data.items[0].html, '一二三');
});

test('custom file saving includes text that has not blurred', async () => {
  const app = createAppHarness();
  const writes = [];
  app.context.customHandle = {
    name: 'custom.json',
    createWritable: async () => ({ write: async body => writes.push(JSON.parse(body)), close: async () => {} }),
  };
  app.run('currentFileHandle=customHandle');
  app.editor.innerHTML = 'latest custom file content';
  await app.saveShortcut();
  assert.equal(writes[0].items[0].html, app.editor.innerHTML);
  assert.equal(app.requests.length, 0);
});

test('export includes the active rich-text editor', async () => {
  const app = createAppHarness();
  app.run('bindToolbar()');
  app.editor.innerHTML = '<b>new export content</b>';
  app.nodes.get('btnExport').emit('click');
  const data = JSON.parse(await app.downloads[0].text());
  assert.equal(data.items[0].html, app.editor.innerHTML);
});

test('Save As includes the active editor without forcing blur', async () => {
  const app = createAppHarness();
  let written;
  app.window.showSaveFilePicker = async () => ({
    name: 'saved-as.json',
    createWritable: async () => ({ write: async body => { written = JSON.parse(body); }, close: async () => {} }),
  });
  app.run('idbOpen=async()=>{throw new Error("IDB unavailable in test")}');
  app.editor.innerHTML = 'new Save As text';
  await app.run('saveAs()');
  assert.equal(written.items[0].html, app.editor.innerHTML);
  assert.equal(app.run('state.editingId'), 1);
});

test('an older save cannot mark newer edits as saved', async () => {
  const app = createAppHarness();
  let resolveRequest;
  app.context.fetch = () => new Promise(resolve => { resolveRequest = resolve; });
  app.input('first revision');
  const first = app.run('saveNow()');
  await new Promise(resolve => setImmediate(resolve));
  app.input('second revision');
  resolveRequest({ ok: true });
  await first;
  assert.equal(app.run('state.dirty'), true);
  assert.equal(app.nodes.get('status').textContent, '有新修改，等待保存');
});

test('overlapping saves are written in order', async () => {
  const app = createAppHarness();
  const requests = [];
  let finishFirst;
  app.context.fetch = async (url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) await new Promise(resolve => { finishFirst = resolve; });
    return { ok: true };
  };
  app.input('first');
  const first = app.run('saveNow()');
  await new Promise(resolve => setImmediate(resolve));
  app.input('second');
  const second = app.run('saveNow()');
  assert.equal(requests.length, 1);
  finishFirst();
  await Promise.all([first, second]);
  assert.deepEqual(requests.map(data => data.items[0].html), ['first', 'second']);
  assert.equal(app.run('state.dirty'), false);
});

test('a failed custom-file write stays dirty and reports an error', async () => {
  const app = createAppHarness();
  app.context.customHandle = { name: 'full.json', createWritable: async () => { throw new Error('disk full'); } };
  app.run('currentFileHandle=customHandle');
  app.input('not yet saved');
  await app.run('saveNow()');
  assert.equal(app.run('state.dirty'), true);
  assert.equal(app.nodes.get('status').className, 'err');
});

test('background save sees the currently edited text', async () => {
  const app = createAppHarness();
  app.input('background draft');
  app.document.hidden = true;
  app.document.emit('visibilitychange');
  await app.run('saveQueue');
  assert.equal(app.requests[0].data.items[0].html, 'background draft');
});

test('closing serialization sees the currently edited text', async () => {
  const app = createAppHarness();
  app.input('closing draft');
  app.window.emit('beforeunload');
  const data = JSON.parse(await app.beacons[0].blob.text());
  assert.equal(data.items[0].html, 'closing draft');
});

test('synchronization tolerates no editor or a removed editor', () => {
  assert.equal(syncActiveEditor({ editingId: null }, () => null), false);
  assert.equal(syncActiveEditor({ editingId: 1, byId: new Map() }, () => null), false);
});
