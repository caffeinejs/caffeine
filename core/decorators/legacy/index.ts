if (typeof Reflect === 'undefined' || !Reflect.getMetadata) {
  throw new Error(
    'DiCaf requires reflect-metadata when using Legacy Decorators. '
    + `Please install it and add 'import "reflect-metadata"' to the top of your entry point. `
    + `If you are using ECMAScript Decorators, import from '@caffeine-projects/dicaf/decorators' instead`,
  )
}

export * from './async.js'
export * from './bypass_post_processors.js'
export * from './compose_decorators.js'
export * from './conditional_on.js'
export * from './configuration.js'
export * from './extends.js'
export * from './fallback.js'
export * from './inject.js'
export * from './injectable.js'
export * from './interceptor.js'
export * from './label.js'
export * from './lazy.js'
export * from './lifetime.js'
export * from './named.js'
export * from './on_pre_destroy.js'
export * from './post_construct.js'
export * from './pre_destroy.js'
export * from './primary.js'
export * from './profile.js'
export * from './provides.js'
export * from './tag.js'
export * from './use_async_factory.js'
export * from './use_factory.js'
