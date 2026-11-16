/** Copy the visible rich text into the document model without ending editing. */
export function syncTextItem(item, content) {
  if (!item || item.type !== 'text' || !content) return false;
  if (item.html === content.innerHTML) return false;
  item.html = content.innerHTML;
  return true;
}

/** Final synchronization used by every save/export path. */
export function syncActiveEditor(state, findElement) {
  if (state.editingId == null) return false;
  const item = state.byId.get(state.editingId);
  const content = findElement(state.editingId)?.querySelector('.text-content');
  return syncTextItem(item, content);
}
