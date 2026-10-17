import { describe, expect, it } from 'vitest'

import { formData } from '../index.js'

describe('formData', () => {
  it('builds a FormData any fetch sends as multipart', () => {
    expect(formData({ caption: 'Rex' })).toBeInstanceOf(FormData)
  })

  it('sends text as it is, and a number or a boolean as the text the server reads back', () => {
    const form = formData({ caption: 'Rex at the beach', age: 3, vaccinated: false })

    expect([...form]).toEqual([
      ['caption', 'Rex at the beach'],
      ['age', '3'],
      ['vaccinated', 'false'],
    ])
  })

  it('sends a file as a file part, under its own name and type', () => {
    const avatar = new File(['jpeg'], 'rex.jpg', { type: 'image/jpeg' })

    const part = formData({ avatar }).get('avatar')

    expect(part).toBeInstanceOf(File)
    expect((part as File).name).toBe('rex.jpg')
    expect((part as File).type).toBe('image/jpeg')
  })

  it('sends each item of a list as a part under the same name, in order', () => {
    const one = new File(['1'], 'one.png')
    const two = new File(['2'], 'two.png')

    const form = formData({ photos: [one, two], tags: ['calm', 'small'] })

    expect(form.getAll('photos').map(photo => (photo as File).name)).toEqual(['one.png', 'two.png'])
    expect(form.getAll('tags')).toEqual(['calm', 'small'])
  })

  it('leaves out a field given no value', () => {
    const form = formData({ caption: 'Rex', avatar: undefined, note: null })

    expect([...form.keys()]).toEqual(['caption'])
  })
})
