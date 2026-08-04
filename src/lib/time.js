export function parseTimestamp(value) {
  if (value === null || value === undefined || value === '') return null
  const numeric = Number(value)
  if (Number.isFinite(numeric)) return numeric
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : null
}

function compareIds(firstId, secondId) {
  const first = String(firstId ?? '')
  const second = String(secondId ?? '')
  return first === second ? 0 : first < second ? -1 : 1
}

export function compareUpdatedAt(first, second) {
  const firstTime = parseTimestamp(first?.updatedAt)
  const secondTime = parseTimestamp(second?.updatedAt)
  if (firstTime !== null && secondTime !== null && firstTime !== secondTime) return secondTime - firstTime
  if (firstTime === null && secondTime !== null) return 1
  if (firstTime !== null && secondTime === null) return -1
  return compareIds(first?.id, second?.id)
}
