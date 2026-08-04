# Automatic Cloud Synchronization

**Date:** 2026-08-04
**Status:** Approved design; implementation pending

## Goal

Make Supabase synchronization automatic and unobtrusive while preserving the app's local-first, offline-capable behavior. A user should record a person, game, round, or deletion once and never need to press a separate sync or publish button.

## Behavior

- Local state updates immediately and remains usable offline.
- Every cloud-visible mutation is added to the existing outbox and attempted immediately when online.
- Pending mutations retry with bounded backoff, on application startup, when connectivity returns, and when the app becomes visible again.
- Existing local history is migrated silently on the first cloud-enabled launch. The migration is additive: records already present in Supabase are not duplicated or overwritten by the migration.
- The existing JSON backup is not modified by migration or synchronization.
- A failed sync never removes the user's local game, people, rounds, or pending mutation. The outbox remains the recovery mechanism.

## Timestamp correctness

Supabase `timestamptz` values can return with `+00:00` offsets and microsecond precision while the browser emits millisecond `Z` timestamps. Conflict/idempotency comparisons must compare timestamps semantically, using normalized time values, rather than requiring identical strings. A regression test will reproduce a PostgreSQL-formatted round trip and verify that a newly inserted row is accepted without a false equal-version conflict.

## Failure and conflict UX

Normal sync activity is not a blocking prompt. The app may show compact status in the existing Data panel, such as `Syncing`, `Offline`, `Saving locally`, or `Will retry when online`. The current persistent conflict banner is removed or replaced with a non-destructive status.

If a genuine remote conflict occurs, the app refreshes remote state but retains the local mutation/cache until the conflict is resolved by the sync policy. It must not delete an entire newly-created game merely because one replay failed.

## Migration UX

The first-run `Publish local history?` panel and manual publish action are removed from the normal flow. Initial migration runs as a background outbox operation after the first cloud snapshot is read. If it cannot complete, local history remains available and the queued migration retries automatically.

## Scope and non-goals

This change does not add accounts, permissions, realtime subscriptions, or a new backend. It reuses the current Supabase schema, normalized row adapters, local cache, and mutation outbox.

## Validation

- Add focused tests for timestamp normalization and automatic migration.
- Add/adjust tests proving failed replay retains local cache and pending work.
- Run the full Node test suite, production build, build assertion, migration validation, and `git diff --check`.
- Manually verify creating a game with new and existing people, offline edits followed by reconnect, and startup with existing local history.
