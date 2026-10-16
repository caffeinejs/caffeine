// The FormData class is in dictionary mode, so `instanceof FormData` looks its prototype up the slow way on every call,
// at more than the cost of every other check a body goes through. The prototype is read once instead, and again only
// when the global is replaced, as undici's `install()` does.
let formDataClass: typeof FormData | undefined
let formDataPrototype: FormData | undefined

export function isFormData(value: unknown): value is FormData {
  if (formDataClass !== FormData) {
    formDataClass = FormData
    formDataPrototype = FormData.prototype
  }

  return formDataPrototype!.isPrototypeOf(value as object)
}

type FormDataMethod = 'append' | 'delete' | 'get' | 'getAll' | 'has' | 'set'

// undici's own test for a FormData, which one of any implementation passes: undici's, and one built before `install()`
// replaced the global. A stream that calls itself FormData, as the form-data package's do, fails it. Slower than
// `isFormData`, so it is kept off the path every call takes.
export function isFormDataLike(value: object): boolean {
  const form = value as Partial<Record<FormDataMethod, unknown>> & { [Symbol.toStringTag]?: unknown }

  return (
    form[Symbol.toStringTag] === 'FormData' &&
    typeof form.append === 'function' &&
    typeof form.delete === 'function' &&
    typeof form.get === 'function' &&
    typeof form.getAll === 'function' &&
    typeof form.has === 'function' &&
    typeof form.set === 'function'
  )
}
