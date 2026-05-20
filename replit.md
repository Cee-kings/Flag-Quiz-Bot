# Flag Quiz Discord Bot

A Discord bot for a Guess the Country Flag quiz game. Players type country names to answer flag emoji prompts. Speed counts — faster answers earn more points.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server + Discord bot (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required secret: `DISCORD_BOT_TOKEN` — Discord bot token

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- Bot: discord.js v14
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/bot/` — all Discord bot code
  - `index.ts` — bot entry point, command routing, intent setup
  - `game.ts` — round/challenge state machines, scoring logic
  - `flags.ts` — flag data (196 countries), answer normalization, alias matching
  - `db.ts` — DB helpers (upsert player, add win, leaderboard query)
- `lib/db/src/schema/flagQuiz.ts` — `flag_quiz_players` table schema
- `lib/db/src/schema/index.ts` — schema barrel export

## Architecture decisions

- Bot runs in-process alongside the Express server — `startBot()` is called from `src/index.ts` after the HTTP server starts.
- Game state (active rounds, challenge sessions) is kept in-memory Maps keyed by channel ID — no DB needed for live round state.
- Speed scoring: 100 pts at t=0, decaying linearly to 10 pts at t=15s.
- Challenge mode runs 20 shuffled flags sequentially; scores are flushed to DB only at the end of the full challenge.
- Alias matching uses normalized lowercase string comparison — strips punctuation, handles common alternate country names.

## Product

**Commands:**
- `!flag` — start a single flag quiz round (15 second timeout)
- `!challenge` — run 20 flags in a row with speed scoring and final standings
- `!leaderboard` — show top 10 players by total score
- `!score` — show your personal stats (score, wins, rounds, win rate)
- `!endflag` — mod-only: stop the current round or challenge

**Mod roles (can use !endflag):** Moderator, Host, Co-Host, Staff

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- **Message Content Intent** must be enabled in Discord Developer Portal → Bot → Privileged Gateway Intents. Without it the bot cannot read messages and will fail to connect.
- **Server Members Intent** must also be enabled for role-based mod checking (`!endflag`).
- Run `pnpm run typecheck:libs` before `pnpm --filter @workspace/api-server run typecheck` after changing `lib/db` schema, or the new exports won't be visible to the API server's TS checker.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
