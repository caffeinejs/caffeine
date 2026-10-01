import type { InferConfig, SchemaSatisfies } from '@caffeinejs/std/config'
import { $t } from '@caffeinejs/std/schema'

import type { KafkaConfig } from './config.js'

const backoffSchema = $t.Union([
  $t.Object({ type: $t.Literal('fixed'), delay: $t.Number() }),
  $t.Object({
    type: $t.Literal('exponential'),
    delay: $t.Number(),
    multiplier: $t.Optional($t.Number()),
    max: $t.Optional($t.Number()),
  }),
])

/**
 * The schema of one kafka instance's configuration block, satisfying {@link KafkaConfig}. Hand the node to
 * `Kafka((k, { config }) => k.config(...))`.
 *
 * Everything left out (serializers, the retry strategy, the classifier, the recoverer, the error hooks, the
 * dead-letter manager, and the object form of `deadLetter`) is a function or a class, and stays in code.
 *
 * Nothing is defaulted here: the feature owns its defaults. `brokers` is a `$t.List` so
 * `KAFKA__DEFAULT__BROKERS=a:9092,b:9092` works as well as a JSON array, and it stays optional so a missing broker
 * list fails as `ErrKafkaMissingBrokers`, which says what to do, rather than as a generic "required property"
 * complaint.
 */
export const KafkaConfigSchema = $t.Object({
  brokers: $t.Optional($t.List($t.String())),
  clientId: $t.Optional($t.String()),
  groupId: $t.Optional($t.String()),
  ackMode: $t.Optional($t.UnionEnum(['auto', 'record', 'manual'])),
  retry: $t.Optional($t.Object({ attempts: $t.Number(), backoff: $t.Optional(backoffSchema) })),
  topicProvisioning: $t.Optional(
    $t.Object({
      autoCreate: $t.Optional($t.Boolean()),
      partitions: $t.Optional($t.Number()),
      replicas: $t.Optional($t.Number()),
    }),
  ),
  deadLetter: $t.Optional($t.Boolean()),
})

type _Satisfies = SchemaSatisfies<KafkaConfig, InferConfig<typeof KafkaConfigSchema>>
