import { $t, type InferSchema } from '@caffeinejs/application/schema'

export const ContainerEventSchema = $t.Object({
  /** Increases by one per event, from 1: what `?after=` reads from. */
  seq: $t.Integer(),
  kind: $t.UnionEnum([
    'binding-initialized',
    'binding-initialization-failed',
    'binding-registered',
    'module-registered',
    'module-registration-failed',
    'container-disposed',
  ]),
  /** The binding's key or the module's name. */
  subject: $t.Optional($t.String()),
  /** An ISO 8601 timestamp. */
  at: $t.String(),
  /** The failure's message, the password of any URL in it masked. */
  error: $t.Optional($t.String()),
})

export type ContainerEventRecord = InferSchema<typeof ContainerEventSchema>
export type ContainerEventKind = ContainerEventRecord['kind']
