type Method<This, Args extends unknown[], Return> = (this: This, ...args: Args) => Return

function uppercase<This, Args extends unknown[]>(
  target: Method<This, Args, string>,
  _context: ClassMethodDecoratorContext<This, Method<This, Args, string>>,
): Method<This, Args, string> {
  return function (this: This, ...args: Args): string {
    return target.call(this, ...args).toUpperCase()
  }
}

export class Greeter {
  constructor(private readonly name: string) {}

  @uppercase
  greet(): string {
    return `hello, ${this.name}`
  }
}

export function hello(name = 'world'): string {
  return new Greeter(name).greet()
}
