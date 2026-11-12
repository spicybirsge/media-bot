export type SocialPlatform = 'YouTube' | 'Instagram' | 'X';

export interface SocialLink {
  readonly valid: true;
  readonly platform: SocialPlatform;
  /** Canonical individual-post URL, without tracking or playlist parameters. */
  readonly url: string;
}

export interface InvalidSocialLink {
  readonly valid: false;
  readonly reason: string;
}

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);
const X_HOSTS = new Set(['x.com', 'www.x.com', 'm.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']);
const INSTAGRAM_HOSTS = new Set(['instagram.com', 'www.instagram.com', 'm.instagram.com']);
const VIDEO_ID = /^[\w-]{11}$/;

export function validateSocialLink(raw: string): SocialLink | InvalidSocialLink {
  const invalid = (reason: string): InvalidSocialLink => ({ valid: false, reason });
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return invalid('Invalid URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.port) {
    return invalid('Invalid link: use a standard http(s) platform URL.');
  }

  const host = parsed.hostname.toLowerCase();
  if (YOUTUBE_HOSTS.has(host) || host === 'youtu.be' || host === 'www.youtu.be') {
    const id = host.endsWith('youtu.be')
      ? /^\/([\w-]+)\/?$/.exec(parsed.pathname)?.[1]
      : parsed.pathname === '/watch'
        ? parsed.searchParams.get('v')
        : /^\/(?:shorts|embed|live)\/([\w-]+)\/?$/.exec(parsed.pathname)?.[1];
    if (!id || !VIDEO_ID.test(id)) return invalid('YouTube link must point to an individual video.');
    return { valid: true, platform: 'YouTube', url: `https://www.youtube.com/watch?v=${id}` };
  }

  if (X_HOSTS.has(host)) {
    const post = /^\/(?:[\w]{1,50}\/status|i\/web\/status|i\/status)\/(\d{1,25})(?:\/(?:video|photo)\/\d+)?\/?$/.exec(parsed.pathname);
    if (!post) return invalid('X link must point to an individual post.');
    return { valid: true, platform: 'X', url: `https://x.com/i/status/${post[1]}` };
  }

  if (INSTAGRAM_HOSTS.has(host)) {
    const post = /^\/(p|reel|reels|tv)\/([\w-]{1,64})\/?$/.exec(parsed.pathname);
    if (!post) return invalid('Instagram link must point to a post or reel.');
    const kind = post[1] === 'reels' ? 'reel' : post[1];
    return { valid: true, platform: 'Instagram', url: `https://www.instagram.com/${kind}/${post[2]}/` };
  }

  return invalid('Invalid link. Supported platforms: YouTube, Instagram and X.');
}
