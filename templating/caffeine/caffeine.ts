import {
  FeatureBuilder,
  kFeatureName,
  type Feature,
  type FeatureConfigurer,
  type FeatureConfigureKit,
} from '@caffeinejs/application'

import { ErrTemplateConfiguration } from '../errors.js'
import { assertRendererName, TemplateRenderer, type GroupSettings, type TemplateGroupOptions } from '../renderer.js'

export interface TemplatingConfig {
  readonly default?: GroupSettings
  readonly named?: Readonly<Record<string, GroupSettings>>
}

export class TemplatingBuilder<C = unknown> extends FeatureBuilder<C> {
  readonly [kFeatureName] = 'templating'

  readonly #groups = new Map<string, TemplateGroupOptions>()
  #settings: TemplatingConfig = {}

  config(settings: TemplatingConfig): this {
    this.#settings = {
      default: settings.default && snapshot(settings.default),
      named: Object.fromEntries(Object.entries(settings.named ?? {}).map(([name, group]) => [name, snapshot(group)])),
    }
    return this
  }

  add(group: TemplateGroupOptions): this
  add(name: string, group: TemplateGroupOptions): this
  add(nameOrGroup: string | TemplateGroupOptions, group?: TemplateGroupOptions): this {
    const name = typeof nameOrGroup === 'string' ? nameOrGroup : 'default'
    if (typeof nameOrGroup === 'string') {
      assertRendererName(name)
    }
    const settings = typeof nameOrGroup === 'string' ? group : nameOrGroup
    if (settings === undefined || this.#groups.has(name)) {
      throw new ErrTemplateConfiguration(`Cannot register template renderer "${name}": expected a unique group`)
    }

    this.#groups.set(name, {
      ...settings,
      ...snapshot(settings),
      entries: settings.entries === undefined ? undefined : { ...settings.entries },
      defaultModel: settings.defaultModel === undefined ? undefined : { ...settings.defaultModel },
      partials: settings.partials && {
        html: { ...settings.partials.html },
        text: { ...settings.partials.text },
      },
    } as TemplateGroupOptions)
    return this
  }

  protected override configure(kit: FeatureConfigureKit<C>): void {
    if (this.#groups.size === 0) {
      throw new ErrTemplateConfiguration('Cannot install templating: register at least one group with add()')
    }
    const settings = new Map(Object.entries(this.#settings.named ?? {}))
    for (const name of settings.keys()) {
      assertRendererName(name)
    }
    if (this.#settings.default !== undefined) {
      settings.set('default', this.#settings.default)
    }
    for (const name of settings.keys()) {
      if (!this.#groups.has(name)) {
        throw new ErrTemplateConfiguration('Cannot configure templating: settings refer to an unregistered group')
      }
    }

    const named: Record<string, TemplateGroupOptions> = Object.create(null)
    let primary: TemplateGroupOptions | undefined
    for (const [name, group] of this.#groups) {
      const config = settings.get(name)
      const effective = {
        ...group,
        layout: group.layout ?? config?.layout,
        cache: group.cache ?? config?.cache,
        limits: { ...config?.limits, ...group.limits },
      }
      if (name === 'default') {
        primary = effective
      } else {
        named[name] = effective
      }
    }
    const renderer = new TemplateRenderer({ default: primary, named })
    kit.container.bind(TemplateRenderer, binding => binding.toValue(renderer))
  }
}

export function Templating<C = unknown>(configure?: FeatureConfigurer<TemplatingBuilder<C>, C>): Feature<C> {
  return new TemplatingBuilder<C>(configure as never)
}

function snapshot(settings: GroupSettings): GroupSettings {
  return {
    layout: settings.layout,
    cache: settings.cache && { ...settings.cache },
    limits: settings.limits && { ...settings.limits },
  }
}
