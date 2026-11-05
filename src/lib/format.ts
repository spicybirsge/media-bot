export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;

  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unit = 0;

  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${value.toFixed(1)} ${units[unit] ?? 'B'}`;
}

export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainingSeconds = seconds % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${remainingSeconds}s`;
  if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;

  return `${remainingSeconds}s`;
}

/** A ten-cell unicode bar for embeds: `▰▰▰▰▱▱▱▱▱▱`. */
export function progressBar(percent: number, width = 10): string {
  const safeWidth = Math.max(1, Math.floor(width));
  const clamped = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
  const filled = Math.round((clamped / 100) * safeWidth);

  return `${'▰'.repeat(filled)}${'▱'.repeat(safeWidth - filled)}`;
}
