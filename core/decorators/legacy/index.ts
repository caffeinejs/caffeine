if (typeof Reflect === 'undefined' || !Reflect.getMetadata) {
  throw new Error(
    'DiCaf requires reflect-metadata when using Legacy Decorators. '
    + `Please install it and add 'import "reflect-metadata"' to the top of your entry point. `
    + `If you are using ECMAScript Decorators, import from '@caffeine-projects/dicaf/decorators' instead`,
  )
}

export * from './async.legacy.js'
export * from './bypass_post_processors.legacy.js'
export * from './compose_decorators.legacy.js'
export * from './conditional_on.legacy.js'
export * from './configuration.legacy.js'
export * from './extends.legacy.js'
export * from './fallback.legacy.js'
export * from './inject.legacy.js'
export * from './injectable.legacy.js'
export * from './interceptor.legacy.js'
export * from './label.legacy.js'
export * from './lazy.legacy.js'
export * from './lifetime.legacy.js'
export * from './named.legacy.js'
export * from './on_pre_destroy.legacy.js'
export * from './post_construct.legacy.js'
export * from './pre_destroy.legacy.js'
export * from './primary.legacy.js'
export * from './profile.legacy.js'
export * from './provides.legacy.js'
export * from './tag.legacy.js'
export * from './use_async_factory.legacy.js'
export * from './use_factory.legacy.js'
