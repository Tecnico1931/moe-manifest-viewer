/**
 * Format milliseconds as a seconds string with 3 decimal places.
 * Example: 1500 → "1.500s"
 */
export function formatTimeMs(ms: number): string {
  const seconds = ms / 1000;
  return seconds.toFixed(3) + 's';
}

/**
 * Format seconds as MM:SS.ms or HH:MM:SS.ms.
 * Example: 75.5 → "01:15.50"
 */
export function formatTimestamp(seconds: number): string {
  if (isNaN(seconds) || seconds < 0) {
    return '00:00.00';
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);
  const pad = (n: number) => (n < 10 ? '0' + n : '' + n);
  if (h > 0) {
    return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms)}`;
  }
  return `${pad(m)}:${pad(s)}.${pad(ms)}`;
}

/**
 * Format a byte count as a human-readable string (B, KB, or MB).
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return bytes + ' B';
  } else if (bytes < 1024 * 1024) {
    return (bytes / 1024).toFixed(2) + ' KB';
  } else {
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }
}
