import type { SchemaIssue } from '../schema/schema.js'

export class ErrConfig extends Error {
  readonly code: string

  constructor(message: string, code: string, override readonly cause?: unknown) {
    super(message)
    this.name = 'ErrConfig'
    this.code = code
  }
}

export class ErrMissingConfigKey extends ErrConfig {
  constructor(key: string) {
    super(`Cannot resolve config key: "${key}" is not defined`, 'ERR_MISSING_CONFIG_KEY')
    this.name = 'ErrMissingConfigKey'
  }
}

export class ErrInvalidConfigType extends ErrConfig {
  constructor(key: string, expected: string, actual: string) {
    super(`Cannot coerce config key "${key}": expected ${expected}, got ${actual}`, 'ERR_INVALID_CONFIG_TYPE')
    this.name = 'ErrInvalidConfigType'
  }
}

export class ErrConfigValidation extends ErrConfig {
  constructor(
    public readonly issues: SchemaIssue[],
    cause?: unknown,
  ) {
    const detail = issues.length > 0 ? `: ${issues.map(i => `${i.path}: ${i.message}`).join('; ')}` : ''
    super(`Config validation failed${detail}`, 'ERR_CONFIG_VALIDATION', cause)
    this.name = 'ErrConfigValidation'
  }
}

export class ErrConfigProvider extends ErrConfig {
  constructor(id: string, cause?: unknown) {
    super(`Config provider "${id}" failed to load`, 'ERR_CONFIG_PROVIDER', cause)
    this.name = 'ErrConfigProvider'
  }
}

export class ErrConfigRefresh extends ErrConfig {
  constructor(cause?: unknown) {
    super('Config refresh failed', 'ERR_CONFIG_REFRESH', cause)
    this.name = 'ErrConfigRefresh'
  }
}
