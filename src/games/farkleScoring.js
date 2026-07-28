/**
 * Farkle dice scoring engine.
 *
 * `counts` is a 7-length array where counts[face] = how many dice show that
 * face (index 0 unused). Returns the highest-scoring interpretation of the
 * dice, preferring the combination that uses the most dice when two
 * interpretations tie — that matters for "hot dice" (all six scoring).
 */

const KEYS = (counts) => counts.slice(1).join('')

function nOfAKindValue(face, n, settings) {
  const base = face === 1 ? 1000 : face * 100
  if (n === 3) return base
  if (settings.multiRule === 'double') {
    // Each die beyond the third doubles the triple's value.
    return base * Math.pow(2, n - 3)
  }
  // Fixed variant: 4 / 5 / 6 of a kind are flat amounts, any face.
  return { 4: 1000, 5: 2000, 6: 3000 }[n] ?? 0
}

function isStraight(counts) {
  for (let f = 1; f <= 6; f++) if (counts[f] !== 1) return false
  return true
}

function threePairs(counts) {
  let pairs = 0
  for (let f = 1; f <= 6; f++) {
    if (counts[f] % 2 !== 0) return false
    pairs += counts[f] / 2
  }
  return pairs === 3
}

function twoTriplets(counts) {
  let triplets = 0
  for (let f = 1; f <= 6; f++) {
    if (counts[f] === 3) triplets++
    else if (counts[f] !== 0) return false
  }
  return triplets === 2
}

function totalDice(counts) {
  let t = 0
  for (let f = 1; f <= 6; f++) t += counts[f]
  return t
}

/**
 * @returns {{score: number, dice: number}} best score and how many dice it consumed.
 */
export function scoreDice(counts, settings) {
  const memo = new Map()

  function best(c) {
    const key = KEYS(c)
    if (memo.has(key)) return memo.get(key)

    const left = totalDice(c)
    let result = { score: 0, dice: 0 }
    if (left === 0) {
      memo.set(key, result)
      return result
    }

    const consider = (score, dice) => {
      if (score > result.score || (score === result.score && dice > result.dice)) {
        result = { score, dice }
      }
    }

    // Whole-set combinations (only valid on the full six dice).
    if (left === 6) {
      if (isStraight(c) && settings.straight > 0) consider(settings.straight, 6)
      if (threePairs(c) && settings.threePairs > 0) consider(settings.threePairs, 6)
      if (twoTriplets(c) && settings.twoTriplets > 0) consider(settings.twoTriplets, 6)
    }

    // N-of-a-kind, for every face and every valid size.
    for (let f = 1; f <= 6; f++) {
      for (let n = 3; n <= c[f]; n++) {
        const next = c.slice()
        next[f] -= n
        const rest = best(next)
        consider(nOfAKindValue(f, n, settings) + rest.score, n + rest.dice)
      }
    }

    // Loose 1s and 5s.
    if (c[1] > 0) {
      const next = c.slice()
      next[1] -= 1
      const rest = best(next)
      consider(100 + rest.score, 1 + rest.dice)
    }
    if (c[5] > 0) {
      const next = c.slice()
      next[5] -= 1
      const rest = best(next)
      consider(50 + rest.score, 1 + rest.dice)
    }

    memo.set(key, result)
    return result
  }

  return best(counts.slice())
}

/** Human-readable breakdown of the best interpretation, for the calculator UI. */
export function describeDice(counts, settings) {
  const parts = []
  const c = counts.slice()
  const rolled = totalDice(c)

  if (rolled === 6) {
    if (isStraight(c) && settings.straight > 0) return [{ label: 'Straight 1-2-3-4-5-6', points: settings.straight }]
    if (twoTriplets(c) && settings.twoTriplets > 0) {
      const faces = []
      for (let f = 1; f <= 6; f++) if (c[f] === 3) faces.push(f)
      const alt = scoreDice(c, settings)
      if (settings.twoTriplets >= alt.score) {
        return [{ label: `Two triplets (${faces.join('s & ')}s)`, points: settings.twoTriplets }]
      }
    }
    if (threePairs(c) && settings.threePairs > 0) {
      const alt = bestWithoutWholeSets(c, settings)
      if (settings.threePairs >= alt) return [{ label: 'Three pairs', points: settings.threePairs }]
    }
  }

  // Greedily mirror the recursive search for a readable breakdown.
  let guard = 0
  while (totalDice(c) > 0 && guard++ < 12) {
    let bestMove = null
    for (let f = 1; f <= 6; f++) {
      for (let n = 3; n <= c[f]; n++) {
        const next = c.slice()
        next[f] -= n
        const value = nOfAKindValue(f, n, settings) + scoreDice(next, settings).score
        if (!bestMove || value > bestMove.value) {
          bestMove = { value, face: f, n, label: `${n} × ${f}s`, points: nOfAKindValue(f, n, settings) }
        }
      }
    }
    if (c[1] > 0) {
      const next = c.slice()
      next[1] -= 1
      const value = 100 + scoreDice(next, settings).score
      if (!bestMove || value > bestMove.value) bestMove = { value, face: 1, n: 1, label: 'Single 1', points: 100 }
    }
    if (c[5] > 0) {
      const next = c.slice()
      next[5] -= 1
      const value = 50 + scoreDice(next, settings).score
      if (!bestMove || value > bestMove.value) bestMove = { value, face: 5, n: 1, label: 'Single 5', points: 50 }
    }
    if (!bestMove) break
    c[bestMove.face] -= bestMove.n
    parts.push({ label: bestMove.label, points: bestMove.points })
  }

  const leftover = totalDice(c)
  if (leftover > 0) parts.push({ label: `${leftover} non-scoring ${leftover === 1 ? 'die' : 'dice'}`, points: 0 })
  return parts
}

function bestWithoutWholeSets(counts, settings) {
  return scoreDice(counts, { ...settings, straight: 0, threePairs: 0, twoTriplets: 0 }).score
}
