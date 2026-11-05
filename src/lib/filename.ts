import { contentTypeForExtension, detectExtensionFromBytes, extensionForContentType } from './mime.js';

const MAX_BASE_LENGTH = 80;
const MAX_EXTENSION_LENGTH = 16;
const DISALLOWED_RUN = /[^\p{L}\p{N}._-]+/gu;
const LEADING_JUNK = /^[._-]+/;
const TRAILING_JUNK = /[._-]+$/;

function truncate(value: string, maxLength: number): string {
  const characters = Array.from(value);
  if (characters.length <= maxLength) return value;

  return characters.slice(0, maxLength).join('');
}

/** Splits `name` into the stem and a plausible extension (without the dot). */
export function splitExtension(name: string): { base: string; extension: string } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return { base: name, extension: '' };

  const candidate = name.slice(dot + 1);
  if (!new RegExp(`^[a-z0-9]{1,${MAX_EXTENSION_LENGTH}}$`, 'i').test(candidate)) {
    return { base: name, extension: '' };
  }

  return { base: name.slice(0, dot), extension: candidate.toLowerCase() };
}

export function hasExtension(name: string): boolean {
  return splitExtension(name).extension !== '';
}

export function extensionOf(name: string): string | null {
  const { extension } = splitExtension(name);
  return extension || null;
}

/**
 * Makes a filename safe for an R2 key and a public URL while keeping it
 * readable: strips directories, control/zero-width/format characters, path
 * traversal, URL-unsafe punctuation, and caps the length.
 */
export function sanitizeFilename(raw: string | null | undefined, fallback = 'file'): string {
  const withSlashes = (raw ?? '').replace(/\\/g, '/');
  const basename = withSlashes.slice(withSlashes.lastIndexOf('/') + 1);

  let name = basename.normalize('NFC').replace(DISALLOWED_RUN, '_');
  name = name.replace(/\.{2,}/g, '.').replace(LEADING_JUNK, '');

  const { base, extension } = splitExtension(name);
  let safeBase = base.replace(TRAILING_JUNK, '').replace(LEADING_JUNK, '');
  safeBase = truncate(safeBase, MAX_BASE_LENGTH).replace(TRAILING_JUNK, '');

  if (!safeBase) safeBase = fallback;

  return extension ? `${safeBase}.${extension}` : safeBase;
}

/** Appends an extension derived from the content type or the bytes when missing. */
export function ensureExtension(
  name: string,
  contentType: string | null | undefined,
  data?: Uint8Array,
): string {
  const safe = sanitizeFilename(name, 'download');
  if (hasExtension(safe)) return safe;

  const extension =
    extensionForContentType(contentType) ?? (data ? detectExtensionFromBytes(data) : null);

  return extension ? `${safe}.${extension}` : safe;
}

/** Extracts the last path segment of a URL, decoded, or an empty string. */
export function filenameFromUrl(rawUrl: string): string {
  let pathname: string;

  try {
    pathname = new URL(rawUrl).pathname;
  } catch {
    return '';
  }

  const segment = pathname.split('/').filter(Boolean).at(-1) ?? '';
  if (!segment) return '';

  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function contentTypeForFilename(name: string): string {
  return contentTypeForExtension(extensionOf(name));
}

const NON_ASCII = /[^\x20-\x7e]+/g;

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Keeps the original filename on the stored object even though the URL only
 * contains a nanoid, so downloads still get a sensible name. `filename*`
 * carries the exact name; the quoted `filename` is an ASCII fallback.
 */
export function contentDisposition(rawFilename: string): string {
  const filename = sanitizeFilename(rawFilename, 'file');
  const { extension } = splitExtension(filename);
  const extensionSuffix = extension ? `.${extension}` : '';

  const ascii = filename
    .replace(NON_ASCII, '_')
    .replace(/_+/g, '_')
    .replace(/^[._\-\s]+|[._\-\s]+$/g, '');

  const fallback = !ascii || ascii === extension ? `file${extensionSuffix}` : ascii;
  const escaped = fallback.replace(/["\\]/g, '_');

  return `inline; filename="${escaped}"; filename*=UTF-8''${encodeRfc5987(filename)}`;
}
