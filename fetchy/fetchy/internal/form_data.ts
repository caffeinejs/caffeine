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
