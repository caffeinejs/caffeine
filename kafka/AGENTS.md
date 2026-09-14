# `@caffeinejs/kafka`

Spring Kafka shaped (`@KafkaHandler`, `@KafkaListener`, `KafkaTemplate`, `$k` / `@KafkaParams`). Client is `@platformatic/kafka`.

Do not use Nest microservices APIs: `@MessagePattern`, `@EventPattern`, `ClientProxy`, reply-topic RPC, or `KafkaRetriableException`.

- `.with(kafka(k => k.brokers(...).groupId(...)))`. Named instance: `.with(kafka('orders', k => …))` and `@KafkaHandler({ instance: 'orders' })`.
- Without `@KafkaParams`, the method receives the whole `KafkaMessage`.
- Retry / DLT belong on the builder (`retry`, `retryTopics`, `deadLetter`, `classifier`).
- Side-effect-import handler classes so they register. Works on `createApplication()` or `createWebApplication(...).with(kafka(k => …))`.
