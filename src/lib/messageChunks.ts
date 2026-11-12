/** Keep result messages below Discord's 2000-character limit, including long single lines. */
export function chunkLines(lines: readonly string[], limit = 1900): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of lines) {
    if (!line) continue;
    for (let offset = 0; offset < line.length; offset += limit) {
      const part = line.slice(offset, offset + limit);
      if (current && current.length + part.length + 1 > limit) {
        chunks.push(current);
        current = '';
      }
      current = current ? `${current}\n${part}` : part;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
