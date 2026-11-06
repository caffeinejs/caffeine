/**
 * Gives a class `[Symbol.dispose]` as an alias of its `dispose()` where the runtime defines the symbol, so an instance
 * works with `using`. A method written as `[Symbol.dispose]()` would be keyed "undefined" on a runtime without it, and
 * defining the symbol here would write to a global.
 */
export function disposable(cls: { readonly prototype: { dispose(): void } }): void {
  if (typeof Symbol.dispose === 'symbol') {
    Object.defineProperty(cls.prototype, Symbol.dispose, {
      value: function (this: { dispose(): void }): void {
        this.dispose()
      },
      writable: true,
      configurable: true,
    })
  }
}
