import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { syncTextItem, syncActiveEditor } from '../../src/js/editor-sync.js';

class Element {
  constructor() {
    this.listeners = new Map();
    this.children = new Map();
    this.style = {};
    this.dataset = {};
    this.innerHTML = '';
    this.textContent = '';
    this.contentEditable = 'false';
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(fn);
  }
  emit(name, event = {}) {
    for (const fn of this.listeners.get(name) || []) fn(event);
  }
  querySelector(selector) {
    if (!this.children.has(selector)) this.children.set(selector, new Element());
    return this.children.get(selector);
  }
  querySelectorAll() { return []; }
  appendChild() {}
  remove() {}
  click() { this.emit('click'); }
  getBoundingClientRect() {
    return { left: 0, top: 48, right: 1280, bottom: 800, width: 1280, height: 752 };
  }
}

export function createAppHarness() {
  const nodes = new Map();
  const timers = new Map();
  const requests = [];
  const downloads = [];
  const beacons = [];
  const localStorage = new Map();
  let timerId = 0;
  const document = new Element();
  document.getElementById = id => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id);
  };
  document.createElement = () => new Element();
  document.body = new Element();
  document.hidden = false;
  const window = new Element();
  const context = vm.createContext({
    document, window, console, Blob, syncTextItem, syncActiveEditor,
    setTimeout(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options) => {
      requests.push({ url, ...options, data: JSON.parse(options.body) });
      return { ok: true, status: 200 };
    },
    navigator: { sendBeacon(url, blob) { beacons.push({ url, blob }); return true; } },
    localStorage: {
      setItem(key, value) { localStorage.set(key, value); },
      getItem(key) { return localStorage.get(key) ?? null; },
    },
    URL: {
      createObjectURL(blob) { downloads.push(blob); return 'blob:test-export'; },
      revokeObjectURL() {},
    },
  });
  const source = readFileSync(new URL('../../src/js/app.js', import.meta.url), 'utf8')
    .replace(/^import .*editor-sync\.js';\s*/m, '')
    .replace(/\binit\(\);\s*$/, '');
  vm.runInContext(source, context, { filename: 'src/js/app.js' });
  const run = code => vm.runInContext(code, context);
  const itemElement = new Element();
  const editor = itemElement.querySelector('.text-content');
  editor.innerHTML = 'old text';
  editor.contentEditable = 'true';
  nodes.get('world').children.set('[data-id="1"]', itemElement);
  context.testItemElement = itemElement;
  run(`
    state.items=[{id:1,type:'text',html:'old text',x:0,y:0,w:240,z:1,fontSize:18,align:'left'}];
    state.byId.set(1,state.items[0]);
    state.editingId=1;
    state.selectedId=1;
    state.loaded=true;
    bindItem(testItemElement,state.items[0]);
    bindGlobal();
  `);
  return {
    run, context, document, window, editor, nodes, requests, timers, downloads, beacons, localStorage,
    input(html, event = 'input') { editor.innerHTML = html; editor.emit(event); },
    async autosave() {
      const entry = [...timers].find(([, timer]) => timer.delay === 900);
      if (!entry) throw new Error('No autosave scheduled');
      timers.delete(entry[0]);
      entry[1].fn();
      await run('saveQueue');
    },
    async saveShortcut() {
      let prevented = false;
      document.emit('keydown', { ctrlKey: true, key: 's', preventDefault() { prevented = true; } });
      await run('saveQueue');
      return prevented;
    },
  };
}
