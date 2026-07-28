# Game Scorer

A local-first score keeper for **Farkle**, **Dutch Blitz**, and **3-13**. No accounts, no
backend — every game is saved to your browser's localStorage and survives refreshes. It's an
installable PWA, so it runs offline from your phone's home screen.

## Running it

```bash
npm install
npm run dev
```

Then open http://localhost:5173. Note that the service worker is only generated for real
builds — use `npm run build && npm run preview` to exercise offline behaviour.

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
- Enter leftover-card penalties directly, tap **Went out** for a clean 0, or use the
  **card counter** to tap the cards still in a hand.
- Configurable: 10/J/Q/K as 10 each or by rank, ace as 1 or 15, and optional jokers at 20.
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
