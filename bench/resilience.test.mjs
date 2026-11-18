import test from 'node:test'
import assert from 'node:assert/strict'
import { Breaker, Cache, withRetry } from '../provider/resilience.mjs'
import { FAILURE, SearchFailure, failureFor } from '../provider/backend.mjs'

const fakeClock = (start = 1_000) => {
  let now = start
  return { now: () => now, advance: (ms) => (now += ms) }
}

test('the breaker opens after three consecutive failures and closes again after the cooldown', () => {
  const clock = fakeClock()
  const breaker = new Breaker({ threshold: 3, cooldownMs: 60_000, now: clock.now })
  assert.equal(breaker.allows('x'), true)
  breaker.failure('x')
  breaker.failure('x')
  assert.equal(breaker.allows('x'), true, 'two failures are not enough')
  breaker.failure('x')
  assert.equal(breaker.allows('x'), false)
  assert.deepEqual(breaker.open(), ['x'])
  clock.advance(59_999)
  assert.equal(breaker.allows('x'), false)
  clock.advance(2)
  assert.equal(breaker.allows('x'), true, 'the cooldown reopens the circuit')
  assert.deepEqual(breaker.open(), [])
})

test('a success resets the failure count', () => {
  const breaker = new Breaker({ threshold: 2, cooldownMs: 1000, now: () => 0 })
  breaker.failure('x')
  breaker.success('x')
  breaker.failure('x')
  assert.equal(breaker.allows('x'), true)
})

test('a rate limit opens the circuit on the first failure', () => {
  const breaker = new Breaker({ threshold: 3, cooldownMs: 60_000, now: () => 0 })
  breaker.failure('x', true)
  assert.equal(breaker.allows('x'), false)
})

test('the cache answers, expires and stays bounded', () => {
  const clock = fakeClock()
  const cache = new Cache({ ttlMs: 1000, entries: 2, now: clock.now })
  cache.set('a', { sources: ['one'] })
  assert.deepEqual(cache.get('a'), { sources: ['one'] })
  clock.advance(999)
  assert.deepEqual(cache.get('a'), { sources: ['one'] })
  clock.advance(2)
  assert.equal(cache.get('a'), undefined, 'an expired entry is not served')

  cache.set('b', 1)
  cache.set('c', 2)
  cache.set('d', 3)
  assert.equal(cache.size, 2)
  assert.equal(cache.get('b'), undefined, 'the oldest entry was evicted')
  assert.equal(cache.get('d'), 3)
})

test('a read refreshes recency so the bound evicts the least recently used entry', () => {
  const cache = new Cache({ ttlMs: 10_000, entries: 2, now: () => 0 })
  cache.set('a', 1)
  cache.set('b', 2)
  cache.get('a')
  cache.set('c', 3)
  assert.equal(cache.get('a'), 1, 'a was read, so it survives')
  assert.equal(cache.get('b'), undefined)
})

test('a transient server error is retried once, and a success returns without a retry', async () => {
  let calls = 0
  const value = await withRetry(
    async () => {
      calls += 1
      if (calls === 1) throw new SearchFailure('x', 'unavailable (HTTP 503)', { kind: FAILURE.server, status: 503 })
      return 'ok'
    },
    { attempts: 2, delayMs: 1 },
  )
  assert.equal(value, 'ok')
  assert.equal(calls, 2)

  let clean = 0
  await withRetry(async () => {
    clean += 1
    return 'ok'
  }, { attempts: 2, delayMs: 1 })
  assert.equal(clean, 1, 'a successful call pays nothing')
})

test('a rate limit or a spent quota is not retried: the breaker handles it instead', async () => {
  for (const kind of [FAILURE.rateLimit, FAILURE.quota, FAILURE.auth]) {
    let calls = 0
    await assert.rejects(
      withRetry(async () => {
        calls += 1
        throw new SearchFailure('x', kind, { kind, status: 429 })
      }, { attempts: 2, delayMs: 1 }),
    )
    assert.equal(calls, 1, `${kind} should not be retried`)
  }
})

test('HTTP failures carry a kind the retry and breaker logic can act on', () => {
  assert.equal(failureFor('x', 429, {}).kind, FAILURE.rateLimit)
  assert.equal(failureFor('x', 402, {}).kind, FAILURE.quota)
  assert.equal(failureFor('x', 401, {}).kind, FAILURE.auth)
  assert.equal(failureFor('x', 503, {}).kind, FAILURE.server)
})

test('a failure body is never echoed for auth and quota answers', () => {
  // One anonymous tier answers 402 with a freshly generated account and password. That text
  // must not reach a log or the model's context.
  const body = { message: 'Your account and API key have been automatically generated. username=as_auto_x password=hunter2' }
  for (const status of [401, 402, 403]) {
    const message = failureFor('anysearch', status, body).message
    assert.equal(message.includes('hunter2'), false, `${status} leaked the body`)
    assert.equal(message.includes('as_auto_x'), false)
  }
  // A 429 body is worth keeping: it usually names the limit.
  assert.match(failureFor('exa', 429, { message: 'rate limit exceeded' }).message, /rate limit exceeded/)
})
