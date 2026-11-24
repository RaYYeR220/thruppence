/**
 * Rewrites spoken numbers into digits so that "send me twenty-five for the
 * taxi", "скинь двадцать пять", "خمسة عشر" and "treinta y cinco" are grounded
 * the same way "25" is. Deliberately small: amounts people ask friends for.
 */

const EN: Record<string, number> = {
  zero: 0, one: 1, a: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
}

const RU: Record<string, number> = {
  ноль: 0, один: 1, одну: 1, одна: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10,
  одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14, пятнадцать: 15, шестнадцать: 16, семнадцать: 17,
  восемнадцать: 18, девятнадцать: 19, двадцать: 20, тридцать: 30, сорок: 40, пятьдесят: 50, шестьдесят: 60, семьдесят: 70,
  восемьдесят: 80, девяносто: 90, сто: 100, сотку: 100, двести: 200, триста: 300,
}

const AR: Record<string, number> = {
  واحد: 1, اثنين: 2, اثنان: 2, ثلاثة: 3, ثلاث: 3, أربعة: 4, اربعة: 4, أربع: 4, خمسة: 5, خمس: 5, ستة: 6, سبعة: 7, ثمانية: 8, تسعة: 9,
  عشرة: 10, عشر: 10, عشرين: 20, عشرون: 20, ثلاثين: 30, أربعين: 40, اربعين: 40, خمسين: 50, ستين: 60, سبعين: 70, ثمانين: 80, تسعين: 90,
  مية: 100, مائة: 100, مئة: 100, ميتين: 200,
}

const ES: Record<string, number> = {
  uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciséis: 16, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
  veinte: 20, veintiuno: 21, veintidós: 22, veintidos: 22, veintitrés: 23, veintitres: 23, veinticuatro: 24, veinticinco: 25,
  veintiséis: 26, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
  treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90, cien: 100, ciento: 100,
}

// A number that came from words, so it can be merged with its neighbours.
const OPEN = '⁣'
const CLOSE = '⁤'
const tok = (n: number) => `${OPEN}${n}${CLOSE}`

/** Joins adjacent word-numbers into one: 20 5 → 25, 5 10 → 15 (Arabic teens), 5 20 → 25, 100 20 → 120, 2 100 → 200. */
function mergeTokens(t: string): string {
  const pair = new RegExp(`${OPEN}(\\d+)${CLOSE}[\\s-]*(?:and|y|и|و)?[\\s-]*${OPEN}(\\d+)${CLOSE}`, 'i')
  for (let i = 0; i < 6; i++) {
    const next = t.replace(pair, (m, x: string, y: string) => {
      const a = Number(x)
      const b = Number(y)
      if (a >= 20 && a < 100 && a % 10 === 0 && b > 0 && b < 10) return tok(a + b)
      if (a > 0 && a < 10 && b === 10) return tok(a + 10)
      if (a > 0 && a < 10 && b >= 20 && b < 100 && b % 10 === 0) return tok(a + b)
      if (a % 100 === 0 && a >= 100 && b > 0 && b < 100) return tok(a + b)
      if (a > 0 && a < 10 && b === 100) return tok(a * 100)
      return m.replace(OPEN + y + CLOSE, `${OPEN}${y}${CLOSE}`).replace(`${OPEN}${x}${CLOSE}`, `${x}`)
    })
    if (next === t) break
    t = next
  }
  return t.replaceAll(OPEN, '').replaceAll(CLOSE, '')
}

export function spokenToDigits(input: string): string {
  // Arabic-Indic and Eastern Arabic digits → 0-9; Arabic decimal separator → point.
  let t = input
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.')
  t = t.replace(/\bone and a half\b/gi, '1.5').replace(/\b(a|one) half\b/gi, '0.5').replace(/\bhalf a\b/gi, '0.5')
  t = t.replace(/полтора|полторы/gi, '1.5').replace(/полтинник/gi, '50')
  // "a" is a number only right before "hundred" ("a hundred and twenty").
  t = t.replace(/\ba(?=\s+hundred\b)/gi, tok(1))
  t = t.replace(/\b[a-z]+\b/gi, w => {
    const k = w.toLowerCase()
    return k !== 'a' && k in EN ? tok(EN[k]!) : w
  })
  t = t.replace(/[а-яё]+/gi, w => (w.toLowerCase() in RU ? tok(RU[w.toLowerCase()]!) : w))
  t = t.replace(/[؀-ۿ]+/g, w => {
    const bare = w.replace(/^(و|ب)/, '')
    return w in AR ? tok(AR[w]!) : bare in AR ? tok(AR[bare]!) : w
  })
  t = t.replace(/[a-záéíóúñ]+/gi, w => (w.toLowerCase() in ES ? tok(ES[w.toLowerCase()]!) : w))
  // "1 hundred" written as "one hundred" → 100 before merging the rest.
  t = t.replace(new RegExp(`${OPEN}(\\d)${CLOSE}\\s+${OPEN}100${CLOSE}`, 'g'), (_, d: string) => tok(Number(d) * 100))
  return mergeTokens(t)
}
