import { InjectionToken } from './key.js'
import { Binding } from './binding.js'

/**
 * MetadataReader allows reading metadata from a key.
 * It can used to customize reading binding metadata.
 */
export type MetadataReader = (key: InjectionToken) => Partial<Binding>
