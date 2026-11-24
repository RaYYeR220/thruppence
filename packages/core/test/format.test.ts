import { describe, expect, it } from 'vitest'
import { formatGram, parseGram, shortAddr } from '../src/format'

describe('formatGram', () => {
  it.each([
    ['25000000000', '25'],
    ['500000000', '0.5'],
    ['1250750000000', '1,250.75'],
    ['1999999999', '1.99'],
    ['1000000', '0.001'],
    ['0', '0'],
  ])('%s → %s', (nano, out) => expect(formatGram(nano)).toBe(out))
})

describe('parseGram', () => {
  it.each([
    ['25', '25000000000'],
    ['0.5', '500000000'],
    ['12,5', '12500000000'],
    ['1,250.75', '1250750000000'],
  ])('%s → %s', (t, nano) => expect(parseGram(t)).toBe(nano))
  it.each(['', 'abc', '-5', '0', '1.2.3'])('rejects %j', t => expect(parseGram(t)).toBeNull())
})

describe('shortAddr', () => {
  it('keeps head and tail', () => expect(shortAddr('UQAbcdefghijklmnopf3a2')).toBe('UQAb…f3a2'))
})
