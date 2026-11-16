export class NoteFormatError extends Error {
  constructor(path, reason) {
    super(`笔记格式不正确：${path} ${reason}`);
    this.name = 'NoteFormatError';
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const fail = (path, reason) => { throw new NoteFormatError(path, reason); };

function number(value, path, { positive = false, integer = false } = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, '必须是有限数字');
  if (positive && value <= 0) fail(path, '必须大于 0');
  if (integer && (!Number.isSafeInteger(value) || value > Number.MAX_SAFE_INTEGER - 2)) fail(path, '必须是安全整数');
  return value;
}

/** Validate the whole document before the caller changes any live state. */
export function validateNoteData(data) {
  if (!isObject(data)) fail('文件', '必须是对象');
  if (data.version !== 1) fail('version', '必须为 1；不支持缺失或其他版本');
  const updatedAt = data.updatedAt === undefined ? 0 : data.updatedAt;
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0 || updatedAt > 8640000000000000) {
    fail('updatedAt', '必须是有效的非负毫秒时间戳');
  }
  if (!Array.isArray(data.items)) fail('items', '必须是数组');
  const paper = data.paper === undefined ? 'lines' : data.paper;
  if (!['lines', 'grid', 'blank'].includes(paper)) fail('paper', '不是支持的纸张类型');
  const sourceImages = data.images === undefined ? {} : data.images;
  if (!isObject(sourceImages)) fail('images', '必须是图片资源对象');
  const images = Object.create(null);
  for (const [key, value] of Object.entries(sourceImages)) {
    if (!key || ['__proto__', 'constructor', 'prototype'].includes(key)) fail('images', '包含无效资源标识');
    if (typeof value !== 'string' || !/^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/]+={0,2}$/i.test(value) ||
        value.slice(value.indexOf(',') + 1).length % 4 !== 0) {
      fail(`images.${key}`, '必须是内嵌 Base64 图片');
    }
    images[key] = value;
  }
  const ids = new Set();
  const items = data.items.map((raw, index) => {
    const path = `items[${index}]`;
    if (!isObject(raw)) fail(path, '必须是对象');
    const id = number(raw.id, `${path}.id`, { positive: true, integer: true });
    if (ids.has(id)) fail(`${path}.id`, '不能重复');
    ids.add(id);
    if (!['text', 'image'].includes(raw.type)) fail(`${path}.type`, '必须是 text 或 image');
    const item = {
      id, type: raw.type,
      x: number(raw.x, `${path}.x`), y: number(raw.y, `${path}.y`),
      w: number(raw.w, `${path}.w`, { positive: true }),
      z: number(raw.z, `${path}.z`, { integer: true }),
      rot: number(raw.rot === undefined ? 0 : raw.rot, `${path}.rot`),
    };
    if (item.z < 0) fail(`${path}.z`, '不能为负数');
    if (raw.type === 'text') {
      if (typeof raw.html !== 'string') fail(`${path}.html`, '必须是字符串');
      item.html = raw.html;
      item.fontSize = number(raw.fontSize === undefined ? 18 : raw.fontSize, `${path}.fontSize`, { positive: true });
      item.align = raw.align === undefined ? 'left' : raw.align;
      if (!['left', 'center', 'right'].includes(item.align)) fail(`${path}.align`, '不是支持的对齐方式');
    } else {
      item.h = number(raw.h, `${path}.h`, { positive: true });
      if (typeof raw.srcId !== 'string' || !own(images, raw.srcId)) fail(`${path}.srcId`, '没有对应的图片资源');
      item.srcId = raw.srcId;
    }
    return item;
  });
  return { version: 1, updatedAt, paper, items, images };
}

export function parseNoteText(text) {
  let data;
  try {
    if (typeof text !== 'string') throw new TypeError('Expected text');
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new NoteFormatError('文件', '不是有效的 JSON');
  }
  return validateNoteData(data);
}
