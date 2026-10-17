declare const fields: unique symbol

/** What one part of a form holds: text, a number or a boolean sent as text, or a file. */
export type FormPart = string | number | boolean | Blob

/**
 * What {@link formData} builds a form from: per field, a part, or a list of parts sent under the field's name. A
 * field given `undefined` or `null` is left out.
 */
export type FormFields = Record<string, FormPart | readonly FormPart[] | null | undefined>

/**
 * A `FormData` that remembers the fields it was built from, so a call can check them against its route.
 *
 * Nothing of it exists at run time: it is a `FormData` like any other, and a plain one is assignable to it.
 */
export type FormDataOf<T> = FormData & { readonly [fields]?: T }

/**
 * A multipart form built from an object, its fields checked against the route it is sent to.
 *
 * An upload route takes a `FormData`, whose parts nothing checks, here or on a server that leaves an upload
 * unvalidated. A form built this way remembers its fields, and the call refuses one with a field missing or of the
 * wrong type:
 *
 * ```ts
 * await client.pets.photos.post({ body: formData({ caption: 'Rex', photo: file }) })
 * ```
 *
 * A list sends each of its items under the field's name, a number or a boolean goes as the text the server reads
 * back, and a field given `undefined` or `null` is left out. A plain `FormData` is still taken, unchecked.
 */
export function formData<T extends FormFields>(values: T): FormDataOf<T> {
  const form = new FormData()

  for (const [name, value] of Object.entries(values)) {
    for (const part of Array.isArray(value) ? value : [value]) {
      if (part !== undefined && part !== null) {
        form.append(name, part instanceof Blob ? part : String(part))
      }
    }
  }

  return form
}
