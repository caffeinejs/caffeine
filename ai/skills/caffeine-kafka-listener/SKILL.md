---
name: caffeine-kafka-listener
description: >-
  Add a Caffeine Kafka consumer or producer (kafka plugin, @KafkaHandler, @KafkaListener,
  KafkaTemplate, $k pickers). Use when consuming a topic, sending with KafkaTemplate,
  or configuring retry/DLT. Never Nest @MessagePattern or ClientProxy.
---

# Kafka listener

Use this skill when adding Kafka produce/consume. If `ai/docs/kafka.md` and `ai/docs/rules.md` exist, read them.

Do not implement Nest microservices RPC (reply topics, `@MessagePattern`).

## Steps

1. `.extend(kafka, k => k.brokers(...).groupId(...))`. Named instance: `.extend(kafka('orders'), k => …)`.
2. Class `@KafkaHandler()` (or `{ instance: 'orders' }`). Methods `@KafkaListener({ topic: 'orders' })`.
3. Optional `@KafkaParams(k => [k.value(), k.key()])`. Without it, the argument is `KafkaMessage`.
4. Produce with injected `KafkaTemplate.send(topic, value)`.
5. Side-effect-import the handler class. Retry/DLT belong on the builder (`retry`, `retryTopics`, `deadLetter`), not in the method unless you know you need them.

## Shape

```ts
import { createApplication } from '@caffeinejs/std'
import { kafka, KafkaHandler, KafkaListener, KafkaParams, KafkaTemplate, $k } from '@caffeinejs/kafka'

const app = createApplication()
  .extend(kafka, k => k.brokers('localhost:9092').groupId('svc'))

@KafkaHandler()
class Orders {
  constructor(private readonly template: KafkaTemplate) {}

  @KafkaListener({ topic: 'orders' })
  @KafkaParams(k => [k.value()])
  async onOrder(order: Order) {
    await this.template.send('notify', { id: order.id })
  }
}
```

## Verify

Run the package/app tests. Prefer the in-memory `KafkaClients` seam over a live broker unless the project already has an integration broker.

## Related

- `docs/kafka.md`, `docs/rules.md`
