import test from 'node:test'
import assert from 'node:assert/strict'
import { fuse, normaliseUrl, quality, titleKey } from '../provider/fusion.mjs'

const source = (url, title, extra = {}) => ({ url, title, ...extra })
const entries = (...lists) => lists.map(([id, sources, trust]) => ({ id, sources, trust }))

test('URL normalisation folds scheme, www, tracking parameters and trailing slashes', () => {
  assert.equal(normaliseUrl('https://www.Example.com/a/?utm_source=x&id=7'), 'example.com/a?id=7')
  assert.equal(normaliseUrl('http://example.com/a/#frag'), 'example.com/a')
  assert.equal(normaliseUrl('not a url'), 'not a url')
})

test('the same page from two backends is reported once, and both are credited', () => {
  const result = fuse(
    entries(
      ['a', [source('https://example.com/x', 'X', { snippet: 'about x' })]],
      ['b', [source('https://www.example.com/x/?utm_medium=y', 'X page', { snippet: 'about x' })]],
    ),
    5,
  )
  assert.equal(result.sources.length, 1)
  assert.equal(result.sources[0].url, 'https://example.com/x')
  assert.deepEqual(result.contributed, { a: 1, b: 1 })
})

test('a page with the same title on the same host collapses even when the URL differs', () => {
  const result = fuse(
    entries(['a', [source('https://site.dev/post/1', 'How to build a thing')]], ['b', [source('https://site.dev/post/1?ref=hn', 'How to build a thing')]]),
    5,
  )
  assert.equal(result.sources.length, 1)
})

test('the same title on different hosts is not collapsed without snippet evidence', () => {
  const result = fuse(
    entries(
      ['a', [source('https://one.dev/x', 'Weekly roundup', { snippet: 'alpha beta gamma' })]],
      ['b', [source('https://two.dev/y', 'Weekly roundup', { snippet: 'delta epsilon zeta' })]],
    ),
    5,
  )
  assert.equal(result.sources.length, 2)
})

test('a matching snippet collapses the same story across hosts', () => {
  const snippet = 'a long enough shared sentence about the same release'
  const result = fuse(
    entries(
      ['a', [source('https://one.dev/x', 'Weekly roundup', { snippet })]],
      ['b', [source('https://two.dev/y', 'Weekly roundup', { snippet })]],
    ),
    5,
  )
  assert.equal(result.sources.length, 1)
})

test('trust decides who wins when the chains are otherwise equal', () => {
  const list = entries(
    ['low', [source('https://low.dev/a', 'A result', { snippet: 'one' })]],
    ['high', [source('https://high.dev/b', 'B result', { snippet: 'two' })]],
  )
  assert.equal(fuse(list, 1, { weights: { low: 0.5, high: 1 } }).sources[0].url, 'https://high.dev/b')
  assert.equal(fuse(list, 1, { weights: { low: 1, high: 0.5 } }).sources[0].url, 'https://low.dev/a')
})

test('rank fusion favours agreement: three list-second places beat one list-first place', () => {
  // This is the documented trade of RRF, not an accident: a page several backends agree on
  // is likelier to be the page the reader wanted than a page only one backend ranks first.
  const shared = source('https://agreed.dev/a', 'Agreed page', { snippet: 'shared' })
  const solo = source('https://solo.dev/b', 'Solo page', { snippet: 'alone' })
  const filler = (n) => [source(`https://filler.dev/${n}`, `Filler ${n}`, { snippet: `filler ${n}` }), shared]
  const list = entries(['a', [solo]], ['b', filler(1)], ['c', filler(2)], ['d', filler(3)])
  assert.equal(fuse(list, 1).sources[0].url, 'https://agreed.dev/a')
  // A backend heavy enough to outweigh the other three flips it, which is what weights are for.
  assert.equal(fuse(list, 1, { weights: { a: 6, b: 0.2, c: 0.2, d: 0.2 } }).sources[0].url, 'https://solo.dev/b')
})

test('an address used as a title is down-weighted, never dropped', () => {
  assert.equal(quality(source('https://x.dev/a', 'example.com/page')), 0.6)
  assert.equal(quality(source('https://x.dev/b', '')), 0.5)
  assert.equal(quality(source('https://x.dev/c', 'Real title here')), 1)
  const result = fuse(entries(['a', [source('https://x.dev/a', 'example.com/page')]]), 5)
  assert.equal(result.sources.length, 1)
})

test('titles lose trailing site suffixes and markup before comparison', () => {
  assert.equal(titleKey('Install dsh | DeepSeek'), 'install dsh')
  assert.equal(titleKey('[Guide](https://x.dev) - Site'), 'guide')
})

test('a zero weight removes a backend from the result without breaking the call', () => {
  const result = fuse(
    entries(['a', [source('https://a.dev/x', 'A')]], ['b', [source('https://b.dev/y', 'B')]]),
    5,
    { weights: { b: 0 } },
  )
  assert.deepEqual(
    result.sources.map((item) => item.url),
    ['https://a.dev/x'],
  )
})

test('no answers at all is an empty result, not a crash', () => {
  assert.deepEqual(fuse([], 5), { sources: [], merged: 0, contributed: {} })
  assert.deepEqual(fuse(entries(['a', []]), 5), { sources: [], merged: 0, contributed: {} })
})
