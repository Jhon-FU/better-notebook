import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { syncTextItem, syncActiveEditor } from '../../src/js/editor-sync.js';
import { createHistory } from '../../src/js/history.js';
import { parseNoteText, validateNoteData } from '../../src/js/note-format.js';
import { RECOVERY_KEY, readRecovery, sameNoteContent, recoveryPrompt, clearRecoveryIfUnchanged } from '../../src/js/recovery.js';

class Element {
  constructor() {
    this.listeners = new Map();
    this.childNodes = [];
    this.className = '';
    this.style = {};
    this.dataset = {};
    this.innerHTML = '';
    this.textContent = '';
    this.contentEditable = 'false';
    this.classList = {
      add: name => { this.className = [...new Set([...this.className.split(' '), name])].join(' '); },
      remove: name => { this.className = this.className.split(' ').filter(value => value !== name).join(' '); },
      toggle: (name, enabled) => enabled ? this.classList.add(name) : this.classList.remove(name),
    };
  }
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(fn);
  }
  emit(name, event = {}) {
    for (const fn of this.listeners.get(name) || []) fn(event);
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  querySelectorAll(selector) {
    const match = element => selector.startsWith('.')
      ? element.className.split(' ').includes(selector.slice(1))
      : selector === `[data-id="${element.dataset.id}"]`;
    return this.childNodes.flatMap(child => [
      ...(match(child) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
  appendChild(element) { element.parent = this; this.childNodes.push(element); }
  remove() { if (this.parent) this.parent.childNodes = this.parent.childNodes.filter(child => child !== this); }
  focus() {}
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
  document.createRange = () => ({ selectNodeContents() {}, collapse() {} });
  document.querySelector = () => new Element();
  document.body = new Element();
  document.hidden = false;
  const window = new Element();
  window.getSelection = () => ({ removeAllRanges() {}, addRange() {} });
  const context = vm.createContext({
    document, window, console, Blob, syncTextItem, syncActiveEditor, createHistory, parseNoteText, validateNoteData,
    RECOVERY_KEY, readRecovery, sameNoteContent, recoveryPrompt, clearRecoveryIfUnchanged,
    confirm: () => true,
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
      removeItem(key) { localStorage.delete(key); },
    },
    URL: {
      createObjectURL(blob) { downloads.push(blob); return 'blob:test-export'; },
      revokeObjectURL() {},
    },
  });
  const source = readFileSync(new URL('../../src/js/app.js', import.meta.url), 'utf8')
    .replace(/^import .* from '\.\/[^']+\.js';\s*/gm, '')
    .replace(/\binit\(\);\s*$/, '');
  vm.runInContext(source, context, { filename: 'src/js/app.js' });
  const run = code => vm.runInContext(code, context);
  run(`
    activateLoadedNote({version:1,items:[{id:1,type:'text',html:'old text',x:0,y:0,w:240,z:1,rot:0,fontSize:18,align:'left'}],paper:'lines',images:{}});
    enterEdit(1);
    bindGlobal();
  `);
  const editor = () => nodes.get('world').querySelector('[data-id="1"]')?.querySelector('.text-content');
  return {
    run, context, document, window, nodes, requests, timers, downloads, beacons, localStorage,
    get editor() { return editor(); },
    input(html, event = 'input') { editor().innerHTML = html; editor().emit(event); },
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
