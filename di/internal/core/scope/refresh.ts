import { Binding } from '../../../binding.js'
import { Container } from '../../../container_interface.js'
import { kSelfRefresh } from '../../../refresher.js'
import { SingletonScope } from './singleton.js'

export class RefreshScope extends SingletonScope {
  private readonly managedBindings = new Array<Binding>()

  constructor(private readonly container: Container) {
    super()
  }

  override get lazy(): boolean {
    return false
  }

  async refresh(target?: symbol | Binding): Promise<void> {
    const targets = this.#targets(target)

    await Promise.all(
      targets.map(b => {
        const cached = this._cachedInstances.get(b.id)
        if (cached != null && typeof (cached as Record<symbol, unknown>)[kSelfRefresh] === 'function') {
          return (cached as Record<symbol, () => unknown>)[kSelfRefresh]()
        }

        return this.container.resetBinding(b)
      }),
    )
  }

  override configure(binding: Binding) {
    if (this.managedBindings.some(b => b.id === binding.id)) {
      return
    }

    this.managedBindings.push(binding)
  }

  bindings(): Binding[] {
    return this.managedBindings
  }

  /** What a refresh reaches: every binding, those carrying a label, or one. */
  #targets(target: symbol | Binding | undefined): Binding[] {
    if (target === undefined) {
      return this.managedBindings
    }

    return typeof target === 'symbol'
      ? this.managedBindings.filter(b => b.labels.includes(target))
      : this.managedBindings.filter(b => b.id === target.id)
  }
}
