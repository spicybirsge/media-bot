# AGENTS.md

## Repo status

- Implemented: channel watcher, owner-only `/upload` (auto-registered on startup when `DISCORD_GUILD_ID` is set, plus `pnpm register`), and R2 uploads via `aws4fetch` + `nanoid`. Pure helpers live in `src/lib/`.
- Stack: TypeScript + discord.js, Cloudflare R2 via its S3-compatible API.
- Package manager is pnpm (see `packageManager` in `package.json`). Do not add npm/yarn lockfiles.
- Scripts: `pnpm dev` (tsx watch), `pnpm build` (tsc to `dist/`), `pnpm start` (runs `dist/index.js`, used by pm2), `pnpm typecheck`.
- Prod runs from `dist/` under pm2 with env vars supplied by pm2; `.env` is dev-only and git-ignored.
- `pnpm-workspace.yaml` holds pnpm settings (`allowBuilds` for esbuild); pnpm 12 no longer reads the `pnpm` field in `package.json`.

## Product contract

Personal Discord bot that archives files and links from one private channel into R2.

### Channel watcher

- Watch only `DISCORD_CHANNEL_ID`.
- On any non-bot message containing attachment(s) or `http(s)` link(s): reply `upload...` immediately, upload each attachment and fetched link, post the resulting public link(s), then delete the original message.
- Order matters: ack -> upload -> post links -> delete. Never delete before upload succeeds; on failure leave the original message and surface the error.
- Needs the Message Content intent (otherwise `message.content` is empty) and Manage Messages.

### Owner slash command

- Accepts one attachment or one `http(s)` URL, uploads it to R2, returns the public link.
- Restrict to `OWNER_ID` with an explicit user-ID check in code. `setDefaultMemberPermissions` alone is not enough because server admins bypass it.
- Register guild-scoped so command updates appear immediately.

## R2 object naming

- Key format: `${nanoid}_${sanitizedFilename}` with the extension preserved, e.g. `V1StGXR8_Z5jdHi6B-myT_clip.mp4`.
- Never key objects by original filename alone; links must be unguessable.
- Sanitize filenames: strip directory separators / path traversal, control characters, and characters unsafe in URLs; cap length. If there is no filename (plain URL), derive one from the URL path, else from content type; keep the extension.
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

- Commit `.env.example`, never `.env`. Do not log tokens, keys, or signed URLs.

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

No test setup yet. When added, cover key/filename sanitization, link extraction, and owner gating with mocks; unit tests should not require live Discord or R2 access.
