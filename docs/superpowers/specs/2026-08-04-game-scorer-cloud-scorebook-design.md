# Game Scorer Cloud Scorebook

**Date:** 2026-08-04
**Status:** Design draft for review

## Summary

Game Scorer will move from a device-local score keeper to one shared, public scorebook backed by Supabase Postgres. There will be no accounts, passwords, invitations, or ownership model in the first version. People are shared records such as `John` and `Caitlin`, not verified identities or profiles.

Anyone can view, create, update, and delete the shared data. The app will remain usable when temporarily offline by keeping a local cache and a queue of pending mutations, but the cloud database is the source of truth whenever a connection is available.

## Goals

- Make games and people available from any phone or computer.
- Track one person across games using a stable internal person ID.
- Let the scorekeeper find an existing person before creating a new one.
- Add a searchable People directory, person history pages, and a shared leaderboard.
- Show understandable overall and per-game statistics.
- Preserve the current scoring flows and game-specific rules.
- Preserve local backup/export and tolerate temporary network loss.
- Start on Supabase's Free plan with no paid infrastructure required.

## Non-goals

- User accounts, passwords, passwordless sign-in, or profile ownership.
- Private profiles or per-person access control.
- Separate family/team scorebooks in the first version.
- Real-time cursors, presence, chat, or multiplayer scoring from multiple screens at once.
- A server-side rewrite of every game evaluator during the initial migration.

The shared dataset is intentionally public. Names and game history should be treated as world-readable scorebook data, not private personal data.

## User experience

### Navigation

The app gains four top-level destinations:

- **Home** — start a game and browse recent in-progress and finished games.
- **People** — search the shared directory and open a person page.
- **Leaderboard** — rank people across finished games.
- **Games** — browse the complete shared game history.

Selecting a person from People opens a normal subpage such as `/people/<person-id>`, with a back action to People. A real page is preferred over a modal because it supports full history, deep links, browser back navigation, and future sharing.

### Adding a player

The New Game flow keeps the current player-picker shape but reads from the cloud-backed People directory:

1. Search by name.
2. Show matching people with useful context such as game count and wins.
3. Select an existing person when appropriate.
4. Offer `Create new person` as an explicit separate action.

The app must never silently merge two similarly named people. If duplicates happen, the group can use a more descriptive display name such as `John S.` or `John - Dad's side`. A later version may offer a deliberate merge tool.

### Person page

Each person page contains:

- Overall games played, wins, win rate, and average finish.
- Wins and win rate broken down by game type.
- Recent games involving the person.
- Game-specific metrics where they are meaningful.
- Fun stats such as longest win streak, most-played teammate, favorite game, best finish, and average finish.

Only finished games contribute to wins, win rate, streaks, average finish, and leaderboard placement. In-progress games remain visible in history but do not affect those metrics.

A win is a final rank of 1. Tied first-place players are displayed as tied winners and each receive a win for statistics. Raw scores are never compared across game types; Farkle, Dutch Blitz, and 3-13 each display their own meaningful score metrics.

### Destructive actions

- Deleting a round or game requires confirmation when the action can remove substantial history.
- The UI shows an immediate Undo action after deletion.
- A deleted record is soft-deleted in the cloud with a tombstone so the deletion can sync across devices and Undo can restore it.
- A person with historical games is archived from the add-player picker rather than physically removed, preserving historical references.

## Data model

The current application stores a whole game as one JSON object. The cloud model preserves the same game-specific payload while separating records that need independent sync.

### `people`

- `id text primary key` — preserve the app's existing opaque IDs such as `p_...`.
- `name text not null`.
- `normalized_name text not null` — lowercase/trimmed lookup value.
- `created_at timestamptz not null`.
- `updated_at timestamptz not null`.
- `deleted_at timestamptz null` — archive/tombstone marker.

### `games`

- `id text primary key` — preserve existing `g_...` IDs.
- `game_id text not null` — `farkle`, `dutch-blitz`, or `three-thirteen`.
- `created_at timestamptz not null`.
- `updated_at timestamptz not null`.
- `finished_at timestamptz null`.
- `settings jsonb not null`.
- `deleted_at timestamptz null`.

### `game_players`

- `game_id text not null references games(id)`.
- `person_id text not null references people(id)`.
- `seat_order integer not null`.
- `name_snapshot text not null` — fallback display name from the time the game was created.
- `updated_at timestamptz not null`.
- `deleted_at timestamptz null` — membership tombstone for sync and re-addition.
- Primary key: `(game_id, person_id)`.

### `rounds`

- `id text primary key` — preserve existing `r_...` IDs.
- `game_id text not null references games(id)`.
- `round_index integer not null`.
- `entries jsonb not null` — game-specific entry payload currently consumed by the existing evaluators.
- `updated_at timestamptz not null`.
- `deleted_at timestamptz null`.

This keeps game-specific scoring data flexible while making games, participants, and rounds independently syncable. The existing JavaScript `evaluate()` implementations remain authoritative for the first cloud version; database views or precomputed stats can be added later if the dataset grows.

## Cloud and local data flow

```text
React app
  ├─ local cache: immediate rendering and offline reads
  ├─ outbox: queued offline mutations
  └─ Supabase Data API
       └─ Postgres source of truth
```

### Startup and refresh

1. Load the most recent local cache immediately.
2. Render the cached app state so navigation remains responsive.
3. Request remote rows newer than the last successful sync, plus any records needed to repair a stale cache.
4. Merge remote rows into the cache, respecting tombstones.
5. Replay pending local mutations when online.
6. Save the reconciled result back to the local cache.

The app refreshes on startup, when returning to the foreground, after a successful mutation, and when the browser reports that connectivity returned. Real-time subscriptions are not required for the first version.

### Mutations and retries

Every local mutation receives a unique client mutation ID and is either:

- sent to Supabase immediately when online, or
- stored in an outbox when offline.

Successful mutations update the cache from the server response. Failed mutations remain in the outbox, show a pending-sync indicator, and retry with bounded backoff. Replaying the same mutation must be idempotent.

Independent rows merge naturally: editing one round does not replace another round. If two devices edit the same row, the server's latest `updated_at` value wins and the losing device refreshes that row with a visible conflict notice. This is acceptable for the small trusted group and avoids silently pretending that simultaneous edits were merged.

## Supabase hosting

Supabase is the initial hosting choice because the current app is a static Vite/PWA deployment and Supabase provides managed Postgres plus a generated Data API. The Free plan is sufficient for the expected dataset. The frontend uses only the public publishable/anonymous key; privileged service keys never ship to the browser.

Row Level Security remains enabled on every exposed table. Policies intentionally allow the anonymous role to select, insert, update, and delete the scorebook rows. Database constraints, foreign keys, length limits, and timestamp triggers protect data shape; they are integrity controls, not user permissions.

The app will use environment-provided values for the Supabase URL and public key. The project SQL schema and migrations will live in the repository so the database is reproducible.

Free-plan caveats are documented in the app's data/backup UI:

- Supabase may pause a low-activity Free project.
- Free projects do not provide automatic downloadable database backups.
- The existing JSON backup remains important, and a cloud export should be added after the first sync migration.

## First-run migration

Existing users have games and roster entries in `localStorage`. On the first cloud-enabled build:

1. Load and migrate the local state using the existing game migration logic.
2. Detect whether local records exist and whether the cloud already contains those IDs.
3. Show a one-time migration summary such as `Publish 12 games and 6 people to the shared scorebook?`.
4. Upload people, games, participants, and rounds using their existing opaque IDs.
5. Skip IDs already present in the cloud rather than duplicating them.
6. Keep the local JSON cache and export path intact.

A user with no local data simply downloads the shared scorebook. A user can still import an old JSON backup; imported records follow the same deduplication and sync path.

## Error handling

- No network: show cached data and an unobtrusive `Offline`/`Pending sync` indicator.
- Mutation failure: retain the outbox item and provide retry status rather than discarding the user's score.
- Stale or conflicting edit: refresh the affected row and explain that another device changed it.
- Invalid remote data: ignore the invalid record for rendering, log a diagnostic, and keep the rest of the scorebook usable.
- Delete: confirm, soft-delete, show Undo, and sync the tombstone.
- Supabase project unavailable or paused: keep local data available and show a clear recovery message.

## Validation and acceptance criteria

- Two devices load the same people and games from the shared database.
- A person selected on one device appears in that person's history on another device.
- A new game created on one device appears in Games and affects completed-game stats after refresh.
- Editing a round updates the shared game without replacing unrelated rounds.
- A game created while offline appears locally, shows as pending, and reaches Supabase after reconnecting.
- Deleting a game requires confirmation, can be undone immediately, and syncs across devices.
- Existing local games can be published without duplicate IDs.
- Person stats match the existing game evaluators for Farkle, Dutch Blitz, and 3-13.
- In-progress games do not affect wins, win rate, streaks, or leaderboard placement.
- Exporting a cloud snapshot produces a backup that can be imported into a fresh device.

## Future extensions

- Deliberate person merge flow for accidental duplicate names.
- Realtime refresh for live scoreboard updates.
- Separate scorebooks or family groups.
- Optional account linkage if a future need for private or cross-scorebook identity appears.
- Server-side stats views/materialized aggregates if the shared dataset becomes large.
