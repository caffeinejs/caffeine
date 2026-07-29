export interface ParameterPickOptions<R> {
  type: string
  name?: string
  picker?: ParameterPicker<R>
  async?: boolean
}

export type ParameterPicker<R, O = unknown> = (req: R) => O | Promise<O>

export type Picker<R> = (req: R, parameters: Array<ParameterPickOptions<R>>) => ParameterPicker<R, Array<unknown>>
