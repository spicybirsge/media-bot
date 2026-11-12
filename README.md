# media-bot

Personal Discord bot that archives attachments and links into Cloudflare R2
and posts the public links, with an optional separate channel for social videos.

## Behaviour

- The original archive watcher uses `DISCORD_CHANNEL_ID`. Any non-bot message with attachments or
  `http(s)` links is acknowledged with `uploading...`, every item is uploaded,
  and the public links are posted.
- The original message is never deleted or edited. If anything fails, the
  successful links plus the errors are posted and everything stays in place.
- `/upload` (owner only, ephemeral) takes exactly one of an attachment or a URL.
  Its queue wait, download and upload share a 12-minute deadline so a timeout
  can be reported before Discord's 15-minute interaction token expires. Use the
  archive channel for jobs that need the longer processing budgets.
- `/stats` is public and shows bot uptime, gateway ping, CPU load, process and
  system RAM, OS, CPU model, and runtime versions as a colour-coded embed.
- In the original archive channel and `/upload`, links are fetched as raw bytes. An HTML page is archived as its HTML source
  (`.html`), not rendered, and the stored object keeps the response
  `Content-Type`.
- Every R2 key is a bare 21-character nanoid, so links are short and
  unguessable. The content type and a `Content-Disposition` filename are stored
  on the object, so it still renders and saves with the real name. Public links
  always use `R2_PUBLIC_BASE_URL`.
- Files up to **1 GiB (1,073,741,824 bytes)** are supported in both archive
  channels and `/upload`. Downloads are staged on disk, and large uploads use
  multipart requests rather than loading the whole file into RAM. Discord's own
  attachment limits still apply; larger source files can be archived through URLs.

### Social video channel

Set `DISCORD_SOCIAL_ID` to a **different** channel ID to enable video archiving
from YouTube (watch links, Shorts and short links), Instagram (posts/reels), and
X/Twitter (individual posts). Leave it blank to disable the feature.

- Bot messages and messages without `http(s)` URLs are ignored, including
  attachment-only messages. Profiles, homepages, playlist-only links and other
  websites receive an invalid-link explanation.
- Supported post links are acknowledged with `uploading...` before being queued.
  Each available video is downloaded with yt-dlp, prepared as an MP4 with FFmpeg,
  inspected with ffprobe, and uploaded as its own R2 object with its own public URL.
  Photos are skipped. A photo-only, live or upcoming post returns a no-videos message.
- A mixed post can return multiple videos. Failures in one video or link do not
  discard successful uploads or stop later links. Results include individual R2
  URLs, the number of invalid input links skipped, posts without videos, and errors.
  Repeated canonical links are downloaded once per message; skip counts count
  distinct extracted input links, not carousel slides.
- A video missing an audio stream is rejected when source metadata indicates audio
  exists. Genuinely silent clips are allowed. This checks stream presence, not
  whether the audio is audible or every frame is decodable.
- Original messages are never edited or deleted. Discord replies use concise
  errors. The console confirms login and successful slash-command registration
  on startup. Per-link downloads, conversions and successful uploads are silent;
  failures include full yt-dlp/ffprobe output and validation/upload exceptions
  without redaction. Missing guild configuration is reported on startup.

## Requirements

- Node 22+ and pnpm 12 (see `packageManager` in `package.json`).
- A Discord application/bot with the **Message Content** intent enabled, and
  `View Channel`, `Send Messages`, and `Use Application Commands` in the
  archive channel.
- An R2 bucket with a public custom domain (or `r2.dev` URL) and an API token
  with **Object Read & Write** for that bucket. Server-side uploads do not need
  CORS.
- Writable temporary storage for downloads. Allow at least **4 GiB of free
  temporary disk space** for an active social post, plus space for any concurrent
  attachment/URL downloads in the original channel or `/upload`.
- **Social channel only:** install yt-dlp, FFmpeg and ffprobe on the bot host.
  FFmpeg must include the `libx264` and AAC encoders. These tools are optional
  when `DISCORD_SOCIAL_ID` is unset. See installation details below.

## Setup

```sh
cp .env.example .env   # fill in the values
pnpm install
pnpm register          # guild-scoped, so command changes appear immediately
pnpm dev               # or: pnpm build && pnpm start
```

If `DISCORD_GUILD_ID` is set, `/upload` is also registered automatically on
startup, so deploys pick up command changes without a manual step. Commands are
never registered globally.

### Social video prerequisites (development and production)

Install the official [yt-dlp](https://github.com/yt-dlp/yt-dlp#installation),
[FFmpeg and ffprobe](https://ffmpeg.org/download.html) on each host that runs the bot.
No npm downloader wrapper or static binary packages are used. Check availability
under the same user and environment as the bot:

```sh
yt-dlp --version
ffmpeg -version
ffprobe -version
```

For Windows, these WinGet packages provide yt-dlp and FFmpeg (including ffprobe):

```powershell
winget install --id yt-dlp.yt-dlp --exact
winget install --id Gyan.FFmpeg --exact
```

Open a new terminal after installation so PATH changes are picked up. On Linux
or macOS, use the official installation links above and ensure the service user
can execute all three commands. The Windows `yt-dlp.exe` and standalone Linux
executables bundle Python; the Unix `yt-dlp` zipapp and pip installations need a
supported Python version as specified by yt-dlp. The 1 GiB/multipart upload feature requires
**no additional npm packages or host programs** beyond the existing requirements.

For YouTube, install yt-dlp's [EJS challenge components](https://github.com/yt-dlp/yt-dlp/wiki/EJS).
The official release executables bundle EJS; Python installations should include
the `default` extra (for example, `python -m pip install -U "yt-dlp[default]"`).
The bot explicitly supplies its own Node executable as the JavaScript runtime.
Keep yt-dlp and FFmpeg updated for platform fixes and security patches.

If an executable is not on pm2's PATH, set `YT_DLP_PATH`, `FFMPEG_PATH` or
`FFPROBE_PATH` to its full executable path in the pm2 environment (`.env` in dev).
For example, `YT_DLP_PATH=C:/tools/yt-dlp.exe`. Set `FFMPEG_PATH` to FFmpeg's
executable, not the directory. The bot checks tool availability at startup when
the social channel is enabled; missing tools do not disable the original watcher.

Some Instagram/X posts require login or may be blocked or rate limited even when
public. Optionally set `SOCIAL_COOKIES_FILE` to an absolute path to a
Netscape-format cookie file. Treat cookies as credentials: keep the file outside
this repository, restrict access, and refresh it when it expires. The bot ignores
global yt-dlp config and plugins; configure cookies through this setting instead.
It does not download missing runtime components automatically.

On production, install these host tools, set `DISCORD_SOCIAL_ID` and any required
tool paths in pm2, then build and restart the bot with the updated environment.

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm dev` | Run from source with `tsx watch`. |
| `pnpm build` | Compile to `dist/`. |
| `pnpm start` | Run `dist/index.js` (used by pm2). |
| `pnpm register` | Register `/upload` from source. |
| `pnpm register:dist` | Register `/upload` from the build (prod). |
| `pnpm typecheck` | Type-check without emitting. |
| `pnpm test` | Run offline tests with fake Discord/R2 dependencies. |

For pm2, run `pnpm build` and point pm2 at `dist/index.js` with the environment
variables supplied by pm2; `.env` is dev-only.
Set `kill_timeout: 45000` in the app's PM2 ecosystem configuration so shutdown
has time to cancel work, abort incomplete multipart uploads and remove staged
files before PM2 forcefully terminates the process.

## Limits and failure handling

- `MAX_UPLOAD_BYTES` in `src/config.ts` is **1 GiB per file**, including input
  attachments, arbitrary URL downloads and final social MP4s. Declared sizes are
  checked before downloading; chunked/unknown-length responses are also counted
  while being written to disk. Oversized files fail without stopping other items.
- Raw URL/attachment downloads go directly to the host's temporary directory;
  only a small header is retained for content-type/extension detection. R2 reads
  staged files in **16 MiB parts** (`UPLOAD_PART_BYTES`). Files up to 16 MiB use
  one PUT; larger files use multipart uploads with part retries on HTTP 429/5xx. Multipart
  metadata preserves the original filename/content type and each completed file
  still has one nanoid key and one public link. Failed multipart uploads are
  aborted, including when an upload times out.
- Channel downloads and R2 uploads each time out after **30 minutes**; `/upload`
  has the shorter overall deadline described above. Non-2xx raw URL responses are reported by status
  and host/path — signed query strings are never echoed to chat or logs.
- R2 uploads share a serial queue across both channels and `/upload`, bounding
  part-buffer memory. Downloads and social jobs use disk, so a 1 GiB file does
  not require a 1 GiB application buffer.
- Social jobs have a separate serial queue across messages, covering download,
  validation, MP4 preparation and upload. Each input link has a **30-minute**
  download/merge timeout; each MP4 preparation has **30 minutes**, and each
  ffprobe check has 30 seconds.
- Each social post has a **4 GiB temporary storage budget**, including downloaded
  streams, source files and prepared MP4s. yt-dlp checks declared
  sizes, and a 500 ms disk monitor stops downloads with undeclared/excessive
  sizes (temporary usage may briefly overshoot). Final sizes are checked again
  before MP4 preparation and upload. Large posts can fail partially at these limits.
- Temporary files are removed after uploads succeed or fail; incomplete raw
  downloads are also cleaned up. The host temp directory is controlled by `TEMP`
  on Windows or `TMPDIR` on Unix-like systems. Timed-out subprocess trees
  are stopped before cleanup. SIGINT/SIGTERM cancel active and queued archive
  jobs, stop social subprocesses and wait for multipart/local cleanup before exit.
- Social videos are uploaded as real MP4 files with `video/mp4` content type,
  H.264 8-bit video and AAC audio (or no audio for silent clips). Compatible
  streams are copied without quality loss; other codecs/pixel formats are
  converted only when needed, padding odd dimensions to even sizes for H.264.
  MP4 metadata is placed before the media data
  (`faststart`) for progressive playback. Existing R2 objects are unchanged;
  resend a source link to archive a new MP4 version.

## Testing

`pnpm test` uses Node's test runner with the existing tsx dependency. Tests cover
URL validation/extraction, filename and R2 key rules, owner gating, Discord reply
order, mixed results, silent/missing-audio handling, queue recovery, subprocess
timeouts/size limits, exact 1 GiB boundaries, bounded multipart uploads/retries/
abort cleanup, disk-backed downloads, graceful shutdown, slash-command deadlines,
mixed-link error positions and temporary-file cleanup. The boundary
tests temporarily create/read 1 GiB files, so allow sufficient disk space.
No Discord login or live R2
request is made; tests override environment credentials with fake values.

To also run the optional offline test using the actual host tools, set
`TEST_YT_DLP_PATH` to the yt-dlp executable path before `pnpm test` (PowerShell:
`$env:TEST_YT_DLP_PATH = 'C:/tools/yt-dlp.exe'`). It generates tiny local media,
downloads/merges it through yt-dlp, and inspects the result with ffprobe. Optional
`TEST_FFMPEG_PATH` and `TEST_FFPROBE_PATH` override the host tool paths in this test.
