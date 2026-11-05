const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;
const TRAILING_PUNCTUATION = /[.,!?;:'"…*|]+$/;
const TRAILING_BRACKETS: ReadonlyArray<readonly [string, string]> = [
  [')', '('],
  [']', '['],
  ['}', '{'],
];

function countCharacter(value: string, character: string): number {
  let count = 0;

  for (const current of value) {
    if (current === character) count += 1;
  }

  return count;
}

/**
 * Removes sentence punctuation and unbalanced closing brackets from the end of
 * a match, so `(see https://example.com/a_(b)).` keeps `a_(b)`.
 */
function trimTrailing(raw: string): string {
  let value = raw;

  for (;;) {
    const before = value;

    value = value.replace(TRAILING_PUNCTUATION, '');

    for (const [closing, opening] of TRAILING_BRACKETS) {
      if (value.endsWith(closing) && countCharacter(value, closing) > countCharacter(value, opening)) {
        value = value.slice(0, -1);
      }
    }

    if (value === before) return value;
  }
}

/** Every distinct http(s) URL in a message, in the order they appear. */
export function extractUrls(content: string): string[] {
  const matches = content.match(URL_PATTERN) ?? [];
  const seen = new Set<string>();
  const urls: string[] = [];

  for (const match of matches) {
    const candidate = trimTrailing(match);
    if (!candidate || seen.has(candidate)) continue;

    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      continue;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    if (!parsed.hostname) continue;

    seen.add(candidate);
    urls.push(candidate);
  }

  return urls;
}
