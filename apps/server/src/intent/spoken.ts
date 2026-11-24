/**
 * Rewrites small spoken numbers into digits so that "send me twenty for the
 * taxi" and "скинь полтора" are grounded the same way "send me 20" is.
 * Deliberately small: amounts people ask friends for, not general parsing.
 */

const EN_UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
}
const EN_TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 }

const RU: Record<string, number> = {
  ноль: 0, один: 1, одну: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10,
  одиннадцать: 11, двенадцать: 12, пятнадцать: 15, двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50, сто: 100,
}

export function spokenToDigits(input: string): string {
  let t = input
  t = t.replace(/\bone and a half\b/gi, '1.5').replace(/\b(a|one) half\b/gi, '0.5').replace(/\bhalf a\b/gi, '0.5')
  t = t.replace(/полтора|полторы/gi, '1.5')
  t = t.replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[\s-]+(one|two|three|four|five|six|seven|eight|nine)\b/gi, (_, a: string, b: string) =>
    String(EN_TENS[a.toLowerCase()]! + EN_UNITS[b.toLowerCase()]!),
  )
  t = t.replace(/\b(\w+) hundred\b/gi, (m, a: string) => (a.toLowerCase() in EN_UNITS ? String(EN_UNITS[a.toLowerCase()]! * 100) : m))
  t = t.replace(/\b[a-z]+\b/gi, w => {
    const k = w.toLowerCase()
    if (k in EN_UNITS) return String(EN_UNITS[k])
    if (k in EN_TENS) return String(EN_TENS[k])
    return w
  })
  t = t.replace(/[а-яё]+/gi, w => (w.toLowerCase() in RU ? String(RU[w.toLowerCase()]) : w))
  return t
}
