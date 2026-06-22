import { Binding } from '../../../binding.js'
import { Container } from '../../../container_interface.js'
import { SingletonScope } from './singleton.js'

export class RefreshScope extends SingletonScope {
  private readonly managedBindings = new Array<Binding>()

  constructor(private readonly container: Container) {
    super()
  }

  get lazy(): boolean {
    return false
  }

  async refresh(): Promise<void> {
    await Promise.all(this.managedBindings.map(b => this.container.resetBinding(b)))
  }

  configure(binding: Binding) {
    if (this.managedBindings.some(b => b.id === binding.id)) {
      return
    }

    this.managedBindings.push(binding)
  }

  bindings(): Binding[] {
    return this.managedBindings
  }
}
