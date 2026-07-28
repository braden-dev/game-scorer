import { useEffect, useState } from 'react'

export function isStandalone() {
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  )
}

export function isIos() {
  const ua = window.navigator.userAgent
  // iPadOS 13+ claims to be a Mac; the touch points give it away.
  return (
    /iphone|ipad|ipod/i.test(ua) ||
    (/Macintosh/.test(ua) && window.navigator.maxTouchPoints > 1)
  )
}

/**
 * Chromium fires `beforeinstallprompt` and lets us trigger the install sheet
 * ourselves. Safari has no equivalent — there we fall back to telling the user
 * where the Add to Home Screen button lives.
 */
export function useInstallPrompt() {
  const [deferred, setDeferred] = useState(null)
  const [installed, setInstalled] = useState(isStandalone)

  useEffect(() => {
    const onPrompt = (e) => {
      e.preventDefault()
      setDeferred(e)
    }
    const onInstalled = () => {
      setInstalled(true)
      setDeferred(null)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  const install = async () => {
    if (!deferred) return false
    deferred.prompt()
    const { outcome } = await deferred.userChoice
    setDeferred(null)
    return outcome === 'accepted'
  }

  return { canInstall: Boolean(deferred), install, installed }
}
