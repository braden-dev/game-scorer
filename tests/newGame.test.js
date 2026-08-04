import test from 'node:test'
import assert from 'node:assert/strict'
import * as esbuild from 'esbuild'

const fakeReact = `
const state = globalThis.__newGameReactState ??= { slots: [], cursor: 0 }
export const Fragment = Symbol.for('fragment')
export function jsx(type, props, key) { return { type, props: { ...(props ?? {}), key } } }
export const jsxs = jsx
export function begin() { state.cursor = 0 }
export function reset() { state.slots = []; state.cursor = 0 }
export function useState(initial) {
  const index = state.cursor++
  if (!(index in state.slots)) state.slots[index] = typeof initial === 'function' ? initial() : initial
  return [state.slots[index], (value) => { state.slots[index] = typeof value === 'function' ? value(state.slots[index]) : value }]
}
export function useMemo(factory) { return factory() }
`

async function loadNewGame() {
  const plugin = {
    name: 'scorebook-new-game-test-aliases',
    setup(build) {
      build.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'scorebook-test' }))
      build.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'react/jsx-runtime', namespace: 'scorebook-test' }))
      build.onResolve({ filter: /^\.\.\/lib\/router\.js$/ }, () => ({ path: 'router', namespace: 'scorebook-test' }))
      build.onLoad({ filter: /.*/, namespace: 'scorebook-test' }, ({ path }) => ({
        contents: path === 'router' ? 'export function navigate() {}' : fakeReact,
        loader: 'js',
      }))
    },
  }
  const result = await esbuild.build({
    entryPoints: ['src/components/NewGame.jsx'],
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
  if (Array.isArray(element)) return element
  const children = element?.props?.children
  return Array.isArray(children) ? children : [children]
}

function findElement(element, predicate) {
  if (!element || typeof element !== 'object') return null
  if (Array.isArray(element)) {
    for (const child of element) {
      const match = findElement(child, predicate)
      if (match) return match
    }
    return null
  }
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

test('NewGame makes exact-name reuse and duplicate creation explicit', async () => {
  const NewGame = await loadNewGame()
  const added = []
  const props = {
    gameId: 'farkle',
    roster: [{ id: 'p_john', name: 'John' }],
    onCancel() {},
    onStart() {},
    onAddToRoster(name) { added.push(name); return { id: 'p_new', name } },
    onRemoveFromRoster() {},
  }

  globalThis.__newGameReactState?.slots.splice(0)
  globalThis.__newGameReactState.cursor = 0
  const firstTree = NewGame(props)
  const input = findElement(firstTree, (element) => element.type === 'input' && element.props?.type === 'text')
  input.props.onChange({ target: { value: 'John' } })

  globalThis.__newGameReactState.cursor = 0
  const searchedTree = NewGame(props)
  const results = findElement(searchedTree, (element) => element.props?.['aria-label'] === 'People search results')
  assert.match(textOf(results), /Use existing\s+John/)
  assert.match(textOf(results), /Create new person\s+“\s*John\s*”/)

  const useExisting = findElement(results, (element) => element.props?.className === 'person-search-result' && !element.props.className.includes('create'))
  useExisting.props.onClick()
  assert.deepEqual(added, [])
})
