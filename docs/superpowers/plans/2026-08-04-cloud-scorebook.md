# Cloud Scorebook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Game Scorer to a public Supabase-backed scorebook with stable people, shared history, stats, local caching, offline mutation replay, and no user accounts.

**Architecture:** Keep the current nested client state shape so the existing game evaluators and scoring screens remain usable. Add a normalized Supabase schema and pure adapters that convert between nested local state and remote rows. The cloud is authoritative when online; localStorage holds the last cache plus an idempotent outbox for offline mutations. Use the Supabase Data API from the browser with explicit public RLS policies; no privileged key or custom backend is needed.

**Tech Stack:** React 19, Vite, browser `localStorage`, `@supabase/supabase-js`, Supabase CLI migrations, Node's built-in `node:test`, GitHub Pages Actions.

---

## File map

Create or modify only these focused units:

- `supabase/migrations/20260804000100_create_scorebook.sql` — tables, constraints, timestamps, grants, and public RLS policies.
- `.env.example` — names of the two public Vite build variables, with no secrets.
- `package.json`, `package-lock.json` — Supabase client, pinned CLI, and test script.
- `src/lib/supabase.js` — one configured Supabase client and environment validation.
- `src/lib/cloudApi.js` — remote row reads, upserts, and tombstones; no React state.
- `src/lib/cloudState.js` — conversion between the current nested app state and normalized remote rows.
- `src/lib/sync.js` — cache metadata, outbox persistence, idempotent mutation replay, and merge policy.
- `src/lib/stats.js` — pure person/leaderboard calculations using existing `evaluate()` output.
- `src/lib/router.js` — minimal History API routing for People, person pages, Leaderboard, Games, and game screens.
- `src/lib/useCloudSync.js` — React lifecycle bridge for initial hydration, foreground refresh, online events, and retries.
- `src/components/SyncStatus.jsx` — offline, pending, syncing, and error state.
- `src/components/People.jsx` — searchable shared People directory.
- `src/components/PersonPage.jsx` — person stats and game history.
- `src/components/Leaderboard.jsx` — shared leaderboard.
- `src/components/Games.jsx` — complete shared game history.
- `src/components/MigrationPanel.jsx` — one-time local-to-cloud publish confirmation and result.
- `src/App.jsx`, `src/components/Home.jsx`, `src/components/NewGame.jsx`, `src/components/GameView.jsx`, `src/components/DataPanel.jsx` — integrate cloud state, routes, People selection, migration, and destructive-action UX.
- `src/styles.css` — navigation, directory, stats, sync, and confirmation styles.
- `tests/cloudState.test.js`, `tests/sync.test.js`, `tests/stats.test.js` — pure data and calculation coverage.
- `tests/smoke.test.js` — keeps the test command green while the pure modules are introduced.
- `.github/workflows/deploy.yml` — inject public Supabase build variables into the GitHub Pages build.
- `README.md` — local setup, Supabase variables, migration, backup, and sync behavior.

The generated `supabase/config.toml` and `supabase/.gitignore` already exist in the repository. Keep `.temp/` ignored and never commit database passwords, access tokens, or service keys.

---

### Task 1: Pin Supabase tooling and create the database schema

**Files:**
- Modify: `package.json`, `package-lock.json`
- Create: `.env.example`
- Create: `supabase/migrations/20260804000100_create_scorebook.sql`
- Test: remote migration dry run and local SQL lint

- [ ] **Step 1: Add the client, CLI, and test script**

Run from `/home/braden/PersonalWorkspace/game-scorer`:

```bash
npm install @supabase/supabase-js
npm install --save-dev supabase
npm pkg set scripts.test="node --test tests/*.test.js"
```

Expected: `package.json` contains `@supabase/supabase-js` under dependencies, `supabase` under devDependencies, and `npm test` invokes Node's test runner over explicit test files.

- [ ] **Step 2: Add environment names without values**

Create `.env.example` with exactly:

```dotenv
VITE_SUPABASE_URL=
VITE_SUPABASE_PUBLISHABLE_KEY=
```

Do not create a committed `.env` file. The public key is intended for the browser, but keeping the actual deployment values in local/GitHub configuration avoids accidentally coupling them to source.

- [ ] **Step 3: Write the first migration**

Create `supabase/migrations/20260804000100_create_scorebook.sql`:

```sql
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.people (
  id text primary key,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  normalized_name text not null check (char_length(normalized_name) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index people_name_search_idx
  on public.people (normalized_name)
  where deleted_at is null;

create table public.games (
  id text primary key,
  game_id text not null check (game_id in ('farkle', 'dutch-blitz', 'three-thirteen')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  settings jsonb not null default '{}'::jsonb,
  deleted_at timestamptz
);

create index games_updated_idx on public.games (updated_at);
create index games_finished_idx on public.games (finished_at) where deleted_at is null;

create table public.game_players (
  game_id text not null references public.games(id) on delete restrict,
  person_id text not null references public.people(id) on delete restrict,
  seat_order integer not null check (seat_order >= 0),
  name_snapshot text not null check (char_length(btrim(name_snapshot)) between 1 and 80),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (game_id, person_id)
);

create index game_players_person_idx on public.game_players (person_id);

create table public.rounds (
  id text primary key,
  game_id text not null references public.games(id) on delete restrict,
  round_index integer not null check (round_index >= 0),
  entries jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (game_id, round_index)
);

create trigger people_set_updated_at
before update on public.people
for each row execute function public.set_updated_at();

create trigger game_players_set_updated_at
before update on public.game_players
for each row execute function public.set_updated_at();

create trigger games_set_updated_at
before update on public.games
for each row execute function public.set_updated_at();

create trigger rounds_set_updated_at
before update on public.rounds
for each row execute function public.set_updated_at();

grant select, insert, update, delete on public.people to anon, authenticated;
grant select, insert, update, delete on public.games to anon, authenticated;
grant select, insert, update, delete on public.game_players to anon, authenticated;
grant select, insert, update, delete on public.rounds to anon, authenticated;

alter table public.people enable row level security;
alter table public.games enable row level security;
alter table public.game_players enable row level security;
alter table public.rounds enable row level security;

create policy people_public_select on public.people for select to anon, authenticated using (true);
create policy people_public_insert on public.people for insert to anon, authenticated with check (true);
create policy people_public_update on public.people for update to anon, authenticated using (true) with check (true);
create policy people_public_delete on public.people for delete to anon, authenticated using (true);

create policy games_public_select on public.games for select to anon, authenticated using (true);
create policy games_public_insert on public.games for insert to anon, authenticated with check (true);
create policy games_public_update on public.games for update to anon, authenticated using (true) with check (true);
create policy games_public_delete on public.games for delete to anon, authenticated using (true);

create policy game_players_public_select on public.game_players for select to anon, authenticated using (true);
create policy game_players_public_insert on public.game_players for insert to anon, authenticated with check (true);
create policy game_players_public_update on public.game_players for update to anon, authenticated using (true) with check (true);
create policy game_players_public_delete on public.game_players for delete to anon, authenticated using (true);

create policy rounds_public_select on public.rounds for select to anon, authenticated using (true);
create policy rounds_public_insert on public.rounds for insert to anon, authenticated with check (true);
create policy rounds_public_update on public.rounds for update to anon, authenticated using (true) with check (true);
create policy rounds_public_delete on public.rounds for delete to anon, authenticated using (true);
```

- [ ] **Step 4: Validate the migration before applying it**

Run:

```bash
npx supabase db lint --linked
npx supabase db push --linked --dry-run
```

Expected: lint reports no SQL errors and the dry run lists exactly one new migration. Do not run `db push` until the migration has passed review.

- [ ] **Step 5: Commit the schema foundation**

```bash
git add package.json package-lock.json .env.example supabase tests/smoke.test.js
git commit -m "Add Supabase scorebook schema"
```

### Task 2: Add pure remote-state conversion and cache primitives

**Files:**
- Create: `src/lib/cloudState.js`
- Create: `src/lib/sync.js`
- Modify: `src/lib/storage.js`
- Create: `tests/cloudState.test.js`, `tests/sync.test.js`

- [ ] **Step 1: Write failing conversion tests**

Cover these exact behaviors in `tests/cloudState.test.js`:

```js
import test from 'node:test'
import assert from 'node:assert/strict'
import { toRemoteRows, fromRemoteRows } from '../src/lib/cloudState.js'

test('converts a nested game into people, game, join, and round rows', () => {
  const state = {
    roster: [{ id: 'p_john', name: 'John' }],
    games: [{
      id: 'g_one', gameId: 'farkle', createdAt: 100, updatedAt: 200,
      players: [{ id: 'p_john', name: 'John' }], settings: { target: 10000 },
      rounds: [{ id: 'r_one', entries: { p_john: { score: 500 } } }], finishedAt: null,
    }],
  }

  const rows = toRemoteRows(state)
  assert.deepEqual(rows.people[0], {
    id: 'p_john', name: 'John', normalized_name: 'john',
    created_at: '1970-01-01T00:00:00.100Z',
    updated_at: '1970-01-01T00:00:00.200Z', deleted_at: null,
  })
  assert.equal(rows.games[0].id, 'g_one')
  assert.equal(rows.gamePlayers[0].person_id, 'p_john')
  assert.deepEqual(rows.rounds[0].entries, { p_john: { score: 500 } })
})

test('reconstructs current app state and preserves activeGameId locally', () => {
  const state = fromRemoteRows({ people: [], games: [], gamePlayers: [], rounds: [] }, 'g_local')
  assert.deepEqual(state, { games: [], roster: [], activeGameId: 'g_local' })
})
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run `node --test tests/cloudState.test.js`. Expected: FAIL because `cloudState.js` does not exist yet.

- [ ] **Step 3: Implement `cloudState.js`**

Export these functions:

```js
export function normalizeName(name) {
  return name.trim().toLocaleLowerCase()
}

export function toRemoteRows(state) {
  // Return { people, games, gamePlayers, rounds } using the exact SQL column names.
}

export function fromRemoteRows({ people, games, gamePlayers, rounds }, activeGameId = null) {
  // Rebuild the existing { games, roster, activeGameId } shape.
}
```

Use client IDs unchanged, convert millisecond timestamps to ISO strings on upload for the SQL `timestamptz` columns, convert them back to milliseconds on download, resolve current person names through `people`, and keep a game's `name_snapshot` as fallback. Keep remote tombstones in non-visible conversion metadata and preserve child-row versions so the merge step can reconcile deletions and independent game-player/round edits.

- [ ] **Step 4: Write failing outbox tests**

Cover: enqueueing a mutation, removing it after success, retaining it after failure, and ignoring a duplicate mutation ID. The test fixture must use a memory storage object implementing `getItem`, `setItem`, and `removeItem` so the tests do not touch browser globals.

- [ ] **Step 5: Implement `sync.js` and extend storage**

Export:

```js
export function loadSyncStore(storage = window.localStorage) {}
export function saveSyncStore(store, storage = window.localStorage) {}
export function enqueueMutation(store, mutation) {}
export function removeMutation(store, mutationId) {}
export function mergeRemoteState(localState, remoteState, lastSyncAt) {}
```

Use a separate `gamescorer.cloud.v1` storage key containing `{ cache, outbox, lastSyncAt, lastError, initialMigrationCompleted }`. Keep `gamescorer.v1` readable for legacy backup import and migration. A mutation has `{ id, entity, entityId, operation, payload, createdAt }`. Merge remote rows by entity ID; newer `updatedAt` wins, and a remote `deletedAt` tombstone wins over an older live cache record. Compare child rows using their own versions, falling back to the parent game version only when a child timestamp is missing.

- [ ] **Step 6: Run focused tests and commit**

Run `node --test tests/cloudState.test.js tests/sync.test.js`. Expected: PASS.

```bash
git add src/lib/cloudState.js src/lib/sync.js src/lib/storage.js tests/cloudState.test.js tests/sync.test.js
git commit -m "Add cloud state mapping and sync outbox"
```

### Task 3: Add the Supabase API adapter and initial cloud hook

**Files:**
- Create: `src/lib/supabase.js`
- Create: `src/lib/cloudApi.js`
- Create: `src/lib/useCloudSync.js`
- Create: `src/components/SyncStatus.jsx`
- Modify: `.env.example`

- [ ] **Step 1: Write the API contract before wiring React**

`src/lib/cloudApi.js` must expose this interface:

```js
export function createCloudApi(client) {
  return {
    async fetchSnapshot(),
    async upsertRows(rows),
    async fetchRowsUpdatedSince(isoTimestamp),
    async softDelete(entity, id, updatedAt),
  }
}
```

Every Supabase response must be checked for `error`; throw an `Error` containing the table name and Supabase message. `upsertRows` writes people, games, game_players, and rounds in foreign-key order. Reads include tombstoned rows so offline deletions can reconcile.

- [ ] **Step 2: Implement the client factory**

`src/lib/supabase.js` must contain:

```js
import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

export const supabase = url && key ? createClient(url, key) : null

export function cloudConfigured() {
  return Boolean(supabase)
}
```

The app must remain runnable without environment variables for local UI work; in that case it uses the existing local-only behavior and exposes `cloudConfigured() === false`.

- [ ] **Step 3: Implement `useCloudSync`**

The hook accepts the current app state and a setter and exposes:

```js
{
  status: 'local' | 'syncing' | 'synced' | 'offline' | 'pending' | 'error',
  pendingCount,
  error,
  syncNow,
  enqueueStateMutation,
}
```

On mount, hydrate cached state first, fetch the remote snapshot, merge it, then replay the outbox. Register `visibilitychange` and `online` listeners, remove them on cleanup, and use a single in-flight promise so two focus events cannot run overlapping syncs.

- [ ] **Step 4: Add sync status presentation**

`SyncStatus.jsx` renders nothing for a clean online state. It renders a compact label for `Offline`, `Saving locally · N pending`, `Syncing…`, or `Couldn't sync · Retry`. The Retry action calls `syncNow`.

- [ ] **Step 5: Build without cloud variables**

Run `npm run build`. Expected: the app builds and still opens in local-only mode when `.env.local` is absent.

- [ ] **Step 6: Commit the adapter**

```bash
git add src/lib/supabase.js src/lib/cloudApi.js src/lib/useCloudSync.js src/components/SyncStatus.jsx .env.example
git commit -m "Add Supabase client and cloud sync hook"
```

### Task 4: Integrate cloud state and first-run migration into App

**Files:**
- Modify: `src/App.jsx`
- Modify: `src/lib/storage.js`
- Create: `src/components/MigrationPanel.jsx`
- Modify: `src/components/DataPanel.jsx`
- Modify: `src/components/InstallBanner.jsx` only if sync status needs shared placement

- [ ] **Step 1: Preserve the current synchronous render path**

Initialize React state from `migrateState(loadState())` exactly as today, then let `useCloudSync` replace it with the cache/remote result. Never block the New Game or Game View screens on a network request.

- [ ] **Step 2: Route all existing mutations through one persistence boundary**

Create an `applyMutation(updater, mutationFactory)` helper in `App.jsx`. It must:

1. Apply the updater immediately to React state.
2. Save the resulting nested state to the local cache.
3. Create an outbox mutation when cloud mode is configured.
4. Let `useCloudSync` send the mutation and replace the cache with the server response.

Use this boundary for adding/removing roster people, starting games, updating games, deleting games, and importing backups. Keep `activeGameId` device-local and never upload it.

- [ ] **Step 3: Add first-run publish migration**

`MigrationPanel` appears only when cloud mode is configured, local state has games or roster entries, and the cache has not recorded `initialMigrationCompleted`. It shows exact counts and buttons `Publish to shared scorebook` and `Keep local for now`.

Publishing converts the local state through `toRemoteRows`, upserts by existing IDs, marks the migration complete only after all rows succeed, and leaves the JSON backup untouched. A failure leaves the outbox available for retry and does not mark completion.

- [ ] **Step 4: Extend Data & backup**

Add:

- cloud sync status and pending count;
- `Publish local history` when migration is still pending;
- `Export cloud backup`, which builds the existing JSON format from the reconciled state;
- an explanation that the shared scorebook is public and editable.

- [ ] **Step 5: Verify the first vertical slice**

Run `npm run build`, open the app with no `.env.local`, confirm the current local-only flow still works, then create `.env.local` from `.env.example` with the project URL/public key and confirm startup transitions through `syncing` to `synced` against the empty remote schema after Task 1 is deployed.

- [ ] **Step 6: Commit the integration**

```bash
git add src/App.jsx src/lib/storage.js src/components/MigrationPanel.jsx src/components/DataPanel.jsx src/components/InstallBanner.jsx
git commit -m "Connect app state to cloud sync"
```

### Task 5: Implement pure stats and leaderboard calculations

**Files:**
- Create: `src/lib/stats.js`
- Create: `tests/stats.test.js`

- [ ] **Step 1: Write the failing stats tests**

Cover:

- unfinished games are excluded;
- a unique first place counts as one win;
- tied first place counts as a win for each tied player;
- win rate is wins divided by finished games;
- average finish uses rank, not raw score;
- per-game breakdowns do not mix Farkle, Dutch Blitz, and 3-13 totals;
- longest win streak uses finished game order;
- most-played teammate counts shared completed games.

Use small game fixtures that call the existing `evaluate()` definitions rather than duplicating game scoring in tests.

- [ ] **Step 2: Implement the public stats API**

Export:

```js
export function buildPersonStats(personId, games) {}
export function buildLeaderboard(games) {}
export function buildGameBreakdown(personId, games) {}
```

Each returned person summary has `{ games, wins, winRate, averageFinish, longestWinStreak, favoriteGame, mostPlayedTeammate }`. Each game breakdown has `{ gameId, games, wins, winRate, averageFinish, gameSpecific }`. Use `evaluate(game)` for standings and ignore unknown game definitions.

Implement game-specific metrics through a small map keyed by game ID. Farkle exposes best/average final total, Dutch Blitz exposes best/average final total and blitz wins from `evaluate()` totals, and 3-13 exposes best/average final total plus first-out counts. Do not compare those raw totals between game IDs.

- [ ] **Step 3: Run tests and commit**

Run `node --test tests/stats.test.js`. Expected: PASS.

```bash
git add src/lib/stats.js tests/stats.test.js
git commit -m "Add shared player statistics"
```

### Task 6: Add People, person pages, Games, and Leaderboard routes

**Files:**
- Create: `src/lib/router.js`
- Create: `src/components/People.jsx`
- Create: `src/components/PersonPage.jsx`
- Create: `src/components/Games.jsx`
- Create: `src/components/Leaderboard.jsx`
- Modify: `src/App.jsx`, `src/components/Home.jsx`, `src/components/NewGame.jsx`
- Modify: `src/styles.css`

- [ ] **Step 1: Implement minimal History API routing**

`router.js` exports:

```js
export function readRoute(pathname = window.location.pathname) {}
export function navigate(route) {}
export function subscribeToRoutes(listener) {}
```

Recognize the current GitHub Pages base path, `/people`, `/people/:id`, `/leaderboard`, `/games`, `/games/:id`, and the existing new-game/game-view states. `navigate()` calls `history.pushState` and dispatches a `popstate` event. Unknown paths return Home.

- [ ] **Step 2: Add People directory and New Game search**

`People.jsx` filters non-deleted roster entries case-insensitively, shows game count and wins from `buildPersonStats`, and navigates to `/people/:id` when selected. `NewGame.jsx` uses the same roster search; the existing exact-name behavior becomes an explicit `Use existing John` result plus `Create new person “John”`.

- [ ] **Step 3: Add person pages and leaderboard**

`PersonPage.jsx` renders the approved summary-first layout: games, wins, win rate, average finish, per-game breakdown, fun stats, and recent games. `Leaderboard.jsx` ranks by wins descending, win rate descending, then average finish ascending, requiring at least one finished game. Ties share rank.

- [ ] **Step 4: Add shared Games view and navigation**

`Games.jsx` reuses the current `GameCard` visual language to list all non-deleted games, sorted by `updatedAt`, with filters for `In progress`, `Finished`, and game type. Home gets navigation controls for People, Leaderboard, and Games without removing the existing Start a game section.

- [ ] **Step 5: Run the UI build and manual route check**

Run `npm run build`, then `npm run dev`. Verify:

1. Home → People → John → back to People.
2. People → Leaderboard.
3. Home → Games → game → back.
4. New Game search selects an existing person before offering creation.
5. Directly refreshing `/people/<id>` renders the person page under the Vite dev server and GitHub Pages base path.

- [ ] **Step 6: Commit the directory and routes**

```bash
git add src/lib/router.js src/components/People.jsx src/components/PersonPage.jsx src/components/Games.jsx src/components/Leaderboard.jsx src/App.jsx src/components/Home.jsx src/components/NewGame.jsx src/styles.css
git commit -m "Add shared people history and leaderboard views"
```

### Task 7: Add confirmation, Undo, and sync conflict UX

**Files:**
- Create: `src/components/UndoToast.jsx`
- Modify: `src/components/GameView.jsx`, `src/components/Home.jsx`, `src/components/DataPanel.jsx`, `src/App.jsx`, `src/styles.css`

- [ ] **Step 1: Add confirmation around destructive actions**

Keep the existing confirmation for whole-game deletion and add confirmation before deleting a round. The copy must name the target and state that Undo is available briefly. Do not add confirmation to routine score edits.

- [ ] **Step 2: Implement reversible local deletion**

When a game or round is deleted, retain a complete snapshot in memory for 10 seconds, enqueue a tombstone, and show `Undo`. Undo restores the snapshot locally and enqueues an upsert. If the app reloads after deletion, the tombstone remains authoritative; JSON backup remains the long-term recovery path.

- [ ] **Step 3: Surface remote conflicts**

When a queued mutation loses the `updatedAt` comparison, refresh that row and show a non-blocking message: `This was changed on another device. The shared version is now shown.` Never discard a pending mutation without recording an error state.

- [ ] **Step 4: Verify destructive actions**

Run `npm run build` and manually verify delete → Undo, delete → reload, offline delete → reconnect, and concurrent edit of different rounds. Then commit:

```bash
git add src/components/UndoToast.jsx src/components/GameView.jsx src/components/Home.jsx src/components/DataPanel.jsx src/App.jsx src/styles.css
git commit -m "Add undo and sync conflict feedback"
```

### Task 8: Deploy variables, migration, backups, and end-to-end verification

**Files:**
- Modify: `.github/workflows/deploy.yml`, `README.md`, `src/components/DataPanel.jsx`
- Create or update: repository/organization GitHub Actions variables, without storing values in source

- [ ] **Step 1: Inject public Supabase variables into Pages builds**

Add this environment block to the `Build` step in `.github/workflows/deploy.yml`:

```yaml
        env:
          VITE_SUPABASE_URL: ${{ vars.VITE_SUPABASE_URL }}
          VITE_SUPABASE_PUBLISHABLE_KEY: ${{ vars.VITE_SUPABASE_PUBLISHABLE_KEY }}
        run: BUILD_BASE="/${GITHUB_REPOSITORY#*/}/" npm run build
```

Create the two repository variables in GitHub Settings → Secrets and variables → Actions using the Supabase Project URL and publishable key. Do not add the database password or service-role key.

- [ ] **Step 2: Apply the schema to the linked project**

After reviewing the migration, run locally:

```bash
npx supabase db push --linked
```

Expected: the migration is applied once and subsequent runs report the project is up to date. The GitHub integration may also deploy the committed migration on `main`; confirm in Supabase migration history rather than applying it twice.

- [ ] **Step 3: Publish existing local history**

With `.env.local` configured, open Data & backup, choose `Publish local history`, verify the counts, and confirm. Check Supabase Table Editor or the app on a second device for the same people, games, and rounds.

- [ ] **Step 4: Add cloud backup documentation**

Update `README.md` and `DataPanel.jsx` to explain that the cloud scorebook is public/editable, local cache is not the source of truth, Supabase Free projects may pause, and JSON export remains the recovery backup.

- [ ] **Step 5: Run the complete verification suite**

Run:

```bash
npm test
npm run build
git diff --check
```

Manual acceptance sequence:

1. Device A creates John, Caitlin, and a finished game.
2. Device B opens the deployed app and sees the same game and People directory.
3. Device B opens John’s page and sees correct wins, win rate, and per-game stats.
4. Device A edits a round; Device B refreshes and sees it.
5. Device A goes offline, creates a game, and sees `Pending sync`.
6. Device A reconnects; the game appears on Device B.
7. Delete a round, Undo it, then delete the whole game with confirmation.
8. Export the shared cloud snapshot and import it into a clean browser profile.

- [ ] **Step 6: Commit the deployment and documentation changes**

```bash
git add .github/workflows/deploy.yml README.md src/components/DataPanel.jsx
git commit -m "Document and deploy cloud scorebook configuration"
```

---

## Plan self-review

- **Spec coverage:** The plan covers the public no-account model, stable people, People/person pages, leaderboard, per-game stats, open CRUD, confirmations/Undo, normalized schema, Supabase Free hosting, local cache, outbox replay, conflict behavior, first-run migration, backup/export, environment deployment, and end-to-end acceptance.
- **Placeholder scan:** No unresolved placeholders or undefined implementation tasks remain. User-specific Supabase values are intentionally supplied through local/GitHub configuration rather than written into source.
- **Type consistency:** Remote rows use `people`, `games`, `gamePlayers`, and `rounds`; local state remains `{ games, roster, activeGameId }`; mutations use `{ id, entity, entityId, operation, payload, createdAt }`; stats consume existing `evaluate(game)` output.
- **Scope:** The tasks are ordered as independently testable slices. The first four establish cloud persistence while preserving the existing UI; the remaining tasks add the approved directory, stats, and deployment experience.
