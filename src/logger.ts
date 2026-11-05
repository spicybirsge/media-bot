type Level = 'INFO' | 'WARN' | 'ERROR';

function write(level: Level, message: string, details?: unknown): void {
  const line = `[${new Date().toISOString()}] ${level} ${message}`;
  const log = level === 'INFO' ? console.log : level === 'WARN' ? console.warn : console.error;

  if (details === undefined) {
    log(line);
    return;
  }

  log(line, details);
}

export const logger = {
  info(message: string, details?: unknown): void {
    write('INFO', message, details);
  },
  warn(message: string, details?: unknown): void {
    write('WARN', message, details);
  },
  error(message: string, details?: unknown): void {
    write('ERROR', message, details);
  },
};
