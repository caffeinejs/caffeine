import { Binding } from './binding.js'
import { InjectionToken } from './key.js'

/**
 * MetadataReader allows reading metadata from a key.
 * It can used to customize reading binding metadata.
 */
export type MetadataReader = (key: InjectionToken) => Partial<Binding>
