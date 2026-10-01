import type { Duration } from '../../duration/index.js'
import { $t } from '../../schema/t.js'
import type { InferConfig, SchemaSatisfies } from '../types.js'

/**
 * A feature's configuration schema asserts that what it decodes can be handed to the feature's `config(...)`.
 * Nothing at run time compares the two, so this file is what holds it: `npm run test:typecheck` is the test.
 */

interface ThingOptions {
  size: number
  hosts: readonly string[]
  mode: 'fast' | 'safe'
  timeout: Duration
  onError: (error: unknown) => void
}

const ThingConfigSchema = $t.Object({
  size: $t.Optional($t.Number()),
  hosts: $t.Optional($t.List($t.String())),
  mode: $t.Optional($t.UnionEnum(['fast', 'safe'])),
  timeout: $t.Optional($t.Duration()),
})

type _Fits = SchemaSatisfies<ThingOptions, InferConfig<typeof ThingConfigSchema>>

// A configuration node's arrays are read-only, so a mutable array on the options side cannot take one.
interface MutableHosts {
  hosts: string[]
}

// @ts-expect-error `readonly string[]` is not assignable to `string[]`
type _MutableArray = SchemaSatisfies<MutableHosts, InferConfig<typeof ThingConfigSchema>>

// A key the options do not declare would be read by nothing.
const ExtraKeySchema = $t.Object({ size: $t.Optional($t.Number()), colour: $t.Optional($t.String()) })

// @ts-expect-error `colour` is not a key of `ThingOptions`
type _ExtraKey = SchemaSatisfies<ThingOptions, InferConfig<typeof ExtraKeySchema>>

// A literal the options do not accept.
const WrongModeSchema = $t.Object({ mode: $t.Optional($t.UnionEnum(['fast', 'slow'])) })

// @ts-expect-error `'slow'` is not a `ThingOptions['mode']`
type _WrongLiteral = SchemaSatisfies<ThingOptions, InferConfig<typeof WrongModeSchema>>

// A union of option shapes accepts a key any member declares, not only the keys they share.
type DriverOptions = { type: 'a'; host: string; port: number } | { type: 'b'; file: string }

const DriverConfigSchema = $t.Object({ host: $t.Optional($t.String()), file: $t.Optional($t.String()) })

type _UnionMember = SchemaSatisfies<DriverOptions, InferConfig<typeof DriverConfigSchema>>
