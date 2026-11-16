function sameDocument(left, right) {
  if (JSON.stringify({ items: left.items, paper: left.paper }) !==
      JSON.stringify({ items: right.items, paper: right.paper })) return false;
  const leftImages = left.images || {};
  const rightImages = right.images || {};
  const keys = Object.keys(leftImages);
  return keys.length === Object.keys(rightImages).length &&
    keys.every(key => leftImages[key] === rightImages[key]);
}

/** Records completed document operations. Snapshots must be detached from live items.
 * Image data URLs remain shared immutable strings instead of being JSON-copied.
 */
export function createHistory(limit = 40) {
  const past = [];
  const future = [];
  return {
    record(before, after) {
      if (sameDocument(before, after)) return false;
      past.push(before);
      if (past.length > limit) past.shift();
      future.length = 0;
      return true;
    },
    undo(current) {
      if (!past.length) return null;
      future.push(current);
      return past.pop();
    },
    redo(current) {
      if (!future.length) return null;
      past.push(current);
      return future.pop();
    },
    clear() {
      past.length = 0;
      future.length = 0;
    },
  };
}
