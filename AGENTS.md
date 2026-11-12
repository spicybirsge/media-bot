# AGENTS.md

## Repo status

- Implemented: channel watcher, owner-only `/upload` (auto-registered on startup when `DISCORD_GUILD_ID` is set, plus `pnpm register`), public `/stats`, and R2 uploads via `aws4fetch` + `nanoid`. Pure helpers live in `src/lib/`.
- Optional social video watcher: `DISCORD_SOCIAL_ID`, with host yt-dlp/FFmpeg/ffprobe (no npm wrappers).
- Console logging confirms login and successful slash-command registration at startup (and warns when guild registration is unconfigured). Per-link downloads, conversions and successful uploads are silent. Preserve full diagnostics on actual failures; ordinary tool warnings on successful jobs are silent.
- Uploads are capped at 1 GiB per file. Download attachments/URLs to disk; upload staged files with sequential 16 MiB multipart requests above 16 MiB, and abort incomplete multipart uploads on failure. All R2 uploads share a serial queue to bound memory.
- Archive jobs are tracked by `archiveLifecycle`; SIGINT/SIGTERM cancel queued/active work and await process, multipart and temporary-file cleanup before exiting. PM2 should allow a 45-second kill timeout.
- Stack: TypeScript + discord.js, Cloudflare R2 via its S3-compatible API.
- Package manager is pnpm (see `packageManager` in `package.json`). Do not add npm/yarn lockfiles.
- Scripts: `pnpm dev` (tsx watch), `pnpm build` (tsc to `dist/`), `pnpm start` (runs `dist/index.js`, used by pm2), `pnpm typecheck`.
- Prod runs from `dist/` under pm2 with env vars supplied by pm2; `.env` is dev-only and git-ignored.
- `pnpm-workspace.yaml` holds pnpm settings (`allowBuilds` for esbuild); pnpm 12 no longer reads the `pnpm` field in `package.json`.

## Product contract

Personal Discord bot that archives files and links from one private channel into R2.

### Channel watcher

- Watch only `DISCORD_CHANNEL_ID`.
- On any non-bot message containing attachment(s) or `http(s)` link(s): reply `uploading...` immediately, upload each attachment and fetched link, then post the resulting public link(s). The original message is never deleted or edited.
- Order matters: ack -> upload -> post links. On failure, post the successful links and the errors; nothing is deleted.
- Needs the Message Content intent (otherwise `message.content` is empty).

### Social video watcher

- `DISCORD_SOCIAL_ID` is optional and must differ from `DISCORD_CHANNEL_ID`.
- Ignore bots and messages without URLs. Validate individual YouTube, Instagram and X video/post URLs; reject other sites and profile/home/playlist-only links.
- Ack before downloading. Serialize social jobs, download all available videos per post, skip photos, inspect expected audio, and upload each video separately with existing R2 naming rules.
- Final social uploads must be MP4 (`video/mp4`) with H.264/yuv420p video and AAC audio when present. Remux compatible streams with faststart; transcode only incompatible streams and validate the finished MP4 before upload.
- Preserve partial successes and report invalid-link counts, no-video posts, and download/upload errors. Keep raw downloader diagnostics out of Discord replies; console diagnostics are unredacted per the owner's explicit preference.
- Use host executables via argument arrays with no shell. Optional `YT_DLP_PATH`, `FFMPEG_PATH`, `FFPROBE_PATH` and `SOCIAL_COOKIES_FILE` configure full executable/cookie paths.
- Enforce the 1 GiB per-file limit, a 4 GiB temporary budget per social post, 30-minute download/MP4/upload timeouts and 30-second probes; remove temporary files after each job.

### Owner slash command

- Accepts one attachment or one `http(s)` URL, uploads it to R2, returns the public link.
- Restrict to `OWNER_ID` with an explicit user-ID check in code. `setDefaultMemberPermissions` alone is not enough because server admins bypass it.
- Enforce a 12-minute overall deadline, including queue wait, so an ephemeral timeout/error can be delivered before Discord's 15-minute interaction token expiry. Channel jobs keep their longer budgets.
- Register guild-scoped so command updates appear immediately.

### Public slash command

- `/stats` is available to any member of the guild (no owner check) and reports read-only host/runtime stats: bot and host uptime, gateway ping, CPU load, process/system RAM, OS, CPU model, and Node/discord.js versions.
- Never expose env values, tokens, signed URLs, or other secrets in it.

## R2 object naming

- Key format: the bare `${nanoid}` (21 characters), e.g. `V1StGXR8_Z5jdHi6B-myT`. Filenames are not part of keys, so links stay short.
- Never key objects by original filename alone; links must be unguessable.
- Filenames are only used for logs, content type/extension, and object metadata; sanitize them (strip directory separators / path traversal, control characters, and characters unsafe in URLs; cap length) before using them.
- Store the sanitized name as `Content-Disposition: inline; filename=...` so downloads keep a sensible name even though keys are bare nanoids.
- Public links must use `R2_PUBLIC_BASE_URL`; never return the S3 API endpoint or presigned URLs.
- Discord attachment URLs are signed and expire, so fetch them immediately.

## Env contract

Use these exact names:

```
DISCORD_TOKEN
DISCORD_CHANNEL_ID
OWNER_ID
R2_ACCOUNT_ID
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_BUCKET
R2_PUBLIC_BASE_URL
```

Optional: `DISCORD_GUILD_ID` for guild-scoped command registration.

- Commit `.env.example`, never `.env`. Do not deliberately log env credentials. Exception requested by the owner: social download failures and upload exceptions are logged in full to the console without redaction, including any URLs in those diagnostics; Discord replies still use concise messages.

## Guardrails

- Ignore messages from bots, including the bot's own ack and link posts, to avoid upload loops.
- Accept only `http:` / `https:` for URL fetching; never local paths or other schemes.
- Enforce a maximum download/upload size (Discord attachment caps and arbitrary URL sizes differ).
- A message may contain multiple links/attachments; process all of them and do not abort remaining uploads when one fails.

## Intended layout

- `src/index.ts` - client entrypoint and event wiring
- `src/config.ts` - env parsing/validation
- `src/r2.ts` - upload helper
- `src/messageHandler.ts` - channel watcher flow
- `src/commands/` + `src/registerCommands.ts` - slash command and registration

Keep key building, filename sanitization, and URL extraction as pure functions so they can be tested without Discord or R2.

## Testing

`pnpm test` runs Node tests through tsx with fake environment credentials. Cover key/filename sanitization, link extraction/validation, owner gating, social partial results, audio checks, queues, subprocess limits and cleanup. Tests must not require live Discord or R2 access.
