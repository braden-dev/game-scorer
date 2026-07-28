# Game Scorer

A local-first score keeper for **Farkle**, **Dutch Blitz**, and **3-13**. No accounts, no
backend — every game is saved to your browser's localStorage and survives refreshes.

## Running it

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

To build a static copy you can host anywhere (or just open from disk):

```bash
npm run build
```

The output lands in `dist/` and uses relative asset paths, so it works from a file server,
GitHub Pages, or a folder on a tablet.

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
  lib/storage.js          localStorage read/write
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
