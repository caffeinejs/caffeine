export class ErrCannotLoadTypeScriptModule extends Error {
  readonly code = 'ERR_CANNOT_LOAD_TYPESCRIPT_MODULE'

  constructor(file: string) {
    super(
      `Cannot load module at "${file}": TypeScript is not supported in this runtime — compile to JavaScript or run with a TypeScript-capable runtime`,
    )
    this.name = 'ErrCannotLoadTypeScriptModule'
  }
}
