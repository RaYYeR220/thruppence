import { Buffer } from 'buffer'

// @ton/core expects Node's Buffer in the browser.
const g = globalThis as unknown as { Buffer?: typeof Buffer }
if (!g.Buffer) g.Buffer = Buffer
