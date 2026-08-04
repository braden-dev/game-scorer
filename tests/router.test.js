import test from 'node:test'
import assert from 'node:assert/strict'
import { navigate, readRoute, subscribeToRoutes } from '../src/lib/router.js'

test('readRoute recognizes scorebook pages and ignores the GitHub Pages base path', () => {
  assert.deepEqual(readRoute('/GameScorer/people'), { type: 'people' })
  assert.deepEqual(readRoute('/GameScorer/people/person_1'), { type: 'person', id: 'person_1' })
  assert.deepEqual(readRoute('/GameScorer/leaderboard'), { type: 'leaderboard' })
  assert.deepEqual(readRoute('/GameScorer/games'), { type: 'games' })
  assert.deepEqual(readRoute('/GameScorer/games/game_1'), { type: 'game', id: 'game_1' })
  assert.deepEqual(readRoute('/GameScorer/new-game/farkle'), { type: 'new-game', gameId: 'farkle' })
  assert.deepEqual(readRoute('/GameScorer/not-a-page'), { type: 'home' })
})

test('navigate updates browser history and notifies route subscribers', () => {
  const events = []
  const priorWindow = globalThis.window
  const handlers = new Map()
  globalThis.window = {
    location: { pathname: '/' },
    history: {
      pushState(_state, _title, pathname) {
        this.pathname = pathname
        globalThis.window.location.pathname = pathname
      },
    },
    addEventListener(type, handler) { handlers.set(type, handler) },
    removeEventListener(type) { handlers.delete(type) },
    dispatchEvent(event) { handlers.get(event.type)?.(event) },
  }

  const unsubscribe = subscribeToRoutes((route) => events.push(route))
  navigate({ type: 'people' })
  unsubscribe()
  globalThis.window = priorWindow

  assert.deepEqual(events, [{ type: 'people' }])
})
