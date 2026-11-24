import { describe, expect, it } from 'vitest'
import { spokenToDigits } from '../../src/intent/spoken'
import { isGrounded } from '../../src/intent/validate'

describe('spokenToDigits', () => {
  it.each([
    ['send me thirty-five for the cab', 'send me 35 for the cab'],
    ['it was a hundred and forty', 'it was 140'],
    ['one hundred bucks', '100 bucks'],
    ['скинь сорок семь за билеты', 'скинь 47 за билеты'],
    ['ممكن ترسل سبعة عشر', 'ممكن ترسل 17'],
    ['ابعث خمسة وعشرين', 'ابعث 25'],
    ['mándame cuarenta y dos', 'mándame 42'],
    ['son veintitrés', 'son 23'],
    ['٢٥ تون', '25 تون'],
  ])('%s', (input, out) => expect(spokenToDigits(input)).toBe(out))

  it('keeps separate digits apart', () => {
    expect(spokenToDigits('2 x 20 TON')).toBe('2 x 20 TON')
    expect(spokenToDigits('a coffee and a cake')).toBe('a coffee and a cake')
  })
})

describe('shares in words', () => {
  it('a quarter or a third of a stated total', () => {
    expect(isGrounded(35, 'lunch was a hundred and forty, your quarter please')).toBe(true)
    expect(isGrounded(12, 'такси 36, твоя треть')).toBe(true)
  })
})
