/**
 * Framework-agnostic parameter-picking primitives. A picker declares how to extract one handler argument
 * from a request `R`; adapters (e.g. `@caffeinejs/http`) build concrete pickers on top of these types.
 */

export interface ParameterPickOptions<R> {
  type: string
  name?: string
  picker?: ParameterPicker<R>
  async?: boolean
}

export type ParameterPicker<R, O = unknown> = (req: R) => O | Promise<O>
