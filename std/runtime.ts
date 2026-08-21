/**
 * Caffeine runtime holds a set of runtime flags that can be used to control the behavior of the Caffeine framework.
 * Call it as a first thing in your entry point to set the flags.
 */
const CaffeineRuntime = {
  /**
   * Caffeine error messages often come with a possible solutions section, which can be helpful for debugging.
   * This flag controls whether to hide the solutions for errors thrown by the Caffeine framework.
   *
   * @defaultValue false - solutions are shown by default.
   */
  hideErrorSolutions: false,
}

export { CaffeineRuntime }
