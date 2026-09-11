# Kafka

Package: `@caffeinejs/kafka`. Client is `@platformatic/kafka`. This is Spring Kafka shaped, not Nest `@nestjs/microservices`.

Do not use `@MessagePattern`, `@EventPattern`, `ClientProxy`, or reply-topic RPC.

```ts
import { createApplication } from '@caffeinejs/std'
import { kafka, KafkaHandler, KafkaListener, KafkaParams, KafkaTemplate, $k } from '@caffeinejs/kafka'

const app = createApplication().extend(kafka(k => k.brokers('localhost:9092').groupId('svc')))

@KafkaHandler()
class Orders {
  constructor(private readonly template: KafkaTemplate) {}

  @KafkaListener({ topic: 'orders' })
  @KafkaParams(k => [k.value(), k.key()])
  async onOrder(order: Order, key: string) {
    await this.template.send('notify', { id: order.id })
  }
}
```

- Named instances: `.extend(kafka('orders', k => …))` and `@KafkaHandler({ instance: 'orders' })`.
- Without `@KafkaParams`, the method receives the whole `KafkaMessage`.
- Retry / DLT: builder `retry`, `retryTopics`, `deadLetter`, `classifier` — not Nest `KafkaRetriableException`.
- `createWebApplication(...).extend(kafka(…))` works the same if the process is already an HTTP app.
