import { describe, it, expect, vi } from 'vitest'
import { token } from '../key.js'
import { Named } from '../decorators/named.js'
import { CaffeineIoC } from '../container.js'
import { Inject } from '../decorators/inject.js'
import { $i } from '../injection.js'
import { UseFactory } from '../decorators/use_factory.js'
import { Provides } from '../decorators/provides.js'
import { ConditionalOn } from '../decorators/conditional_on.js'
import { Extends } from '../decorators/extends.js'
import { Primary } from '../decorators/primary.js'
import { PreDestroy } from '../decorators/pre_destroy.js'
import { PostConstruct } from '../decorators/post_construct.js'
import { valueFactory } from '../internal/core/factory/value.js'
import { Injectable } from '../decorators/injectable.js'
import { Configuration } from '../decorators/configuration.js'

describe('Real World', function () {
  const initSpy = vi.fn()
  const destroySpy = vi.fn()
  const sendSpy = vi.fn()
  const userSpy = vi.fn()

  const kEmail = token<any>(Symbol('mail'))
  const kSms = token<any>('sms')
  const kAm = token<any>(Symbol('am'))
  const kAf = token<any>(Symbol('af'))
  const kAs = token<any>(Symbol('as'))
  const kRegions = token<any>(Symbol('regions'))

  const Globals = {
    Env: 'test',
  }

  class GenericRepository<T> {
    constructor(protected readonly model: () => T) {}

    name() {
      return (this.model() as any).name
    }
  }

  class User {}

  @Injectable()
  @UseFactory(valueFactory(new GenericRepository(() => Product)))
  class Product {}

  abstract class EventSender {
    abstract type: string

    abstract send(): void
  }

  class KafkaEventSender extends EventSender {
    type = 'kafka'

    send(): void {
      sendSpy()
    }
  }

  class RabbitMqEventSender extends EventSender {
    type = 'rabbitmq'

    send(): void {}
  }

  @Configuration()
  class Events {
    @Provides(EventSender)
    @ConditionalOn(() => Globals.Env !== 'test')
    rabbitEventSender(): EventSender {
      return new RabbitMqEventSender()
    }

    @Provides(EventSender)
    @ConditionalOn(() => Globals.Env === 'test')
    kafkaEventSender(): EventSender {
      return new KafkaEventSender()
    }
  }

  @Configuration()
  class RegionsConfig {
    @Provides(kAm)
    @Named(kRegions)
    am() {
      return 'am'
    }

    @Provides(kAf)
    @Named(kRegions)
    af() {
      return 'af'
    }

    @Provides(kAs)
    @Named(kRegions)
    as() {
      return 'as'
    }
  }

  interface NotificationService {
    notify(): string
  }

  @Injectable()
  @Named(kEmail)
  class EmailNotificationService implements NotificationService {
    notify(): string {
      return 'mail'
    }
  }

  @Injectable()
  @Named(kSms)
  class SmsNotificationService implements NotificationService {
    @Inject($i.allOf(kRegions))
    regions!: string[]

    message = 'sms'

    notify(): string {
      return this.message
    }

    @PostConstruct()
    init() {
      initSpy()
      this.message = this.message + ' - ' + this.regions.join(', ')
    }
  }

  abstract class UserRepository {
    abstract save(user: User): void
  }

  @Injectable([EventSender])
  @Extends(UserRepository)
  class UserMongoRepository extends UserRepository {
    constructor(private readonly eventSender: EventSender) {
      super()
    }

    save(user: User): void {
      this.eventSender.send()
      userSpy()
    }

    @PreDestroy()
    dispose(): Promise<void> {
      destroySpy()
      return Promise.resolve()
    }
  }

  class ViewEngine {
    render() {
      return 'rendered'
    }
  }

  @Injectable()
  class LegacyViewEngine extends ViewEngine {
    render(): string {
      return super.render() + ' - legacy'
    }
  }

  @Injectable()
  @Extends(ViewEngine)
  @Primary()
  class ActualViewEngine extends ViewEngine {
    render(): string {
      return super.render() + ' - actual'
    }
  }

  @Injectable(token<any>('token'), [UserRepository, kSms])
  class UserService {
    constructor(
      private readonly userRepository: UserRepository,
      private readonly notificationService: NotificationService,
    ) {}

    save() {
      this.userRepository.save(new User())
    }

    send() {
      return this.notificationService.notify()
    }
  }

  @Injectable([Product])
  class ProductService {
    constructor(private readonly repository: GenericRepository<Product>) {}

    name() {
      return this.repository.name()
    }
  }

  @Injectable([UserService, ProductService, ViewEngine])
  class Controller {
    constructor(
      private readonly userService: UserService,
      private readonly productService: ProductService,
      private readonly viewEngine: ViewEngine,
    ) {}

    saveUser() {
      this.userService.save()
    }

    sendMessage() {
      return this.userService.send()
    }

    productName() {
      return this.productService.name()
    }

    render() {
      return this.viewEngine.render()
    }
  }

  it('should ensure everything resolves and works properly', async function () {
    const di = new CaffeineIoC()
    await di.init()
    const controller = di.get(Controller)

    expect(controller)
      .toBeInstanceOf(Controller)
    expect(controller.render())
      .toEqual('rendered - actual')
    expect(controller.productName())
      .toContain(Product.name)
    expect(() => controller.saveUser()).not.toThrow()
    expect(controller.sendMessage())
      .toContain('sms')
    expect(controller.sendMessage())
      .toContain('am')
    expect(controller.sendMessage())
      .toContain('as')
    expect(controller.sendMessage())
      .toContain('af')

    await di.dispose()

    expect(initSpy)
      .toHaveBeenCalledTimes(1)
    expect(destroySpy)
      .toHaveBeenCalledTimes(1)
    expect(sendSpy)
      .toHaveBeenCalledTimes(1)
    expect(userSpy)
      .toHaveBeenCalledTimes(1)
  })
})
