import { useEffect, useRef } from 'react'

export default function UndoToast({ message, onUndo, onExpire, durationMs = 10_000 }) {
  const expireRef = useRef(onExpire)
  expireRef.current = onExpire

  useEffect(() => {
    const timer = setTimeout(() => expireRef.current?.(), durationMs)
    return () => clearTimeout(timer)
  }, [durationMs])

  return (
    <div className="undo-toast" role="status" aria-live="polite">
      <span>{message}</span>
      <button type="button" className="btn ghost" onClick={onUndo}>Undo</button>
    </div>
  )
}
