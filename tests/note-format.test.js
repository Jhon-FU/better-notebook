import test from 'node:test';
import assert from 'node:assert/strict';
import { NoteFormatError, parseNoteText, validateNoteData } from '../src/js/note-format.js';
import { validNote } from './helpers/note-fixtures.js';

test('valid text and embedded-image notes round-trip without mutating input', () => {
  const source = validNote('<b>中文</b>');
  source.items.push({ id: 2, type: 'image', x: -100, y: 10, w: 300, h: 200, z: 2, srcId: 'img1' });
  source.images.img1 = 'data:image/png;base64,VEVTVA==';
  const original = JSON.stringify(source);
  const parsed = parseNoteText(original);
  assert.equal(parsed.items[0].html, '<b>中文</b>');
  assert.equal(parsed.images.img1, source.images.img1);
  assert.equal(parsed.items[1].rot, 0);
  assert.equal(JSON.stringify(source), original);
  parsed.items[0].html = 'changed copy';
  assert.equal(source.items[0].html, '<b>中文</b>');
});

test('UTF-8 BOM, an empty notebook and optional defaults are supported', () => {
  assert.equal(parseNoteText('\uFEFF' + JSON.stringify(validNote())).version, 1);
  const empty = validateNoteData({ version: 1, items: [] });
  assert.equal(empty.paper, 'lines');
  assert.equal(empty.items.length, 0);
  const source = validNote();
  delete source.items[0].fontSize;
  delete source.items[0].align;
  delete source.items[0].rot;
  const item = validateNoteData(source).items[0];
  assert.equal(item.fontSize, 18);
  assert.equal(item.align, 'left');
  assert.equal(item.rot, 0);
});

for (const [label, source] of [
  ['malformed JSON', '{"items":'],
  ['unrelated JSON', '{"project":"unrelated"}'],
  ['array root', '[]'],
  ['null root', 'null'],
  ['missing version', '{"items":[]}'],
  ['unsupported version', '{"version":3,"items":[]}'],
  ['string version', '{"version":"1","items":[]}'],
]) {
  test(`rejects ${label}`, () => assert.throws(() => parseNoteText(source), NoteFormatError));
}

for (const [label, mutate, errorPath] of [
  ['negative update time', note => { note.updatedAt = -1; }, 'updatedAt'],
  ['invalid update time', note => { note.updatedAt = 'yesterday'; }, 'updatedAt'],
  ['out-of-range update time', note => { note.updatedAt = Number.MAX_SAFE_INTEGER; }, 'updatedAt'],
  ['items not an array', note => { note.items = {}; }, 'items'],
  ['invalid paper', note => { note.paper = 'unsupported'; }, 'paper'],
  ['invalid images container', note => { note.images = []; }, 'images'],
  ['null item', note => { note.items.push(null); }, 'items[1]'],
  ['duplicate ids', note => { note.items.push({ ...note.items[0] }); }, 'items[1].id'],
  ['string id', note => { note.items[0].id = '1'; }, '.id'],
  ['unsafe id', note => { note.items[0].id = Number.MAX_SAFE_INTEGER; }, '.id'],
  ['unknown item type', note => { note.items[0].type = 'script'; }, '.type'],
  ['non-finite coordinate', note => { note.items[0].x = Infinity; }, '.x'],
  ['numeric string coordinate', note => { note.items[0].y = '20'; }, '.y'],
  ['zero width', note => { note.items[0].w = 0; }, '.w'],
  ['negative stacking order', note => { note.items[0].z = -1; }, '.z'],
  ['object HTML', note => { note.items[0].html = {}; }, '.html'],
  ['negative font size', note => { note.items[0].fontSize = -1; }, '.fontSize'],
  ['invalid alignment', note => { note.items[0].align = 'diagonal'; }, '.align'],
  ['missing image resource', note => { note.items[0] = { ...note.items[0], type: 'image', h: 100, srcId: 'absent' }; }, '.srcId'],
  ['zero image height', note => { note.items[0] = { ...note.items[0], type: 'image', h: 0, srcId: 'image' }; }, '.h'],
  ['external image URL', note => { note.images.image = 'https://example.invalid/image.png'; }, 'images.image'],
  ['incomplete Base64 image', note => { note.images.image = 'data:image/png;base64,ABC'; }, 'images.image'],
]) {
  test(`rejects ${label} with a useful field location`, () => {
    const note = validNote();
    mutate(note);
    assert.throws(() => validateNoteData(note), error => error instanceof NoteFormatError && error.message.includes(errorPath));
  });
}

test('rejects prototype-like image keys and overflow in otherwise valid JSON', () => {
  const source = validNote();
  source.images = JSON.parse('{"__proto__":"data:image/png;base64,VEVTVA=="}');
  assert.throws(() => validateNoteData(source), NoteFormatError);
  assert.throws(() => parseNoteText(JSON.stringify(validNote()).replace('"x":20', '"x":1e400')), NoteFormatError);
});
