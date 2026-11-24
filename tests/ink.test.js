import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeStroke, inkPath } from '../src/js/ink.js';
import { validateNoteData, NoteFormatError } from '../src/js/note-format.js';
import { createAppHarness } from './helpers/app-harness.js';

function penApp() {
  const app = createAppHarness();
  app.run('bindToolbar(); setTool("pen"); history.clear(); state.dirty=false');
  return app;
}

function pointer(x, y, extra = {}) {
  return { clientX: x, clientY: y, pointerId: 7, pointerType: 'mouse', button: 0,
    isPrimary: true, preventDefault() {}, stopPropagation() {}, ...extra };
}

function stroke(app, points = [[100, 150], [160, 180], [200, 160]]) {
  app.nodes.get('view').emit('pointerdown', pointer(...points[0]));
  for (const point of points.slice(1)) app.window.emit('pointermove', pointer(...point));
  app.window.emit('pointerup', pointer(...points.at(-1)));
}

const json = value => JSON.parse(JSON.stringify(value));
const inkNote = () => ({ version: 2, items: [{
  id: 1, type: 'ink', z: 1, rot: 0, ...normalizeStroke([[10, 20], [30, 40]], '#dc2626', 4),
}] });

test('a dot has a padded box and a visible round-capped path', () => {
  const dot = normalizeStroke([[30, -20]], '#dc2626', 4);
  assert.equal(dot.w, 6);
  assert.equal(dot.h, 6);
  assert.equal(dot.x + dot.points[0][0] * dot.w, 30);
  assert.equal(dot.y + dot.points[0][1] * dot.h, -20);
  assert.match(inkPath(dot.points, dot.w, dot.h), /^M3.00 3.00 l0.01 0$/);
});

test('pointer coordinates account for the viewport, pan and zoom', () => {
  const app = penApp();
  app.run('state.zoom=2; state.panX=-40; state.panY=20');
  stroke(app, [[100, 150], [160, 180]]);
  const item = app.run('state.items.at(-1)');
  assert.equal(item.type, 'ink');
  assert.deepEqual(json(item.points.map(([x, y]) => [item.x + x * item.w, item.y + y * item.h])), [[70, 41], [100, 56]]);
  assert.equal(app.nodes.get('inkLayer').querySelectorAll('.item').length, 1);
  assert.equal(app.run('gesture'), null);
  assert.equal(app.run('panning'), false);
  assert.equal(app.run('state.byId.get(1).x'), 0);
});

test('each stroke is one undo step; redo restores SVG without duplicates', () => {
  const app = penApp();
  stroke(app);
  stroke(app, [[120, 200]]);
  assert.equal(app.run('state.items.length'), 3);
  app.nodes.get('btnInkUndo').click();
  assert.equal(app.run('state.items.length'), 2);
  app.run('undo()');
  assert.equal(app.run('state.items.length'), 1);
  assert.equal(app.nodes.get('inkLayer').childNodes.length, 0);
  app.nodes.get('btnInkRedo').click();
  app.run('redo()');
  assert.equal(app.nodes.get('inkLayer').querySelectorAll('.ink-path').length, 2);
  assert.equal(app.run('state.items.at(-1).points.length'), 1);
});

test('color and width apply to new strokes; completed stroke points are detached', () => {
  const app = penApp();
  app.nodes.get('penColor').emit('input', { target: { value: '#2563eb' } });
  app.nodes.get('penWidth').emit('change', { target: { value: '8' } });
  stroke(app);
  assert.equal(app.run('state.items[1].color'), '#2563eb');
  assert.equal(app.run('state.items[1].strokeWidth'), 8);
  app.run('const snapshot=serializeForSave(); snapshot.items[1].points[0][0]=1');
  assert.notEqual(app.run('state.items[1].points[0][0]'), 1);
  app.run('undo(); redo()');
  assert.notEqual(app.run('state.items[1].points[0][0]'), 1);
});

test('autosave, export and reload retain complete editable strokes', async () => {
  const app = penApp();
  stroke(app);
  await app.autosave();
  const saved = app.requests.at(-1).data;
  assert.equal(saved.version, 2);
  validateNoteData(saved);
  app.nodes.get('btnExport').click();
  assert.deepEqual(JSON.parse(await app.downloads.at(-1).text()), saved);
  const reopened = penApp();
  reopened.context.savedInk = saved;
  reopened.run('activateLoadedNote(savedInk)');
  assert.deepEqual(json(reopened.run('serializeForSave()')), saved);
  const path = reopened.nodes.get('inkLayer').querySelector('.ink-path');
  assert.equal(path.getAttribute('stroke'), saved.items[1].color);
  assert.equal(path.getAttribute('d'), inkPath(saved.items[1].points, saved.items[1].w, saved.items[1].h));
});

test('an unfinished stroke is neither saved nor committed, and Escape removes it', () => {
  const app = penApp();
  app.nodes.get('view').emit('pointerdown', pointer(100, 150));
  app.window.emit('pointermove', pointer(200, 160));
  assert.equal(app.run('serializeForSave().version'), 1);
  assert.equal(app.run('state.dirty'), false);
  assert.equal(app.nodes.get('view').capturedPointer, 7);
  app.document.emit('keydown', { key: 'Escape', preventDefault() {} });
  assert.equal(app.run('tool'), 'select');
  assert.equal(app.nodes.get('penTools').hidden, true);
  assert.equal(app.nodes.get('view').capturedPointer, null);
  assert.equal(app.nodes.get('inkLayer').childNodes.length, 0);
  app.window.emit('pointerup', pointer(200, 160));
  assert.equal(app.run('state.items.length'), 1);
});

for (const event of ['pointercancel', 'blur', 'lostpointercapture']) {
  test(event + ' discards only the active stroke', () => {
    const app = penApp();
    stroke(app);
    app.nodes.get('view').emit('pointerdown', pointer(100, 150));
    (event === 'lostpointercapture' ? app.nodes.get('view') : app.window).emit(event, pointer(100, 150));
    app.window.emit('pointerup', pointer(200, 160));
    assert.equal(app.run('inkDraft'), null);
    assert.equal(app.run('state.items.length'), 2);
    app.run('undo()');
    assert.equal(app.run('state.items.length'), 1);
  });
}

test('secondary pointers and right mouse buttons cannot start or finish a stroke', () => {
  const app = penApp(), view = app.nodes.get('view');
  view.emit('pointerdown', pointer(100, 150, { button: 2 }));
  view.emit('pointerdown', pointer(100, 150, { isPrimary: false }));
  assert.equal(app.run('inkDraft'), null);
  view.emit('pointerdown', pointer(100, 150));
  view.emit('pointerdown', pointer(500, 500, { pointerId: 8 }));
  app.window.emit('pointermove', pointer(500, 500, { pointerId: 8 }));
  app.window.emit('pointerup', pointer(500, 500, { pointerId: 8 }));
  assert.equal(app.run('inkDraft.points.length'), 1);
  app.window.emit('pointerup', pointer(100, 150));
  assert.equal(app.run('state.items[1].points.length'), 1);
});

test('undo cancels a draft first, then undoes the preceding complete stroke', () => {
  const app = penApp();
  stroke(app);
  app.nodes.get('view').emit('pointerdown', pointer(100, 150));
  app.run('undo()');
  assert.equal(app.run('state.items.length'), 2);
  app.run('undo()');
  assert.equal(app.run('state.items.length'), 1);
});

test('strokes support independent move, resize, duplicate and delete history', () => {
  const app = penApp();
  stroke(app);
  app.run('setTool("select")');
  const original = json(app.run('state.items[1]'));
  app.run('startItemGesture({clientX:0,clientY:0,preventDefault(){}},state.byId.get(2),false)');
  app.window.emit('pointermove', pointer(20, 30));
  app.window.emit('pointerup', pointer(20, 30));
  assert.equal(app.run('state.items[1].x'), original.x + 20);
  app.run('startResizeGesture({clientX:0,clientY:0},state.byId.get(2))');
  app.window.emit('pointermove', pointer(original.w, 0));
  app.window.emit('pointerup', pointer(original.w, 0));
  assert.equal(app.run('state.items[1].w'), original.w * 2);
  app.run('duplicateItem(2)');
  assert.equal(app.run('state.items.length'), 3);
  assert.equal(app.run('state.items[1].points === state.items[2].points'), false);
  assert.deepEqual(json(app.run('state.items[2].points')), original.points);
  app.run('deleteItem(3); undo()');
  assert.equal(app.run('state.items.length'), 3);
  app.run('undo(); undo(); undo()');
  assert.equal(app.run('state.items[1].x'), original.x);
  assert.equal(app.run('state.items[1].w'), original.w);
  assert.equal(app.nodes.get('inkLayer').querySelectorAll('.ink-path').length, 1);
});

test('new notebook and undo clear and restore the ink layer', () => {
  const app = penApp();
  stroke(app);
  app.nodes.get('btnNew').click();
  assert.equal(app.run('serializeForSave().version'), 1);
  assert.equal(app.nodes.get('inkLayer').childNodes.length, 0);
  app.run('undo()');
  assert.equal(app.nodes.get('inkLayer').querySelectorAll('.item').length, 1);
});

test('adding text leaves pen mode and allows native text editing', () => {
  const app = penApp();
  app.nodes.get('btnText').click();
  assert.equal(app.run('tool'), 'select');
  assert.equal(app.run('state.editingId'), 2);
});

test('pen shortcuts work while a color or width control retains focus', () => {
  const app = penApp();
  stroke(app);
  const target = { closest() { return this; } };
  app.document.emit('keydown', { key: 'z', ctrlKey: true, target, preventDefault() {} });
  assert.equal(app.run('state.items.length'), 1);
  app.document.emit('keydown', { key: 'y', ctrlKey: true, target, preventDefault() {} });
  assert.equal(app.run('state.items.length'), 2);
  app.document.emit('keydown', { key: 'Escape', target, preventDefault() {} });
  assert.equal(app.run('tool'), 'select');
});

test('version 2 validation clones stroke points and accepts version 1 text notes', () => {
  const source = inkNote(), validated = validateNoteData(source);
  assert.equal(validated.version, 2);
  assert.deepEqual(validated.items[0].points, source.items[0].points);
  validated.items[0].points[0][0] = 1;
  assert.notEqual(source.items[0].points[0][0], 1);
  const app = penApp();
  assert.equal(validateNoteData(app.run('serializeForSave()')).version, 1);
});

for (const [label, mutate] of [
  ['old version with ink', note => { note.version = 1; }],
  ['zero height', note => { note.items[0].h = 0; }],
  ['invalid color', note => { note.items[0].color = 'url(https://example.invalid)'; }],
  ['zero width', note => { note.items[0].strokeWidth = 0; }],
  ['excessive width', note => { note.items[0].strokeWidth = 33; }],
  ['missing points', note => { delete note.items[0].points; }],
  ['empty points', note => { note.items[0].points = []; }],
  ['excessive points', note => { note.items[0].points = Array.from({ length: 10001 }, () => [0, 0]); }],
  ['malformed point', note => { note.items[0].points = [[0]]; }],
  ['string coordinate', note => { note.items[0].points = [['0', 0]]; }],
  ['nonfinite coordinate', note => { note.items[0].points = [[Infinity, 0]]; }],
  ['coordinate outside box', note => { note.items[0].points = [[0, 1.01]]; }],
]) {
  test('rejects ink with ' + label + ' before replacing current content', () => {
    const note = inkNote();
    mutate(note);
    assert.throws(() => validateNoteData(note), NoteFormatError);
    const app = penApp();
    app.context.invalidInk = note;
    assert.throws(() => app.run('applySavedData(invalidInk)'), NoteFormatError);
    assert.equal(app.run('state.items[0].html'), 'old text');
  });
}
