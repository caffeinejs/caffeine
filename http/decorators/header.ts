import { defineClassOrMemberDecorator } from './_decorator_util.js';
import { configureRoute, configureRouter } from './_registrar.js';

export function Header(name: string, value: string | string[]) {
  return defineClassOrMemberDecorator(
    (target) => configureRouter(target, (spec) => spec.header(name, value))
    , (context) => configureRoute(context, (spec) => spec.header(name, value))
  )
}
