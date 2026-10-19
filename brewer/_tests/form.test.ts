import { describe, expect, it, vi } from 'vitest'

import { brewer } from '../index.js'
import { fromAnotherRealm } from './_realm.js'

const client = brewer('http://localhost')

describe('$formData', () => {
  it('builds a FormData any fetch sends as multipart', () => {
    expect(client.$formData({ caption: 'Rex' })).toBeInstanceOf(FormData)
  })

  it('sends text as it is, and a number or a boolean as the text the server reads back', () => {
    const form = client.$formData({ caption: 'Rex at the beach', age: 3, vaccinated: false })

    expect([...form]).toEqual([
      ['caption', 'Rex at the beach'],
      ['age', '3'],
      ['vaccinated', 'false'],
    ])
  })

  it('sends a file as a file part, under its own name and type', () => {
    const avatar = new File(['jpeg'], 'rex.jpg', { type: 'image/jpeg' })

    const part = client.$formData({ avatar }).get('avatar')

    expect(part).toBeInstanceOf(File)
    expect((part as File).name).toBe('rex.jpg')
    expect((part as File).type).toBe('image/jpeg')
  })

  it('sends each item of a list as a part under the same name, in order', () => {
    const one = new File(['1'], 'one.png')
    const two = new File(['2'], 'two.png')

    const form = client.$formData({ photos: [one, two], tags: ['calm', 'small'] })

    expect(form.getAll('photos').map(photo => (photo as File).name)).toEqual(['one.png', 'two.png'])
    expect(form.getAll('tags')).toEqual(['calm', 'small'])
  })

  it('leaves out a field given no value', () => {
    const form = client.$formData({ caption: 'Rex', avatar: undefined, note: null })

    expect([...form.keys()]).toEqual(['caption'])
  })

  // A file picked in an iframe is not this realm's. A browser's FormData takes it as a file all the same; Node's reads
  // a Blob by its prototype, so what is asserted is what reaches it.
  it('hands a file made in another realm to the form as it is, not as text', () => {
    const append = vi.spyOn(FormData.prototype, 'append')
    const avatar = fromAnotherRealm(new File(['jpeg'], 'rex.jpg', { type: 'image/jpeg' }))

    try {
      client.$formData({ avatar })

      expect(append).toHaveBeenCalledWith('avatar', avatar)
    } finally {
      append.mockRestore()
    }
  })
})
