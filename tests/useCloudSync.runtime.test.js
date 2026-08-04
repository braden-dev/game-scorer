import test from 'node:test'
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

class MemoryStorage {
  #values = new Map()

  getItem(key) { return this.#values.get(key) ?? null }
  setItem(key, value) { this.#values.set(key, String(value)) }
}

function deferred() {
  let resolve
  const promise = new Promise((value) => { resolve = value })
  return { promise, resolve }
}

function browserHarness() {
  const listeners = new Map()
  const documentListeners = new Map()
  const previous = {
    document: globalThis.document,
    localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    addEventListener: globalThis.addEventListener,
    removeEventListener: globalThis.removeEventListener,
    window: globalThis.window,
    actEnvironment: globalThis.IS_REACT_ACT_ENVIRONMENT,
  }
  const window = {
    event: { type: 'load' },
    HTMLIFrameElement: class {},
    addEventListener(name, listener) { listeners.set(name, listener) },
    removeEventListener(name, listener) { listeners.delete(name) },
  }
  const document = {
    nodeType: 9,
    defaultView: window,
    visibilityState: 'visible',
    addEventListener(name, listener) { documentListeners.set(name, listener) },
    removeEventListener(name, listener) { documentListeners.delete(name) },
    createElement(type) {
      const element = {
        nodeType: 1,
        nodeName: type.toUpperCase(),
        tagName: type.toUpperCase(),
        ownerDocument: document,
        children: [],
        firstChild: null,
        style: {},
        appendChild(child) { this.children.push(child); this.firstChild ??= child; return child },
        insertBefore(child) { this.children.unshift(child); this.firstChild = child; return child },
        removeChild(child) { this.children = this.children.filter((item) => item !== child); this.firstChild = this.children[0] ?? null; return child },
        addEventListener() {},
        removeEventListener() {},
        setAttribute() {},
      }
      return element
    },
    createTextNode(text) { return { nodeType: 3, nodeValue: text, ownerDocument: document } },
  }
  document.documentElement = document.createElement('html')
  document.body = document.createElement('body')
  document.activeElement = document.body
  globalThis.window = window
  globalThis.document = document
  globalThis.addEventListener = window.addEventListener
  globalThis.removeEventListener = window.removeEventListener
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() })
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  return {
    listeners,
    documentListeners,
    createContainer: () => document.createElement('div'),
    restore() {
      if (previous.document === undefined) delete globalThis.document
      else globalThis.document = previous.document
      if (previous.window === undefined) delete globalThis.window
      else globalThis.window = previous.window
      if (previous.addEventListener) globalThis.addEventListener = previous.addEventListener
      else delete globalThis.addEventListener
      if (previous.removeEventListener) globalThis.removeEventListener = previous.removeEventListener
      else delete globalThis.removeEventListener
      if (previous.localStorage) Object.defineProperty(globalThis, 'localStorage', previous.localStorage)
      else delete globalThis.localStorage
      if (previous.navigator) Object.defineProperty(globalThis, 'navigator', previous.navigator)
      else delete globalThis.navigator
      if (previous.actEnvironment === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT
      else globalThis.IS_REACT_ACT_ENVIRONMENT = previous.actEnvironment
    },
  }
}

async function loadHook() {
  return (await import('../src/lib/useCloudSync.js')).useCloudSync
}

test('mounts the real hook, follows navigation during deferred sync, deduplicates refreshes, and cleans listeners', async () => {
  const browser = browserHarness()
  const useCloudSync = await loadHook()
  const gate = deferred()
  let fetchCalls = 0
  const api = {
    fetchSnapshot() { fetchCalls += 1; return gate.promise },
    fetchRowsUpdatedSince: async () => ({ people: [], games: [], gamePlayers: [], rounds: [] }),
    upsertRows: async () => {},
    softDelete: async () => {},
  }
  const observed = { hook: null, updates: [] }
  const setState = (state) => { observed.updates.push(state) }
  const dependencies = { configured: true, api }
  function Harness({ state }) {
    observed.hook = useCloudSync(state, setState, dependencies)
    return null
  }

  const root = createRoot(browser.createContainer())
  try {
    await act(async () => { root.render(React.createElement(Harness, { state: { games: [], roster: [], activeGameId: 'g_before' } })) })
    await act(async () => { root.render(React.createElement(Harness, { state: { games: [], roster: [], activeGameId: 'g_after_navigation' } })) })
    browser.listeners.get('online')()
    browser.documentListeners.get('visibilitychange')()
    assert.equal(fetchCalls, 1)

    gate.resolve({ people: [], games: [], gamePlayers: [], rounds: [] })
    await act(async () => { await gate.promise })

    assert.equal(observed.updates.at(-1).activeGameId, 'g_after_navigation')
    assert.equal(browser.listeners.has('online'), true)
    assert.equal(browser.documentListeners.has('visibilitychange'), true)
  } finally {
    await act(async () => { root.unmount() })
    assert.equal(browser.listeners.has('online'), false)
    assert.equal(browser.documentListeners.has('visibilitychange'), false)
    browser.restore()
  }
})

test('keeps a soft-delete mutation pending when the API rejects a zero-row update', async () => {
  const browser = browserHarness()
  const useCloudSync = await loadHook()
  const observed = { hook: null }
  const api = {
    fetchSnapshot: async () => ({ people: [], games: [], gamePlayers: [], rounds: [] }),
    fetchRowsUpdatedSince: async () => ({ people: [], games: [], gamePlayers: [], rounds: [] }),
    upsertRows: async () => {},
    softDelete: async () => { throw new Error('Supabase rounds: no rows matched') },
  }
  const dependencies = { configured: true, api }
  function Harness() {
    observed.hook = useCloudSync({ games: [], roster: [], activeGameId: null }, () => {}, dependencies)
    return null
  }

  const root = createRoot(browser.createContainer())
  try {
    await act(async () => { root.render(React.createElement(Harness)) })
    await act(async () => {
      observed.hook.enqueueStateMutation({
        id: 'm_zero_row',
        entity: 'rounds',
        entityId: 'r_missing',
        operation: 'softDelete',
        updatedAt: '2026-01-03T00:00:00.000Z',
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const stored = JSON.parse(globalThis.localStorage.getItem('gamescorer.cloud.v1'))
    assert.deepEqual(stored.outbox.map((mutation) => mutation.id), ['m_zero_row'])
    assert.equal(observed.hook.pendingCount, 1)
  } finally {
    await act(async () => { root.unmount() })
    browser.restore()
  }
})

test('mounts the hook safely in local mode when cloud is not configured', async () => {
  const browser = browserHarness()
  const useCloudSync = await loadHook()
  let hook
  function Harness() {
    hook = useCloudSync({ games: [], roster: [], activeGameId: null }, () => {})
    return null
  }
  const root = createRoot(browser.createContainer())
  try {
    await act(async () => { root.render(React.createElement(Harness)) })
    assert.equal(hook.status, 'local')
  } finally {
    await act(async () => { root.unmount() })
    browser.restore()
  }
})
