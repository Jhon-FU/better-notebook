import { parseNoteText } from './note-format.js';

export const RECOVERY_KEY = 'lingdong-notes';

export function readRecovery(storage) {
  const text = storage.getItem(RECOVERY_KEY);
  return text ? { text, note: parseNoteText(text) } : null;
}

export function sameNoteContent(left, right) {
  const content = note => JSON.stringify({
    paper: note.paper, items: note.items,
    images: Object.keys(note.images).sort().map(key => [key, note.images[key]]),
  });
  return content(left) === content(right);
}

export function recoveryPrompt(file, recovery) {
  const time = note => note.updatedAt ? new Date(note.updatedAt).toLocaleString() : '旧格式，时间未知';
  const relation = !file.updatedAt || !recovery.updatedAt ? '时间无法比较' :
    recovery.updatedAt > file.updatedAt ? '浏览器副本较新' :
    recovery.updatedAt < file.updatedAt ? '文件版本较新' : '时间相同，但内容不同';
  return `发现未完成写入的浏览器副本（${relation}）。\n文件版本：${time(file)}\n浏览器副本：${time(recovery)}\n\n是否恢复浏览器副本？\n确定：恢复，检查后请按保存；不会立即覆盖文件。\n取消：使用文件版本，副本保留到下次保存。`;
}

// A completed older request must not erase a newer queued recovery snapshot.
export function clearRecoveryIfUnchanged(storage, expected) {
  if (storage.getItem(RECOVERY_KEY) === expected) storage.removeItem(RECOVERY_KEY);
}
