export type { Binding as BindingDecoratorConfig } from '../../binding.js'
export {
  addProvidedBindings,
  decoratorConfigToBinding,
  defineInjectable,
  defineMemberInjection,
  extendInjectableAttributes,
  extendMemberInjectableAttributes,
  getBindingConfiguration,
  getBindingConfigurations,
  getInjectionMetadata,
  hasInjectable,
  providedBindingConfigurations,
} from './registrar.js'
export type { MemberMetadata as Metadata } from './spec.js'
