import type { AnySchema } from '@caffeinejs/application/schema'
import type { TSchema } from '@sinclair/typebox'
import type { StandardSchemaV1 } from '@standard-schema/spec'

/** Writes one response's JSON text. */
export type CompiledSerializer = (value: unknown) => string

/**
 * Turns a route's schemas into what the application runs under any adapter, once, while routes are being registered.
 * The server's `schemaCompiler` setting picks it; {@link typeBoxSchemaCompiler} is the default.
 *
 * Only a TypeBox slot reaches `validator`: a Standard Schema slot validates itself. The engine has already applied its
 * policy to `schema`: a body object closed with `additionalProperties: false`, a headers object left open, header
 * names lower-cased, a file body left out.
 *
 * A validator fills declared defaults, converts params, query and header text to the declared types, drops a key an
 * object does not declare where it says `additionalProperties: false` and keeps it elsewhere, checks the value, and
 * decodes codecs such as `$t.Duration()`. A serializer encodes codecs and writes declared members only, so a field
 * the schema leaves out never reaches a client.
 */
export interface SchemaCompiler {
  /**
   * @param input - `context` names the route and slot in failures, e.g. `POST /pets body`.
   * @throws ErrConfiguration for a schema it cannot compile.
   */
  validator(input: { readonly schema: TSchema; readonly context: string }): StandardSchemaV1
  /**
   * @param input - `context` names the route and status in failures, e.g. `POST /pets response 200`.
   * @throws ErrConfiguration for a schema it cannot compile.
   */
  serializer(input: { readonly schema: AnySchema; readonly context: string }): CompiledSerializer
}
