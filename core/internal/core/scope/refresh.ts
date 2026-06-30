import { Binding } from '../../../binding.js'
import { Container } from '../../../container_interface.js'
import { kSelfRefresh } from '../../../refresher.js'
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
    await Promise.all(this.managedBindings.map(b => {
      const cached = this._cachedInstances.get(b.id)
      if (cached != null && typeof (cached as Record<symbol, unknown>)[kSelfRefresh] === 'function') {
        return (cached as Record<symbol, () => unknown>)[kSelfRefresh]()
      }
      return this.container.resetBinding(b)
    }))
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
