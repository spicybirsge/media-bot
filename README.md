# media-bot

Personal Discord bot that archives attachments and links from one private
channel into Cloudflare R2, then replaces the message with public links.

## Behaviour

- Watches `DISCORD_CHANNEL_ID` only. Any non-bot message with attachments or
  `http(s)` links is acknowledged with `upload...`, every item is uploaded, the
  public links are posted, and the original message is deleted.
- **Delete safety:** the original is deleted only when every item uploaded. If
  anything fails, the original stays and the successful links plus the errors
  are posted.
- `/upload` (owner only, ephemeral) takes exactly one of an attachment or a URL.
- Links are fetched as raw bytes. An HTML page is archived as its HTML source
  (`.html`), not rendered, and the stored object keeps the response
  `Content-Type`.
- Filenames are sanitized and every R2 key is `<nanoid>_<filename>`, so links
  are unguessable. Public links always use `R2_PUBLIC_BASE_URL`.

## Requirements

- Node 22+ and pnpm 12 (see `packageManager` in `package.json`).
- A Discord application/bot with the **Message Content** intent enabled, and
  `View Channel`, `Send Messages`, `Manage Messages`, and
  `Use Application Commands` in the archive channel. The bot needs Manage
  Messages to delete the originals.
- An R2 bucket with a public custom domain (or `r2.dev` URL) and an API token
  with **Object Read & Write** for that bucket. Server-side uploads do not need
  CORS.

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

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm dev` | Run from source with `tsx watch`. |
| `pnpm build` | Compile to `dist/`. |
| `pnpm start` | Run `dist/index.js` (used by pm2). |
| `pnpm register` | Register `/upload` from source. |
| `pnpm register:dist` | Register `/upload` from the build (prod). |
| `pnpm typecheck` | Type-check without emitting. |

For pm2, run `pnpm build` and point pm2 at `dist/index.js` with the environment
variables supplied by pm2; `.env` is dev-only.

## Limits and failure handling

- Each file is buffered in memory before upload. `MAX_BUFFER_BYTES` in
  `src/config.ts` is a 256 MiB heap guard (higher than any Discord attachment
  cap); raise it if a huge link must be archived. Failures are reported in the
  channel instead of crashing the bot.
- Fetches time out after 5 minutes and non-2xx responses are reported by status
  and host/path — signed query strings are never echoed to chat or logs.
- Uploads are processed one at a time in message order.
