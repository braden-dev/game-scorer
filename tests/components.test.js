import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import * as esbuild from 'esbuild'

const fakeReact = `
export const Fragment = Symbol.for('fragment')
export function jsx(type, props, key) { return { type, props: { ...(props ?? {}), key } } }
export const jsxs = jsx
export function useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] }
export function useEffect() {}
export function useMemo(factory) { return factory() }
`

async function loadPeople() {
  const plugin = {
    name: 'scorebook-people-test-aliases',
    setup(build) {
      build.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'scorebook-test' }))
      build.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'react/jsx-runtime', namespace: 'scorebook-test' }))
      build.onResolve({ filter: /^\.\.\/lib\/router\.js$/ }, () => ({ path: 'router', namespace: 'scorebook-test' }))
      build.onLoad({ filter: /.*/, namespace: 'scorebook-test' }, ({ path }) => ({
        contents: path === 'router'
          ? 'export function navigate(route) { globalThis.__peopleRoute = route }'
          : fakeReact,
        loader: 'js',
      }))
    },
  }
  const result = await esbuild.build({
    entryPoints: ['src/components/People.jsx'],
    bundle: true,
    format: 'esm',
    jsx: 'automatic',
    platform: 'node',
    plugins: [plugin],
    write: false,
  })
  return (await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)).default
}

async function loadMigrationPanel() {
  const plugin = {
    name: 'scorebook-migration-panel-test-aliases',
    setup(build) {
      build.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'scorebook-test' }))
      build.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'react/jsx-runtime', namespace: 'scorebook-test' }))
      build.onLoad({ filter: /.*/, namespace: 'scorebook-test' }, () => ({
        contents: fakeReact,
        loader: 'js',
      }))
    },
  }
  const result = await esbuild.build({
    entryPoints: ['src/components/MigrationPanel.jsx'],
    bundle: true,
    format: 'esm',
    jsx: 'automatic',
    platform: 'node',
    plugins: [plugin],
    write: false,
  })
  return (await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)).default
}

async function loadGameView() {
  const plugin = {
    name: 'scorebook-game-view-test-aliases',
    setup(build) {
      build.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'scorebook-test' }))
      build.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'react/jsx-runtime', namespace: 'scorebook-test' }))
      build.onResolve({ filter: /^\.\.\/lib\/useWakeLock\.js$/ }, () => ({ path: 'wakeLock', namespace: 'scorebook-test' }))
      build.onLoad({ filter: /.*/, namespace: 'scorebook-test' }, ({ path }) => ({
        contents: path === 'wakeLock' ? 'export function useWakeLock() {}' : fakeReact,
        loader: 'js',
      }))
    },
  }
  const result = await esbuild.build({
    entryPoints: ['src/components/GameView.jsx'],
    bundle: true,
    format: 'esm',
    jsx: 'automatic',
    platform: 'node',
    plugins: [plugin],
    write: false,
  })
  return (await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)).default
}

function childrenOf(element) {
  const children = element?.props?.children
  return Array.isArray(children) ? children : [children]
}

function findElement(element, predicate) {
  if (!element || typeof element !== 'object') return null
  if (predicate(element)) return element
  for (const child of childrenOf(element)) {
    const match = findElement(child, predicate)
    if (match) return match
  }
  return null
}

function textOf(element) {
  if (element === null || element === undefined || typeof element === 'boolean') return ''
  if (typeof element === 'string' || typeof element === 'number') return String(element)
  return childrenOf(element).map(textOf).join(' ')
}

test('People shows active roster stats and opens a person page', async () => {
  const People = await loadPeople()
  const tree = People({
    roster: [
      { id: 'p_john', name: 'John' },
      { id: 'p_deleted', name: 'Deleted', deletedAt: 123 },
    ],
    games: [{
      id: 'g_one',
      gameId: 'farkle',
      players: [{ id: 'p_john', name: 'John' }, { id: 'p_other', name: 'Other' }],
      settings: { target: 100, opening: 0, straight: 1500, threePairs: 1500, twoTriplets: 2500, multiRule: 'fixed' },
      rounds: [{ entries: { p_john: { score: 100 }, p_other: { score: 50 } } }],
    }],
  })

  assert.match(textOf(tree), /John/)
  assert.match(textOf(tree), /1\s+game/)
  assert.match(textOf(tree), /1\s+win/)
  assert.doesNotMatch(textOf(tree), /Deleted/)

  const personButton = findElement(tree, (element) => element.type === 'button' && element.props?.className === 'directory-open')
  assert.ok(personButton)
  personButton.props.onClick()
  assert.deepEqual(globalThis.__peopleRoute, { type: 'person', id: 'p_john' })
})

test('global sync notice reserves normal flow space instead of overlaying controls', async () => {
  const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8')
  const notice = styles.match(/\.global-sync-notice\s*\{([\s\S]*?)\n\}/)?.[1]
  assert.ok(notice)
  assert.doesNotMatch(notice, /position:\s*fixed/)
  assert.match(notice, /margin:/)
})

test('MigrationPanel reports skipped unsupported games before publish', async () => {
  const MigrationPanel = await loadMigrationPanel()
  const tree = MigrationPanel({
    state: {
      roster: [{ id: 'p_roster', name: 'Roster Player' }],
      games: [{
        id: 'g_supported', gameId: 'farkle', players: [], rounds: [], settings: {},
      }, {
        id: 'g_future', gameId: 'future-game', players: [], rounds: [], settings: {},
      }],
    },
    onPublish: () => {},
    onKeepLocal: () => {},
  })

  const notice = findElement(tree, (element) => element.props?.role === 'status')
  assert.ok(notice)
  assert.match(textOf(notice), /Skipping\s+1\s+unsupported\s+game/)
})

test('GameView safely renders malformed remote settings with defaults', async () => {
  const GameView = await loadGameView()
  const baseGame = {
    id: 'g_malformed_settings',
    gameId: 'farkle',
    players: [{ id: 'p_one', name: 'One' }, { id: 'p_two', name: 'Two' }],
    rounds: [],
    finishedAt: null,
  }

  for (const target of ['not-a-number', {}, null, Number.NaN]) {
    assert.doesNotThrow(() => {
      const tree = GameView({
        game: { ...baseGame, settings: { target } },
        roster: baseGame.players,
        onUpdate: () => {},
        onBack: () => {},
        onRematch: () => {},
        onAddToRoster: () => baseGame.players[0],
      })
      assert.match(textOf(tree), /first to 10,000/)
    }, `target=${String(target)}`)
  }
})
