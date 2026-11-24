import './polyfill'
import { AudioInputSource, waitForEvenAppBridge, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { initialState, reduce, renderScreen, type Effect, type LensEvent, type LensState } from '@thruppence/core'
import { Companion } from './companion'
import { normalize, SwipeThrottle } from './input'
import { api, LensSocket, type Creds } from './net'
import { LensRenderer } from './renderer'
import { DeviceKey } from './signer'

const bridge: EvenAppBridge = await waitForEvenAppBridge()
let state: LensState = initialState(Date.now())
const renderer = new LensRenderer(bridge)
await renderer.start(renderScreen(state))

const companion = new Companion(document.getElementById('app')!)
const key = await DeviceKey.loadOrCreate(bridge)

async function loadCreds(): Promise<Creds> {
  const saved = await bridge.getLocalStorage('thruppence.creds').catch(() => '')
  if (saved) return JSON.parse(saved) as Creds
  const c = await api.register()
  await bridge.setLocalStorage('thruppence.creds', JSON.stringify(c))
  return c
}
const creds = await loadCreds()

let micOn = false
const throttle = new SwipeThrottle()
const socket = new LensSocket(
  () => ({ t: 'hello', deviceId: creds.deviceId, token: creds.token }),
  m => dispatch({ k: 'server', m }),
  up => companion.setOnline(up),
)

async function runEffect(e: Effect) {
  switch (e.k) {
    case 'send':
      socket.send(e.m)
      return
    case 'sign': {
      const boc = await key.signPay(e.params)
      socket.send({ t: 'signed', askId: e.params.askId, boc })
      return
    }
    case 'mic':
      micOn = e.on
      await bridge.audioControl(e.on, AudioInputSource.Glasses)
      return
    case 'exit':
      await bridge.shutDownPageContainer(1)
      return
  }
}

function dispatch(ev: LensEvent) {
  if (!throttle.pass(ev, Date.now())) return
  const out = reduce({ ...state, now: Date.now() }, ev)
  state = out.state
  renderer.render(renderScreen(state))
  companion.setLens(state)
  for (const e of out.effects) void runEffect(e).catch(err => console.warn('effect failed', e.k, err))
}

// Flash screens and the paying bar advance on a slow clock.
setInterval(() => dispatch({ k: 'tick', now: Date.now() }), 400)

// Microphone frames go out in ~100 ms batches while the ring is held.
let pcmParts: Uint8Array[] = []
let seq = 0
setInterval(() => {
  if (!pcmParts.length) return
  const total = pcmParts.reduce((n, p) => n + p.length, 0)
  const buf = new Uint8Array(total)
  let o = 0
  for (const p of pcmParts) {
    buf.set(p, o)
    o += p.length
  }
  pcmParts = []
  let bin = ''
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]!)
  socket.send({ t: 'audio', seq: seq++, pcm: btoa(bin) })
}, 100)

bridge.onEvenHubEvent(raw => {
  const n = normalize(raw as never)
  if (n.pcm && micOn) pcmParts.push(n.pcm)
  if (n.lifecycle === 'foreground') socket.ensure()
  for (const ev of n.lens) dispatch(ev)
})

bridge.onDeviceStatusChanged(st => {
  if (typeof st.isWearing === 'boolean') dispatch({ k: 'wearing', on: st.isWearing })
})

companion.start(creds, key.publicHex)
socket.open()
