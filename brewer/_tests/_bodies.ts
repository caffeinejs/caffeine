/** Every byte value, in order: a body re-encoded as text anywhere along the way would not survive it. */
export const everyByte = Uint8Array.from({ length: 256 }, (_, i) => i)

/**
 * A body of every kind a call sends as it is or as JSON, made anew for each call.
 *
 * Forms are left out: their bytes carry a boundary drawn anew for every encoding, so they are compared part by part.
 */
export const bodies: ReadonlyArray<readonly [string, () => unknown]> = [
  ['a JSON object', () => ({ name: 'Rex', tags: ['calm', 'ünïcödé'], age: 3 })],
  ['text beyond ASCII', () => 'Zoë paid 12 € for the café ☕'],
  ['bytes of every value', () => everyByte.slice()],
  ['a slice of a larger buffer', () => new Uint8Array(everyByte.buffer, 16, 32)],
  ['a Blob with a type', () => new Blob([everyByte], { type: 'image/png' })],
  ['a URLSearchParams form', () => new URLSearchParams({ name: 'Rex', note: 'a & b = c' })],
]

/** A profile upload: text fields, two files, and a file name beyond ASCII. */
export function profileForm(): FormData {
  const form = new FormData()
  form.append('caption', 'Rex at the café')
  form.append('photos', new File([everyByte], 'crème brûlée.png', { type: 'image/png' }))
  form.append('photos', new File(['%PDF-1.7 adoption papers'], 'adoption.pdf', { type: 'application/pdf' }))

  return form
}
