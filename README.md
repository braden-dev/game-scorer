# Game Scorer

A cloud-first score keeper for **Farkle**, **Dutch Blitz**, and **3-13**. The shared scorebook is
public and editable; the app also keeps a local cache so it remains useful offline and survives
refreshes as an installable PWA.

## Running it

```bash
npm install
npm run dev
```

For cloud sync, create an uncommitted `.env.local` with the public project settings:

```bash
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_…
```

Then open http://localhost:5173. Without these variables the app stays local-only. The service
worker is only generated for real builds — use `npm run build && npm run preview` to exercise
offline behaviour.

## Cloud sync and migration

With cloud settings present, the app loads the shared snapshot into a local cache. Edits apply
immediately to the cache and enter an outbox; the sync loop retries them, uses updated-at
compare-and-set checks, and refreshes the shared version when another device wins. JSON export
remains the long-term backup. Shared scorebook rows are intentionally public and editable by
anyone using the configured publishable key.

When cloud sync is configured, existing local history is automatically queued for publication after
the first successful full cloud snapshot. This proceeds quietly and retries after temporary offline
or sync failures. Before applying the database migration, validate it locally or against the linked
project:

```bash
npm run validate:migration
npx supabase link --project-ref YOUR_PROJECT_REF
npx supabase db lint --linked
npx supabase db push --linked
```

Run `db push` only after lint succeeds. The validation command is rollback-only when it uses a
local Postgres database and never deploys anything.

Only `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` belong in the frontend or GitHub
Pages build variables. Never put a service-role key, database password, or other privileged
Supabase credential in frontend code or `VITE_*` variables.

## Installing on your phone

The app deploys to GitHub Pages on every push to `main` (see
`.github/workflows/deploy.yml`). Once it's live:

- **iPhone** — open the URL in Safari, tap Share, then **Add to Home Screen**.
- **Android** — open the URL in Chrome, then **Install app** from the menu (the app also
  offers an install button when the browser supports it).

Installing matters for more than convenience: iOS clears script-writable storage for sites
you haven't opened in 7 days, but exempts web apps launched from the home screen. Installed,
your score history sticks around.

The app keeps the screen awake while a game is in progress, and works with no network at all
after the first load.

## Backups

Scores live in browser storage, which is not a backup. The **⋯ → Data & backup** menu on the
home screen exports everything to a JSON file (via the share sheet on phones, a download on
desktop) and imports it back.

Import **merges** — it adds games the device doesn't already have and never overwrites or
deletes what's there — so it's also how you move history between your phone and laptop.

## Building

```bash
npm run build
```

Output lands in `dist/`. For a subpath deploy like GitHub Pages project sites, set the base:

```bash
BUILD_BASE=/GameScorer/ npm run build
```

App icons are generated from `assets/icon.svg` and `assets/icon-maskable.svg`. After editing
either, regenerate the PNGs:

```bash
npm run icons
```

## What it does

- **Add / remove players** — names you use are remembered in a roster, so the next game is
  two taps. Players can also be added or dropped mid-game.
- **Round-by-round entry** — one sheet per round captures every player at once.
- **Editable history** — tap any row in the history table to fix or delete that round.
  Totals and the winner recalculate immediately.
- **House rules** — target scores and scoring variants are per-game settings, adjustable
  even after play has started.
- **Persistence** — everything is written to `localStorage` under `gamescorer.v1`.

## Per-game notes

### Farkle
- Standard scoring: 1 = 100, 5 = 50, three of a kind = 100 × face (1s = 1,000).
- Built-in **dice calculator** — tap the dice you set aside and it computes the best
  scoring interpretation, flags a Farkle, and tells you when you have hot dice.
- Configurable: target (default 10,000), points needed to get on the board (default 500),
  straight, three pairs, two triplets, and whether 4/5/6-of-a-kind are flat 1,000/2,000/3,000
  or double per extra die.
- A player who hasn't met the opening requirement keeps a total of 0 — the raw turn score is
  still recorded in the history so you can see what they rolled.

### Dutch Blitz
- Each round: `+1` per card played to the Dutch piles, `−2` per card left in the Blitz pile.
- Mark who called "Blitz!" — the scoreboard tracks how many each player has won.
- First to 75 wins (configurable).

### 3-13
- 11 rounds; round *n* deals *n + 2* cards and the matching rank is wild (3s through Kings).
- Enter leftover-card penalties directly, or use the **card counter** to tap the cards still
  in a hand.
- **🥇 Out first** marks the player who ended the round — they score −5 by default. Only one
  player can hold it, so claiming it for someone else demotes the previous holder rather than
  handing out two bonuses.
- **✓ Also out** is for anyone who cleared their hand on that final turn: 0 for the round.
- A wild card left in your hand scores its own rank (a 3 counts 3), same as any other card —
  it isn't worth anything special.
- Configurable: the first-out bonus, 10/J/Q/K as 10 each or by rank, ace as 1 or 15, and
  optional jokers at 20.
- Lowest total after the last round wins.

## Layout

```
src/
  App.jsx                 top-level state, routing, persistence
  lib/
    storage.js            localStorage read/write
    backup.js             export / import / merge
    useWakeLock.js        keeps the screen on during a game
    useInstallPrompt.js   PWA install detection
  games/
    index.js              registry + evaluate() (totals, standings, win check)
    farkle.jsx            Farkle definition, entry UI, rules
    farkleScoring.js      dice-combination scoring engine
    dutchBlitz.jsx
    threeThirteen.jsx
  components/             shared UI (scoreboard, round sheet, modals, fields)
```

Adding a fourth game means writing one module in `src/games/` and registering it in
`src/games/index.js`; the scoreboard, history table, round sheet, and persistence are shared.
