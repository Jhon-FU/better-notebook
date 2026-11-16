import test from 'node:test';
import assert from 'node:assert/strict';
import { createHistory } from '../src/js/history.js';
import { createAppHarness } from './helpers/app-harness.js';

const documentAt = x => ({ items: [{ id: 1, x }], paper: 'lines', images: {} });

function canvasApp() {
  const app = createAppHarness();
  app.run('exitEdit(1); history.clear(); state.dirty=false');
  return app;
}

function moveTo(app, x) {
  const dx = x - app.run('state.byId.get(1).x');
  app.run('startItemGesture({pointerType:"mouse",button:0,clientX:0,clientY:0,preventDefault(){}},state.byId.get(1),false)');
  app.window.emit('pointermove', { clientX: dx / 2, clientY: 0 });
  app.window.emit('pointermove', { clientX: dx, clientY: 0 });
  app.window.emit('pointerup');
}

test('the first operation can be undone and redone to its latest state', () => {
  const history = createHistory();
  const before = documentAt(0), after = documentAt(10);
  history.record(before, after);
  assert.deepEqual(history.undo(after), before);
  assert.equal(history.undo(before), null);
  assert.deepEqual(history.redo(before), after);
  assert.equal(history.redo(after), null);
});

test('new changes discard redo, while no-op changes preserve it', () => {
  const history = createHistory();
  const a = documentAt(0), b = documentAt(10), c = documentAt(20);
  history.record(a, b);
  history.undo(b);
  assert.equal(history.record(a, documentAt(0)), false);
  assert.deepEqual(history.redo(a), b);
  history.undo(b);
  history.record(a, c);
  assert.equal(history.redo(c), null);
  assert.deepEqual(history.undo(c), a);
});

test('history keeps forty operations and can redo all of them', () => {
  const history = createHistory(40);
  for (let i = 0; i < 45; i++) history.record(documentAt(i), documentAt(i + 1));
  let current = documentAt(45);
  for (let i = 44; i >= 5; i--) {
    current = history.undo(current);
    assert.equal(current.items[0].x, i);
  }
  assert.equal(history.undo(current), null);
  for (let i = 6; i <= 45; i++) {
    current = history.redo(current);
    assert.equal(current.items[0].x, i);
  }
  assert.equal(history.redo(current), null);
});

test('clearing history removes both undo and redo states', () => {
  const history = createHistory();
  history.record(documentAt(0), documentAt(10));
  history.undo(documentAt(10));
  history.clear();
  assert.equal(history.undo(documentAt(0)), null);
  assert.equal(history.redo(documentAt(0)), null);
});

test('image changes are recorded even when item metadata is unchanged', () => {
  const history = createHistory();
  const before = { ...documentAt(0), images: { img1: 'old image' } };
  const after = { ...documentAt(0), images: { img1: 'new image' } };
  assert.equal(history.record(before, after), true);
  assert.equal(history.undo(after).images.img1, 'old image');
});

test('first deletion restores the item and its DOM, then redoes deletion', () => {
  const app = canvasApp();
  app.run('deleteItem(1)');
  assert.equal(app.run('state.items.length'), 0);
  app.run('undo()');
  assert.equal(app.run('state.items.length'), 1);
  assert.equal(app.editor.innerHTML, 'old text');
  app.run('redo()');
  assert.equal(app.run('state.items.length'), 0);
  assert.equal(app.editor, undefined);
});

test('two drags undo one at a time and redo to the latest coordinates', () => {
  const app = canvasApp();
  moveTo(app, 20);
  moveTo(app, 50);
  app.run('undo()');
  assert.equal(app.run('state.byId.get(1).x'), 20);
  app.run('undo()');
  assert.equal(app.run('state.byId.get(1).x'), 0);
  app.run('redo()');
  assert.equal(app.run('state.byId.get(1).x'), 20);
  app.run('redo()');
  assert.equal(app.run('state.byId.get(1).x'), 50);
});

test('duplicate after undo discards the old redo branch', () => {
  const app = canvasApp();
  moveTo(app, 20);
  moveTo(app, 50);
  app.run('undo(); duplicateItem(1); redo()');
  assert.equal(app.run('state.items.length'), 2);
  assert.equal(app.run('state.byId.get(1).x'), 20);
  app.run('undo()');
  assert.equal(app.run('state.items.length'), 1);
});

test('entering and leaving an unchanged editor does not consume redo', () => {
  const app = canvasApp();
  moveTo(app, 20);
  app.run('undo(); enterEdit(1); exitEdit(1); redo()');
  assert.equal(app.run('state.byId.get(1).x'), 20);
});

test('one edit session, including block formatting, is one canvas operation', () => {
  const app = createAppHarness();
  app.input('first edit');
  app.input('<b>finished edit</b>');
  app.run('changeFontSize(2); setAlign("center"); exitEdit(1); undo()');
  assert.equal(app.editor.innerHTML, 'old text');
  assert.equal(app.run('state.byId.get(1).fontSize'), 18);
  assert.equal(app.run('state.byId.get(1).align'), 'left');
  app.run('redo()');
  assert.equal(app.editor.innerHTML, '<b>finished edit</b>');
  assert.equal(app.run('state.byId.get(1).fontSize'), 20);
  assert.equal(app.run('state.byId.get(1).align'), 'center');
});

test('double-clicking an already active editor preserves the edit transaction', () => {
  const app = createAppHarness();
  app.input('first part');
  app.run('enterEdit(1)');
  app.input('second part');
  app.run('exitEdit(1); undo()');
  assert.equal(app.editor.innerHTML, 'old text');
});

test('Ctrl+Z, Ctrl+Shift+Z and Ctrl+Y remain native while text is being edited', () => {
  const app = createAppHarness();
  for (const [key, shiftKey] of [['z', false], ['z', true], ['y', false]]) {
    let prevented = false;
    app.document.emit('keydown', { key, shiftKey, ctrlKey: true, preventDefault() { prevented = true; } });
    assert.equal(prevented, false);
    assert.equal(app.run('state.editingId'), 1);
  }
});

test('canvas keyboard shortcuts undo and redo', () => {
  const app = canvasApp();
  moveTo(app, 20);
  let prevented = 0;
  const key = (value, shiftKey = false) => app.document.emit('keydown', {
    ctrlKey: true, key: value, shiftKey, preventDefault() { prevented++; },
  });
  key('z');
  assert.equal(app.run('state.byId.get(1).x'), 0);
  key('z', true);
  assert.equal(app.run('state.byId.get(1).x'), 20);
  key('z');
  key('y');
  assert.equal(app.run('state.byId.get(1).x'), 20);
  assert.equal(prevented, 4);
});

test('adding an image supports first undo and preserves image data on redo', () => {
  const app = canvasApp();
  app.run('addImage("data:image/png;base64,TEST",640,480,{x:100,y:100})');
  app.run('undo()');
  assert.equal(app.run('state.items.length'), 1);
  app.run('redo()');
  assert.equal(app.run('state.items.length'), 2);
  assert.equal(app.run('state.images[state.items[1].srcId]'), 'data:image/png;base64,TEST');
});

test('image resize and rotation each undo separately', () => {
  const app = canvasApp();
  app.run('addImage("data:image/png;base64,TEST",640,480,{x:100,y:100})');
  const width = app.run('state.items[1].w');
  app.run('imgZoom(2); rotateBy(90); undo()');
  assert.equal(app.run('state.items[1].rot'), 0);
  assert.equal(app.run('state.items[1].w'), width * 2);
  app.run('undo()');
  assert.equal(app.run('state.items[1].w'), width);
  app.run('redo(); redo()');
  assert.equal(app.run('state.items[1].rot'), 90);
});

test('paper changes undo correctly without duplicate entries', () => {
  const app = canvasApp();
  app.run('setPaper("grid"); setPaper("grid"); undo()');
  assert.equal(app.run('state.paper'), 'lines');
  app.run('redo()');
  assert.equal(app.run('state.paper'), 'grid');
});

test('new blank canvas can be undone and redone', () => {
  const app = canvasApp();
  app.run('bindToolbar()');
  app.nodes.get('btnNew').emit('click');
  assert.equal(app.run('state.items.length'), 0);
  app.run('undo()');
  assert.equal(app.editor.innerHTML, 'old text');
  app.run('redo()');
  assert.equal(app.run('state.items.length'), 0);
});

test('opening another document clears both history stacks', () => {
  const app = canvasApp();
  moveTo(app, 20);
  moveTo(app, 50);
  app.run('undo(); applySavedData({version:1,items:[{id:9,type:"text",html:"another file",x:100,y:0,w:240,z:1}],images:{},paper:"blank"}); undo(); redo()');
  assert.equal(app.run('state.items.length'), 1);
  assert.equal(app.run('state.items[0].id'), 9);
  assert.equal(app.run('state.paper'), 'blank');
});

test('import history retains both old and new image resources', () => {
  const app = canvasApp();
  app.run(`
    addImage('data:image/png;base64,T0xE',640,480,{x:100,y:100});
    const beforeImport=beginHistoryChange();
    applySavedData({version:1,items:[{id:9,type:'image',srcId:'imported',w:100,h:100,x:0,y:0,z:1}],images:{imported:'data:image/png;base64,TkVX'}},{resetHistory:false});
    commitHistoryChange(beforeImport); undo();
  `);
  assert.equal(app.run('state.images[state.items[1].srcId]'), 'data:image/png;base64,T0xE');
  app.run('redo()');
  assert.equal(app.run('state.images.imported'), 'data:image/png;base64,TkVX');
});

test('undo and redo still autosave the restored document', async () => {
  const app = canvasApp();
  moveTo(app, 20);
  app.run('undo()');
  await app.autosave();
  assert.equal(app.requests.at(-1).data.items[0].x, 0);
  app.run('redo()');
  await app.autosave();
  assert.equal(app.requests.at(-1).data.items[0].x, 20);
});

test('adding and editing a text card are separate undoable operations', () => {
  const app = canvasApp();
  app.run(`
    addTextAt(10,20);
    const newEditor=elOf(2).querySelector('.text-content');
    newEditor.innerHTML='new card content';
    newEditor.emit('input');
    exitEdit(2); undo();
  `);
  assert.equal(app.run('state.items.length'), 2);
  assert.equal(app.run('state.byId.get(2).html'), '双击编辑文字内容…');
  app.run('undo()');
  assert.equal(app.run('state.items.length'), 1);
  app.run('redo(); redo()');
  assert.equal(app.run('state.byId.get(2).html'), 'new card content');
});

test('resize and rotate gestures each create one history entry', () => {
  const app = canvasApp();
  app.run('startResizeGesture({clientX:0,clientY:0},state.byId.get(1))');
  app.window.emit('pointermove', { clientX: 20, clientY: 0 });
  app.window.emit('pointermove', { clientX: 60, clientY: 0 });
  app.window.emit('pointerup');
  app.run('startRotateGesture({clientX:740,clientY:424},state.byId.get(1))');
  app.window.emit('pointermove', { clientX: 640, clientY: 524 });
  app.window.emit('pointerup');
  assert.equal(app.run('state.byId.get(1).rot'), 90);
  app.run('undo()');
  assert.equal(app.run('state.byId.get(1).rot'), 0);
  assert.equal(app.run('state.byId.get(1).w'), 300);
  app.run('undo()');
  assert.equal(app.run('state.byId.get(1).w'), 240);
  app.run('redo(); redo()');
  assert.equal(app.run('state.byId.get(1).rot'), 90);
  assert.equal(app.run('state.byId.get(1).w'), 300);
});

test('clicking and dragging back to the start do not add history entries', () => {
  const app = canvasApp();
  app.run('startItemGesture({pointerType:"mouse",button:0,clientX:0,clientY:0,preventDefault(){}},state.byId.get(1),false)');
  app.window.emit('pointerup');
  assert.equal(app.run('history.undo(serializeForSave())'), null);
  app.run('startItemGesture({pointerType:"mouse",button:0,clientX:0,clientY:0,preventDefault(){}},state.byId.get(1),false)');
  app.window.emit('pointermove', { clientX: 20, clientY: 0 });
  app.window.emit('pointermove', { clientX: 0, clientY: 0 });
  app.window.emit('pointerup');
  assert.equal(app.run('history.undo(serializeForSave())'), null);
});
