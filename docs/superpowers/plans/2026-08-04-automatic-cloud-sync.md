# Automatic Cloud Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Supabase scorebook synchronize automatically and safely without false timestamp conflicts, migration prompts, or destructive local cache resets.

**Architecture:** Keep the current local state plus persisted outbox. Normalize timestamp values at the cloud API comparison boundary, keep failed mutations and optimistic local rows in the cache, and let the existing startup/online/visibility/retry lifecycle drive reconciliation. Move first-run local-history migration behind that same outbox so it happens silently.

**Tech Stack:** React 19, Vite, Supabase Data API, browser `localStorage`, Node's built-in `node:test`.

---

### Task 1: Make Supabase row comparisons timestamp-semantic

**Files:**
- Modify: `src/lib/cloudApi.js:20-64`
- Test: `tests/cloudApi.test.js`

- [ ] **Step 1: Add a failing PostgreSQL timestamp round-trip test**

Extend the test client in `tests/cloudApi.test.js` with an option that formats inserted timestamp values as PostgreSQL commonly returns them (`+00:00` with six fractional digits). Add this test:

```js
test('accepts a newly inserted row after PostgreSQL normalizes timestamp formatting', async () => {
  const client = mutableClient({}, { normalizeTimestamps: true })

  const result = await createCloudApi(client).upsertRows({ games: [{
    id: 'g_timestamp_round_trip',
    game_id: 'dutch-blitz',
    created_at: '2026-08-04T18:26:03.103Z',
    updated_at: '2026-08-04T18:26:03.103Z',
    finished_at: null,
    settings: { target: 75, blitzPenalty: 2 },
    deleted_at: null,
  }] })

  assert.equal(result.games[0].id, 'g_timestamp_round_trip')
  assert.equal(client.rows('games')[0].created_at, '2026-08-04T18:26:03.103000+00:00')
})
```

- [ ] **Step 2: Run the focused test and verify the correct failure**

Run `node --test tests/cloudApi.test.js`. Before the production change, the new test must fail with `conflicting equal-version row` after the row has been inserted into the fake database.

- [ ] **Step 3: Normalize timestamp fields inside canonical payload comparison**

In `src/lib/cloudApi.js`, add a helper that converts timestamp columns to parsed millisecond values before comparing them. Apply it to `created_at`, `updated_at`, `deleted_at`, and `finished_at`; leave JSON settings, names, IDs, seat order, and entries as structural values. Keep `updated_at` out of the payload comparison as it is today, because the database trigger may legitimately advance it.

The comparison must make these equivalent:

```js
normalizeComparableValue('2026-08-04T18:26:03.103Z', 'created_at')
normalizeComparableValue('2026-08-04T18:26:03.103000+00:00', 'created_at')
```

Both values must produce the same canonical value.

- [ ] **Step 4: Run the cloud API tests again**

Run `node --test tests/cloudApi.test.js`; the new test and all existing stale/equal-version tests must pass.

- [ ] **Step 5: Commit the isolated timestamp fix**

```bash
git add src/lib/cloudApi.js tests/cloudApi.test.js
git commit -m "fix: compare cloud timestamps semantically"
```

### Task 2: Preserve local state when a replay fails

**Files:**
- Modify: `src/lib/useCloudSync.js:67-116, 287-424`
- Test: `tests/useCloudSync.runtime.test.js`

- [ ] **Step 1: Add a failing regression assertion for conflict cache preservation**

Update the existing CAS conflict test near `tests/useCloudSync.runtime.test.js:854` so that it seeds a local game containing a local player and asserts after the conflict that:

```js
assert.equal(observed.state.games[0].id, 'g_conflict')
assert.equal(observed.state.games[0].players[0].id, 'p_local')
assert.equal(stored.outbox[0].status, 'conflict')
```

The test must still assert that the mutation is not counted as replayable pending work. This isolates the UX safety change from the conflict policy.

- [ ] **Step 2: Run the focused runtime test and verify it fails**

Run `node --test tests/useCloudSync.runtime.test.js`. Confirm the conflict test fails because `removeConflictRows()` currently removes the game/player records from the cache.

- [ ] **Step 3: Stop deleting rows during conflict refresh**

In the CAS conflict branch, fetch the remote snapshot and merge it with `latestStoreAfterConflict.cache` directly. Remove the call to `removeConflictRows()` from that path. Keep the conflicted outbox entry recorded for diagnostics, but preserve the optimistic local cache and its cloud metadata so a failed write cannot erase a just-created game.

Update the conflict status text to a compact retry-oriented message rather than claiming that the shared version is now shown when local optimistic state remains visible.

- [ ] **Step 4: Run all sync runtime tests**

Run `node --test tests/useCloudSync.runtime.test.js tests/useCloudSync.test.js`. Update only assertions that describe the intentionally changed conflict behavior; retain tests proving genuine remote conflict entries are recorded and ordinary network failures remain queued.

- [ ] **Step 5: Commit the cache-safety fix**

```bash
git add src/lib/useCloudSync.js tests/useCloudSync.runtime.test.js
git commit -m "fix: preserve local state after sync conflicts"
```

### Task 3: Make first-run local history migration automatic

**Files:**
- Modify: `src/App.jsx:99-117, 522-576, 580-675`
- Modify: `src/components/DataPanel.jsx:7-16, 81-114`
- Delete or stop rendering: `src/components/MigrationPanel.jsx`
- Test: `tests/appGameViewMutation.test.js`, `tests/appIntegration.test.js`

- [ ] **Step 1: Add a failing automatic-migration integration test**

Add an App test that starts with local history, `initialMigrationCompleted: false`, a configured fake cloud API, and no user interaction. After effects settle, assert that the API receives one `initialMigration: true` mutation and that no `MigrationPanel` is present in the rendered tree.

Also change the existing migration tests that call `migrationPanel.props.onPublish()` to wait for the automatic effect and assert the same cloud reconciliation without clicking a panel.

- [ ] **Step 2: Run the focused App tests and verify failure**

Run `node --test tests/appGameViewMutation.test.js tests/appIntegration.test.js`. The new test must fail because the current App only creates a migration mutation after the panel invokes `onPublish`.

- [ ] **Step 3: Trigger migration from startup without rendering a prompt**

Reuse the current additive `publishMigration()` logic, including the initial full snapshot and `filterRowsAlreadyInCloud()` behavior, but call it once from a guarded `useEffect` when:

```js
configured && hadLocalDataAtStartup && !loadSyncStore().initialMigrationCompleted
```

Use a ref to prevent duplicate starts while the async migration is in flight. A rejected migration must be left in the outbox; do not show an alert or modal. The normal sync retry path will replay it later.

Remove `MigrationPanel` from the App render tree and remove the manual `Publish local history` action from `DataPanel`. Keep Export/Import and cloud backup actions intact.

- [ ] **Step 4: Mark an automatically completed migration**

When the initial migration mutation is successfully removed from the outbox, persist `initialMigrationCompleted: true` in the sync store. This must happen inside the sync lifecycle so a migration that succeeds after reconnect does not remain eligible for another startup attempt.

- [ ] **Step 5: Run the focused App tests**

Run `node --test tests/appGameViewMutation.test.js tests/appIntegration.test.js`. Confirm automatic migration passes, local JSON backup behavior remains unchanged, and no migration prompt is rendered.

- [ ] **Step 6: Commit the automatic migration UX**

```bash
git add src/App.jsx src/components/DataPanel.jsx src/components/MigrationPanel.jsx tests/appGameViewMutation.test.js tests/appIntegration.test.js
git commit -m "feat: migrate local history automatically"
```

### Task 4: Make retry status quiet and persistent without manual sync prompts

**Files:**
- Modify: `src/lib/useCloudSync.js:204-224, 277-449`
- Modify: `src/components/SyncStatusView.js`
- Modify: `src/App.jsx:601-603`
- Test: `tests/syncStatus.test.js`, `tests/useCloudSync.test.js`, `tests/useCloudSync.runtime.test.js`

- [ ] **Step 1: Add status tests for automatic retry messaging**

Extend `tests/syncStatus.test.js` with assertions that an offline/pending state renders `Will retry when online` or an equivalent compact status, and that the old conflict sentence is not rendered by the status component. Keep the manual Retry button available only as an optional escape hatch in the Data panel.

- [ ] **Step 2: Run the focused status tests and verify failure**

Run `node --test tests/syncStatus.test.js`. The new expected copy must fail against the current `Offline`/`Couldn't sync` rendering.

- [ ] **Step 3: Keep retry scheduling alive for pending work**

Retain the existing bounded exponential attempts, then schedule a slower retry while replayable outbox work remains. Reset the retry schedule after any successful sync, and cancel it on unmount. Continue to invoke `syncNow` from the existing online and visibility listeners.

- [ ] **Step 4: Remove the global conflict banner**

Remove the `CONFLICT_MESSAGE`-only `global-sync-notice` from `App.jsx`. Sync status belongs in the Data panel and must not cover the scorekeeping screen or remain permanently at the top after a recoverable failure.

- [ ] **Step 5: Run sync and UI status tests**

Run `node --test tests/syncStatus.test.js tests/useCloudSync.test.js tests/useCloudSync.runtime.test.js tests/appGameViewMutation.test.js`. Confirm retry listeners still work and no old top-of-screen conflict banner is expected.

- [ ] **Step 6: Commit the quiet retry UX**

```bash
git add src/lib/useCloudSync.js src/components/SyncStatusView.js src/App.jsx tests/syncStatus.test.js tests/useCloudSync.test.js tests/useCloudSync.runtime.test.js
git commit -m "feat: retry cloud sync quietly"
```

### Task 5: Full verification and local browser smoke test

**Files:**
- Modify: `README.md` only if the final automatic-sync behavior is undocumented.

- [ ] **Step 1: Run the complete automated suite**

Run `npm test`. Expected: zero failing tests.

- [ ] **Step 2: Build the production bundle**

Run `npm run build`. Expected: exit code 0. Record any existing non-fatal chunk-size warning without treating it as a failure.

- [ ] **Step 3: Run repository checks**

Run `npm run assert:build`, `npm run validate:migration`, and `git diff --check`. Expected: all exit successfully.

- [ ] **Step 4: Manually test automatic behavior locally**

With `.env.local` configured and the dev server running:

1. Load the app with the existing local history and confirm no migration prompt appears.
2. Create a new game with two existing people; reload and confirm both players remain.
3. Add a new person and start a game; confirm it appears in Supabase without the conflict banner.
4. Turn the browser offline, add a round, and confirm the score remains visible with a pending/offline status.
5. Restore connectivity or dispatch the browser online event, confirm the pending count clears, and verify the row exists through the app's cloud-backed refresh.

- [ ] **Step 5: Review final diff and status**

Run `git status --short --branch` and `git log --oneline -8`. Confirm only intended source/tests/docs changed, no `.env.local` or secrets are tracked, and all implementation commits are on `codex/cloud-scorebook` without pushing or merging.
