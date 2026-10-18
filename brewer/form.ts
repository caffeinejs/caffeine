declare const fields: unique symbol
declare const names: unique symbol

/** What one part of a form holds: text, a number or a boolean sent as text, or a file. */
export type FormPart = string | number | boolean | Blob

/**
 * What `$formData` builds a form from: per field, a part, or a list of parts sent under the field's name. A field
 * given `undefined` or `null` is left out.
 */
export type FormFields = Record<string, FormPart | readonly FormPart[] | null | undefined>

/**
 * A `FormData` that remembers the fields it was built from, so a call can check them against its route.
 *
 * Nothing of it exists at run time: it is a `FormData` like any other, and a plain one is assignable to it.
 */
export type FormDataOf<T> = FormData & {
  readonly [fields]?: T
  // Apart from the fields: an object with a field more is still assignable to one without it, and a union of names
  // with one more is not.
  readonly [names]?: keyof T
}

// The client's `$formData`, documented on `FileHelpers`: each part appended under its field, a list part by part.
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
