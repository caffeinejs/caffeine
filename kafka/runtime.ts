import type { Container } from '@caffeinejs/di'

import type { KafkaClients, ResolvedKafkaConfig } from './config.js'

/**
 * Internal runtime seam bound per instance under `runtimeKey(name)`. It carries everything the DI-managed
 * beans (`KafkaTemplate`, `KafkaListenerContainer`) need: the instance name (to correlate handlers), the
 * container (for listener discovery and lazy instance resolution), the resolved config, and the client factory
 * (real platformatic clients in production, fakes in tests).
 */
export interface KafkaRuntime {
  name: string
  container: Container
  config: ResolvedKafkaConfig
  clients: KafkaClients
}
