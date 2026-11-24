/**
 * A lens page is a pure description of what the G2 shows: absolutely
 * positioned boxes on a 576×288 canvas. The glasses renderer maps it onto
 * Even Hub containers; the web renderer draws it on a canvas. Nothing here
 * imports the SDK.
 */
export const LENS_W = 576
export const LENS_H = 288
export const LINE_H = 27

/** Brightness levels supported by the firmware (0 = off … 4 = full). */
export type Brightness = 0 | 1 | 2 | 3 | 4

interface BoxBase {
  /** Unique, ≤16 chars (Even Hub containerName). */
  name: string
  x: number
  y: number
  w: number
  h: number
  /** Exactly one box per page captures input. */
  capture?: boolean
}

export interface TextBox extends BoxBase {
  type: 'text'
  content: string
  brightness: Brightness
  border?: { width: number; brightness: Brightness; radius: number }
  padding?: number
}

export interface ListBox extends BoxBase {
  type: 'list'
  items: string[]
  selected: number
}

export type ImageSpec =
  | { kind: 'amount'; value: string; unit: string }
  | { kind: 'mark'; mark: 'check' | 'cross' }

export interface ImageBox extends BoxBase {
  type: 'image'
  spec: ImageSpec
}

export type Box = TextBox | ListBox | ImageBox

export interface LensPage {
  /** Stable id of the layout; same id ⇒ same box geometry, so text can be upgraded in place. */
  layout: string
  boxes: Box[]
}

export function validatePage(page: LensPage): string[] {
  const errs: string[] = []
  const texts = page.boxes.filter(b => b.type !== 'image').length
  const images = page.boxes.filter(b => b.type === 'image').length
  if (page.boxes.length < 1 || page.boxes.length > 12) errs.push(`containers ${page.boxes.length} not in 1..12`)
  if (texts > 8) errs.push(`text/list containers ${texts} > 8`)
  if (images > 4) errs.push(`image containers ${images} > 4`)
  const caps = page.boxes.filter(b => b.capture).length
  if (caps !== 1) errs.push(`capture containers ${caps} != 1`)
  const names = new Set<string>()
  for (const b of page.boxes) {
    if (b.name.length > 16) errs.push(`name too long: ${b.name}`)
    if (names.has(b.name)) errs.push(`duplicate name: ${b.name}`)
    names.add(b.name)
    if (b.x < 0 || b.y < 0 || b.x + b.w > LENS_W || b.y + b.h > LENS_H) errs.push(`out of bounds: ${b.name}`)
    if (b.type === 'image') {
      if (b.w < 20 || b.w > 288 || b.h < 20 || b.h > 144) errs.push(`image size invalid: ${b.name}`)
      if (b.capture) errs.push(`image cannot capture: ${b.name}`)
    }
    if (b.type === 'list') {
      if (b.items.length > 20) errs.push(`list too long: ${b.name}`)
      for (const it of b.items) if (new TextEncoder().encode(it).length > 63) errs.push(`list item too long: ${it}`)
    }
    if (b.type === 'text' && b.content.length > 1000) errs.push(`text too long: ${b.name}`)
  }
  return errs
}
