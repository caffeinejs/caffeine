/**
 * Framework-agnostic parameter-picking primitives. A picker declares how to extract one handler argument
 * from a request `R`; adapters (e.g. `@caffeinejs/http`) build concrete pickers on top of these types.
 */

export interface ParameterPickOptions<R> {
  type: string
  name?: string
  picker?: ParameterPicker<R>
  async?: boolean

  /**
   * Applied to whatever the pick produced, before the argument reaches the handler.
   *
   * This is what lets a pick be wrapped without knowing how its value is read. A built-in carries a `type`
   * and no `picker` — the adapter extracts it — so composing one by chaining functions is impossible;
   * composing it by transforming the result is not.
   *
   * Awaited first when the pick is `async`, so a transform is always handed the settled value.
   */
  transform?: (value: unknown) => unknown
}

export type ParameterPicker<R, O = unknown> = (req: R) => O | Promise<O>
