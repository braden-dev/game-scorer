import { useEffect } from 'react'

/**
 * Holds a screen wake lock while `active` is true, so the phone doesn't dim
 * mid-game. The lock is dropped by the OS whenever the tab is backgrounded,
 * so we re-request it on every return to visibility.
 *
 * Silently does nothing where unsupported (iOS < 16.4, or installed PWAs on
 * iOS < 18.4, where the API existed but was broken).
 */
export function useWakeLock(active) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return

    let lock = null
    let released = false

    const acquire = async () => {
      if (released || document.visibilityState !== 'visible') return
      try {
        lock = await navigator.wakeLock.request('screen')
      } catch {
        // Denied, battery saver, or unsupported — not worth interrupting a game over.
      }
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') acquire()
    }

    acquire()
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      released = true
      document.removeEventListener('visibilitychange', onVisibilityChange)
      lock?.release().catch(() => {})
    }
  }, [active])
}
