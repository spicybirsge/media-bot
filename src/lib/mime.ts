/**
 * Small, dependency-free MIME<->extension mapping plus content sniffing.
 * Content sniffing matters for links that are served as
 * `application/octet-stream` or without a Content-Type at all.
 */

const MIME_TO_EXTENSION: Readonly<Record<string, string>> = {
  'application/atom+xml': 'atom',
  'application/epub+zip': 'epub',
  'application/gzip': 'gz',
  'application/java-archive': 'jar',
  'application/javascript': 'js',
  'application/json': 'json',
  'application/ld+json': 'jsonld',
  'application/msword': 'doc',
  'application/octet-stream': 'bin',
  'application/ogg': 'ogx',
  'application/pdf': 'pdf',
  'application/rtf': 'rtf',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.oasis.opendocument.spreadsheet': 'ods',
  'application/vnd.oasis.opendocument.text': 'odt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/wasm': 'wasm',
  'application/x-7z-compressed': '7z',
  'application/x-bzip2': 'bz2',
  'application/x-rar-compressed': 'rar',
  'application/x-tar': 'tar',
  'application/xhtml+xml': 'html',
  'application/xml': 'xml',
  'application/zip': 'zip',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/wav': 'wav',
  'audio/webm': 'weba',
  'font/otf': 'otf',
  'font/ttf': 'ttf',
  'font/woff': 'woff',
  'font/woff2': 'woff2',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff',
  'image/vnd.microsoft.icon': 'ico',
  'image/webp': 'webp',
  'text/css': 'css',
  'text/csv': 'csv',
  'text/html': 'html',
  'text/javascript': 'js',
  'text/markdown': 'md',
  'text/plain': 'txt',
  'text/xml': 'xml',
  'video/mp2t': 'ts',
  'video/mp4': 'mp4',
  'video/mpeg': 'mpeg',
  'video/ogg': 'ogv',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-flv': 'flv',
  'video/x-m4v': 'm4v',
  'video/x-matroska': 'mkv',
  'video/x-msvideo': 'avi',
};

const EXTENSION_TO_MIME: Readonly<Record<string, string>> = (() => {
  const map: Record<string, string> = {};

  for (const [mime, extension] of Object.entries(MIME_TO_EXTENSION)) {
    if (!(extension in map)) map[extension] = mime;
  }

  return {
    ...map,
    csv: 'text/csv',
    htm: 'text/html',
    html: 'text/html',
    mjs: 'text/javascript',
    svgz: 'image/svg+xml',
    tif: 'image/tiff',
    yml: 'text/yaml',
    yaml: 'text/yaml',
  };
})();

/** Strips parameters and lowercases, e.g. `Text/HTML; charset=utf-8` -> `text/html`. */
export function normalizeContentType(value: string | null | undefined): string {
  return value?.split(';')[0]?.trim().toLowerCase() ?? '';
}

export function extensionForContentType(contentType: string | null | undefined): string | null {
  const base = normalizeContentType(contentType);
  if (!base) return null;

  const mapped = MIME_TO_EXTENSION[base];
  if (mapped) return mapped;

  // Unknown subtype of a known family: image/heic -> heic, video/x-flv -> flv.
  const [family = '', subtype = ''] = base.split('/');
  if ((family === 'image' || family === 'video' || family === 'audio') && /^[a-z0-9]{1,8}$/.test(subtype)) {
    return subtype;
  }

  return null;
}

export function contentTypeForExtension(extension: string | null | undefined): string {
  if (!extension) return 'application/octet-stream';

  return EXTENSION_TO_MIME[extension.toLowerCase()] ?? 'application/octet-stream';
}

function matchesBytes(data: Uint8Array, offset: number, bytes: readonly number[]): boolean {
  if (offset + bytes.length > data.byteLength) return false;

  for (let index = 0; index < bytes.length; index += 1) {
    if (data[offset + index] !== bytes[index]) return false;
  }

  return true;
}

function matchesAscii(data: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > data.byteLength) return false;

  for (let index = 0; index < text.length; index += 1) {
    if (data[offset + index] !== text.charCodeAt(index)) return false;
  }

  return true;
}

function looksLikeHtml(data: Uint8Array): boolean {
  const head = data.subarray(0, 512);
  let text = '';

  for (const byte of head) {
    text += String.fromCharCode(byte);
  }

  return /^\s*(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(text.replace(/^\uFEFF/, ''));
}

/**
 * Best-effort extension detection from leading bytes. Returns `null` when the
 * format is not recognised.
 */
export function detectExtensionFromBytes(data: Uint8Array): string | null {
  if (data.byteLength === 0) return null;

  if (matchesBytes(data, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (matchesBytes(data, 0, [0xff, 0xd8, 0xff])) return 'jpg';
  if (matchesAscii(data, 0, 'GIF87a') || matchesAscii(data, 0, 'GIF89a')) return 'gif';
  if (matchesAscii(data, 0, 'RIFF') && matchesAscii(data, 8, 'WEBP')) return 'webp';
  if (matchesAscii(data, 0, 'RIFF') && matchesAscii(data, 8, 'WAVE')) return 'wav';
  if (matchesAscii(data, 0, 'RIFF') && matchesAscii(data, 8, 'AVI ')) return 'avi';
  if (matchesAscii(data, 0, '%PDF')) return 'pdf';
  if (matchesBytes(data, 0, [0x50, 0x4b, 0x03, 0x04]) || matchesBytes(data, 0, [0x50, 0x4b, 0x05, 0x06])) return 'zip';
  if (matchesBytes(data, 0, [0x1f, 0x8b])) return 'gz';
  if (matchesBytes(data, 0, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return '7z';
  if (matchesAscii(data, 0, 'Rar!\u001a\u0007')) return 'rar';
  if (matchesAscii(data, 4, 'ftyp')) return 'mp4';
  if (matchesBytes(data, 0, [0x1a, 0x45, 0xdf, 0xa3])) return 'webm';
  if (matchesAscii(data, 0, 'OggS')) return 'ogg';
  if (matchesAscii(data, 0, 'ID3') || matchesBytes(data, 0, [0xff, 0xfb]) || matchesBytes(data, 0, [0xff, 0xf3])) return 'mp3';
  if (matchesAscii(data, 0, 'fLaC')) return 'flac';
  if (matchesBytes(data, 0, [0x00, 0x61, 0x73, 0x6d])) return 'wasm';
  if (matchesBytes(data, 0, [0x00, 0x00, 0x01, 0x00])) return 'ico';
  if (looksLikeHtml(data)) return 'html';

  return null;
}
