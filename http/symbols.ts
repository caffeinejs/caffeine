export const Keys = {
  /**
   * The label `@Controller` gives its class. A controller bound by hand carries {@link Keys.ENTRYPOINT} beside it,
   * `.labels(Keys.CONTROLLER, Keys.ENTRYPOINT)`, or start-up refuses it.
   */
  CONTROLLER: Symbol.for('@caffeinejs/http:controller'),
  /**
   * The label every transport gives a class whose methods it calls on a request, a controller here, so a package
   * that must find them, such as `@caffeinejs/resilience`, reads it without importing the transport.
   */
  ENTRYPOINT: Symbol.for('@caffeinejs:entrypoint'),
  CONTEXT: Symbol.for('@caffeinejs/http:context'),
}
