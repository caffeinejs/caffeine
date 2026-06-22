import 'reflect-metadata'
import { describe, it, beforeAll, expect } from 'vitest'
import { DiCaf } from '../../../container.js'
import { Scopes } from '../../../scope.js'
import { Configuration } from '../configuration.js'
import { Provides } from '../provides.js'
import { Named } from '../named.js'
import { Primary } from '../primary.js'
import { Tag } from '../tag.js'
import { Label } from '../label.js'
import { ConditionalOn } from '../conditional_on.js'
import { Fallback } from '../fallback.js'
import { Profile } from '../profile.js'
import { Lifetime } from '../lifetime.js'

class NamedProvBean {
  value() { return 'named-prov' }
}
class PrimaryProvBean {}
const PROV_TAG = Symbol('prov-tag')
class TaggedProvBean {}
const PROV_LABEL = Symbol('prov-label')
class LabeledProvBean {}
class ExcludedProvBean {}
class FallbackProvBean {}
class LifetimeProvBean {}
class ProfileProvBean {}

@Configuration()
class ProvidesDecoratorsConf {
  @Named('prov-named-alias')
  @Provides(NamedProvBean)
  namedBean(): NamedProvBean {
    return new NamedProvBean()
  }

  @Primary()
  @Provides(PrimaryProvBean)
  primaryBean(): PrimaryProvBean {
    return new PrimaryProvBean()
  }

  @Tag(PROV_TAG, 'tagged-value')
  @Provides(TaggedProvBean)
  taggedBean(): TaggedProvBean {
    return new TaggedProvBean()
  }

  @Label(PROV_LABEL)
  @Provides(LabeledProvBean)
  labeledBean(): LabeledProvBean {
    return new LabeledProvBean()
  }

  @ConditionalOn(() => false)
  @Provides(ExcludedProvBean)
  excludedBean(): ExcludedProvBean {
    return new ExcludedProvBean()
  }

  @Fallback()
  @Provides(FallbackProvBean)
  fallbackBean(): FallbackProvBean {
    return new FallbackProvBean()
  }

  @Lifetime(Scopes.TRANSIENT)
  @Provides(LifetimeProvBean)
  lifecycleBean(): LifetimeProvBean {
    return new LifetimeProvBean()
  }

  @Profile('test-provides-profile')
  @Provides(ProfileProvBean)
  profileBean(): ProfileProvBean {
    return new ProfileProvBean()
  }
}

const di = new DiCaf()

beforeAll(async () => {
  await di.init()
})

describe('Legacy @Provides + member decorators', function () {
  describe('@Named() on @Provides method', function () {
    it('bean is resolvable by original key', function () {
      expect(di.get(NamedProvBean)).toBeInstanceOf(NamedProvBean)
    })

    it('bean is resolvable by named alias', function () {
      expect(di.get<NamedProvBean>('prov-named-alias')).toBeInstanceOf(NamedProvBean)
    })
  })

  describe('@Primary() on @Provides method', function () {
    it('binding is marked primary', function () {
      expect(di.getBinding(PrimaryProvBean).primary).toBe(true)
    })
  })

  describe('@Tag() on @Provides method', function () {
    it('binding carries the tag', function () {
      expect(di.getBinding(TaggedProvBean).tags.get(PROV_TAG)).toBe('tagged-value')
    })
  })

  describe('@Label() on @Provides method', function () {
    it('binding appears in getBindingsByLabel results', function () {
      const results = di.getBindingsByLabel(PROV_LABEL)
      expect(results.length).toBeGreaterThan(0)
      expect(results.some(r => r.binding.labels?.includes(PROV_LABEL))).toBe(true)
    })
  })

  describe('@ConditionalOn(() => false) on @Provides method', function () {
    it('excludes the bean from the container', function () {
      expect(di.has(ExcludedProvBean)).toBe(false)
    })
  })

  describe('@Fallback() on @Provides method', function () {
    it('binding is marked as fallback', function () {
      expect(di.getBinding(FallbackProvBean).fallback).toBe(true)
    })
  })

  describe('@Lifetime() on @Provides method', function () {
    it('binding carries the custom scopeId', function () {
      expect(di.getBinding(LifetimeProvBean).scopeId).toBe(Scopes.TRANSIENT)
    })
  })

  describe('@Profile() on @Provides method', function () {
    // @Profile() on a @Provides method sets member-level profiles metadata but
    // @Configuration() propagates only class-level profiles to provided beans.
    // The decorator still exercises the member-level code path without error.
    it('does not throw and bean is accessible', function () {
      expect(di.get(ProfileProvBean)).toBeInstanceOf(ProfileProvBean)
    })
  })
})
