import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

const esbuildUrl = import.meta.resolve('esbuild')
const jsxLoader = `
  import { readFile } from 'node:fs/promises'
  import { transform } from '${esbuildUrl}'

  export async function load(url, context, nextLoad) {
    if (!url.endsWith('.jsx')) return nextLoad(url, context)
    const source = await readFile(new URL(url), 'utf8')
    const transformed = await transform(source, { loader: 'jsx', format: 'esm', sourcefile: url })
    return { format: 'module', source: transformed.code, shortCircuit: true }
  }
`

register(`data:text/javascript,${encodeURIComponent(jsxLoader)}`, import.meta.url)

const {
  buildGameBreakdown,
  buildLeaderboard,
  buildPersonStats,
} = await import('../src/lib/stats.js')

const players = (...ids) => ids.map((id) => ({ id, name: id.toUpperCase() }))

function farkle(id, scores, target = 100) {
  const playerList = players(...Object.keys(scores))
  return {
    id,
    gameId: 'farkle',
    players: playerList,
    settings: {
      target,
      opening: 0,
      straight: 1500,
      threePairs: 1500,
      twoTriplets: 2500,
      multiRule: 'fixed',
    },
    rounds: [{ entries: Object.fromEntries(Object.entries(scores).map(([personId, score]) => [personId, { score }])) }],
  }
}

function dutchBlitz(id, entries, target = 10) {
  const playerList = players(...Object.keys(entries))
  return {
    id,
    gameId: 'dutch-blitz',
    players: playerList,
    settings: { target, blitzPenalty: 2 },
    rounds: [{ entries }],
  }
}

function threeThirteen(id, entries) {
  const playerList = players(...Object.keys(entries))
  return {
    id,
    gameId: 'three-thirteen',
    players: playerList,
    settings: {
      rounds: 1,
      faceValue: 'ten',
      aceValue: 1,
      jokerValue: 0,
      firstOutBonus: -5,
    },
    rounds: [{ entries }],
  }
}

test('excludes unfinished games and ignores unknown game definitions', () => {
  const unfinished = farkle('unfinished', { p1: 50, p2: 25 })
  const unknown = {
    id: 'unknown',
    gameId: 'not-a-real-game',
    players: players('p1', 'p2'),
    rounds: [],
  }

  assert.deepEqual(buildPersonStats('p1', [unfinished, unknown]), {
    games: 0,
    wins: 0,
    winRate: 0,
    averageFinish: null,
    longestWinStreak: 0,
    favoriteGame: null,
    mostPlayedTeammate: null,
  })
})

test('counts unique and tied first places, win rate, and average rank', () => {
  const games = [
    farkle('unique', { p1: 100, p2: 50 }),
    farkle('tied', { p1: 100, p2: 100 }),
    farkle('second', { p1: 50, p2: 100 }),
  ]

  assert.deepEqual(buildPersonStats('p1', games), {
    games: 3,
    wins: 2,
    winRate: 2 / 3,
    averageFinish: 4 / 3,
    longestWinStreak: 2,
    favoriteGame: 'farkle',
    mostPlayedTeammate: { id: 'p2', name: 'P2', games: 3 },
  })
  assert.equal(buildPersonStats('p2', games).wins, 2)
})

test('keeps each game breakdown and its totals isolated by game definition', () => {
  const games = [
    farkle('farkle-game', { p1: 100, p2: 50 }),
    farkle('farkle-game-two', { p1: 200, p2: 100 }),
    dutchBlitz('blitz-game', {
      p1: { dutch: 20, blitz: 0, blitzed: true },
      p2: { dutch: 0, blitz: 5, blitzed: false },
    }),
    dutchBlitz('blitz-game-two', {
      p1: { dutch: 30, blitz: 0, blitzed: false },
      p2: { dutch: 0, blitz: 10, blitzed: false },
    }),
    threeThirteen('three-thirteen-game', {
      p1: { points: 0, out: true, first: true },
      p2: { points: 3, out: false, first: false },
    }),
    threeThirteen('three-thirteen-game-two', {
      p1: { points: 2, out: false, first: false },
      p2: { points: 5, out: false, first: false },
    }),
  ]

  assert.deepEqual(buildGameBreakdown('p1', games), [
    {
      gameId: 'farkle',
      games: 2,
      wins: 2,
      winRate: 1,
      averageFinish: 1,
      gameSpecific: { bestFinalTotal: 200, averageFinalTotal: 150 },
    },
    {
      gameId: 'dutch-blitz',
      games: 2,
      wins: 2,
      winRate: 1,
      averageFinish: 1,
      gameSpecific: { bestFinalTotal: 30, averageFinalTotal: 25, blitzWins: 1 },
    },
    {
      gameId: 'three-thirteen',
      games: 2,
      wins: 2,
      winRate: 1,
      averageFinish: 1,
      gameSpecific: { bestFinalTotal: -5, averageFinalTotal: -1.5, firstOuts: 1 },
    },
  ])
})

test('follows finished-game order for win streaks and counts shared teammates', () => {
  const games = [
    farkle('win-one', { p1: 100, p2: 50, p3: 25 }),
    farkle('loss', { p1: 50, p2: 100 }),
    farkle('win-two', { p1: 100, p2: 50 }),
    farkle('win-three', { p1: 100, p2: 50 }),
  ]

  const stats = buildPersonStats('p1', games)
  assert.equal(stats.longestWinStreak, 2)
  assert.deepEqual(stats.mostPlayedTeammate, { id: 'p2', name: 'P2', games: 4 })
})

test('chooses the lexicographically first game ID when favorite games are tied', () => {
  const games = [
    farkle('farkle-game', { p1: 100, p2: 50 }),
    dutchBlitz('blitz-game', {
      p1: { dutch: 20, blitz: 0, blitzed: false },
      p2: { dutch: 0, blitz: 5, blitzed: false },
    }),
  ]

  assert.equal(buildPersonStats('p1', games).favoriteGame, 'dutch-blitz')
})

test('builds a ranked leaderboard from people in finished known games', () => {
  const games = [
    farkle('leader-one', { p1: 100, p2: 50 }),
    farkle('leader-two', { p1: 100, p2: 50 }),
    farkle('leader-unfinished', { p3: 50, p1: 25 }),
  ]

  assert.deepEqual(buildLeaderboard(games).map(({ personId, rank, wins }) => ({ personId, rank, wins })), [
    { personId: 'p1', rank: 1, wins: 2 },
    { personId: 'p2', rank: 2, wins: 0 },
  ])
})
