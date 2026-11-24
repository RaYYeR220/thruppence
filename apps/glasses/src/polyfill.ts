import { Buffer } from 'buffer'

// @ton/core expects Node's Buffer; the Even app WebView does not have one.
const g = globalThis as unknown as { Buffer?: typeof Buffer }
if (!g.Buffer) g.Buffer = Buffer
