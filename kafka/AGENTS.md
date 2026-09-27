# `@caffeinejs/kafka`

Follow the root [`AGENTS.md`](../AGENTS.md), plus:

- Spring Kafka shaped (`@KafkaHandler`, `@KafkaListener`, `KafkaTemplate`, `$k` / `@KafkaParams`); the client is
  `@platformatic/kafka`.
- Do not use Nest microservices APIs: `@MessagePattern`, `@EventPattern`, `ClientProxy`, reply-topic RPC, or
  `KafkaRetriableException`.
- Usage is in [`kafka.md`](../ai/docs/kafka.md).
