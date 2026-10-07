// Imports nothing on purpose: `@caffeinejs/di` cannot depend on `std` and carries a copy of this file at
// `di/internal/util/errutil/errutil.ts`. Change both.

/** Base URL of the error reference pages. Empty until they are published: no reference line is printed. */
const REFERENCE_BASE_URL: string = ''

type ErrorClass = abstract new (...args: never[]) => Error

/**
 * Assembles an error message from its text, its solutions and a footer of links.
 *
 * The first line is always the message as given. The sections follow in a fixed order, solutions, reference,
 * links, whatever order they were added in, and an empty section prints nothing.
 */
export class ErrMessageBuilder {
  readonly #message: string
  readonly #solutions: string[] = []
  readonly #links: string[] = []
  #reference: string | undefined

  constructor(message: string) {
    this.#message = message
  }

  /**
   * Adds solutions, one action each, most likely fix first.
   *
   * Written without a leading dash: the builder writes the bullets.
   */
  solutions(...solutions: string[]): this {
    this.#solutions.push(...solutions)
    return this
  }

  /**
   * Links the reference page of the error being built.
   *
   * @param pkg - The npm name of the package that defines the class, e.g. `@caffeinejs/http`
   * @param errorClass - The class being constructed with this message
   */
  reference(pkg: `@caffeinejs/${string}`, errorClass: ErrorClass): this {
    this.#reference = `${pkg.slice('@caffeinejs/'.length)}/${errorClass.name}`
    return this
  }

  /** Adds further reading, one URL each. */
  links(...links: string[]): this {
    this.#links.push(...links)
    return this
  }

  build(): string {
    let message = this.#message

    if (this.#solutions.length > 0) {
      message += '\nPossible Solutions:\n  - ' + this.#solutions.join('\n  - ')
    }

    if (this.#reference !== undefined && REFERENCE_BASE_URL !== '') {
      message += `\nRead more: ${REFERENCE_BASE_URL}/${this.#reference}`
    }

    if (this.#links.length > 0) {
      message += '\nSee also:\n  - ' + this.#links.join('\n  - ')
    }

    return message
  }
}

/** Starts an error message. See {@link ErrMessageBuilder}. */
export function errMessage(message: string): ErrMessageBuilder {
  return new ErrMessageBuilder(message)
}
