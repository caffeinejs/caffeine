import { ErrCaffeine } from '../error.js'

/**
 * A schema names a type JSON Schema does not define — `undefined`, `void`, `Date`. TypeBox builds these happily
 * because its own `Value` can check them, and they are legitimate in a configuration schema; they only become a
 * problem once the schema is handed to Ajv, which refuses the whole route.
 *
 * Thrown while routes are being configured, so the process fails at startup rather than at the first request.
 *
 * The solutions depend on which type is at fault, so they are composed at the throw site.
 */
export class ErrSchemaNotRepresentable extends ErrCaffeine {
  constructor(
    readonly context: string,
    readonly path: string,
    readonly jsonType: string,
    ...solutions: string[]
  ) {
    super(
      `Cannot represent the "${context}" schema as JSON Schema: ${path === '' ? 'the root schema' : `"${path}"`}`
      + ` has type "${jsonType}", which JSON Schema does not define`
      + solutions,
      'ERR_SCHEMA_NOT_REPRESENTABLE',
      undefined,
      ...solutions,
    )
    this.name = 'ErrSchemaNotRepresentable'
  }
}

/**
 * A schema could not be converted to JSON Schema. Thrown while routes are being configured — never while serving a
 * request — so an unusable schema fails the application at startup instead of quietly validating nothing.
 *
 * The solutions are fixed, so they are attached here rather than at each throw site.
 */
export class ErrSchemaConversion extends ErrCaffeine {
  constructor(
    readonly vendor: string,
    readonly context: string,
    reason: string,
    cause?: unknown,
  ) {
    super(
      `Cannot convert the "${context}" schema to JSON Schema: ${reason}`,
      'ERR_SCHEMA_CONVERSION',
      cause,
      'Declare the schema with the "$t" dialect from "@caffeinejs/std", which is JSON Schema already',
      `Keep the "${vendor}" schema free of constructs that have no JSON Schema equivalent, such as transforms`
      + ' and custom refinements',
      'Move validation that cannot be expressed as JSON Schema into the handler',
    )
    this.name = 'ErrSchemaConversion'
  }
}
