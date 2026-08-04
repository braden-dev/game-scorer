import test from 'node:test'
import assert from 'node:assert/strict'
import * as esbuild from 'esbuild'

const fakeReact = `
const effects = globalThis.__undoToastEffects ??= []
export function useRef(current) { return { current } }
export function useEffect(effect, dependencies) { effects.push({ effect, dependencies }) }
export function jsx(type, props, key) { return { type, props: { ...(props ?? {}), key } } }
export const jsxs = jsx
`

async function loadUndoToast() {
  const plugin = {
    name: 'scorebook-undo-toast-test-aliases',
    setup(build) {
      build.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'scorebook-test' }))
      build.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'react/jsx-runtime', namespace: 'scorebook-test' }))
      build.onLoad({ filter: /.*/, namespace: 'scorebook-test' }, () => ({ contents: fakeReact, loader: 'js' }))
    },
  }
  const result = await esbuild.build({
    entryPoints: ['src/components/UndoToast.jsx'],
    bundle: true,
    format: 'esm',
    jsx: 'automatic',
    platform: 'node',
    plugins: [plugin],
    write: false,
  })
  return (await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)).default
}

test('UndoToast schedules expiry and clears its timer on unmount', async () => {
  const UndoToast = await loadUndoToast()
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const effects = globalThis.__undoToastEffects
  effects.length = 0
  const timers = []
  const cleared = []
  let expired = 0
  globalThis.setTimeout = (callback, delay) => {
    const timer = { callback, delay }
    timers.push(timer)
    return timer
  }
  globalThis.clearTimeout = (timer) => cleared.push(timer)

  try {
    UndoToast({ message: 'Round deleted.', onUndo: () => {}, onExpire: () => { expired += 1 }, durationMs: 10_000 })
    const cleanup = effects[0].effect()
    assert.equal(timers.length, 1)
    assert.equal(timers[0].delay, 10_000)
    timers[0].callback()
    assert.equal(expired, 1)
    cleanup()
    assert.deepEqual(cleared, [timers[0]])
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
  }
})
