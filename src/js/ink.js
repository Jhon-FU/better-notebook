/** Convert canvas points to a padded box and detached, normalized coordinates. */
export function normalizeStroke(points, color, strokeWidth) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  const padding = strokeWidth / 2 + 1;
  const x = minX - padding, y = minY - padding;
  const w = maxX - minX + padding * 2, h = maxY - minY + padding * 2;
  return { x, y, w, h, color, strokeWidth, points: points.map(p => [(p[0] - x) / w, (p[1] - y) / h]) };
}

export function inkPath(points, w = 1, h = 1) {
  const path = points.map(([x, y], index) => `${index ? 'L' : 'M'}${(x * w).toFixed(2)} ${(y * h).toFixed(2)}`).join(' ');
  // A tiny round-capped segment makes a click visible as a dot in all engines.
  return points.length === 1 ? path + ' l0.01 0' : path;
}
