import { CaffeineIoC } from "@caffeinejs/di";
import "@caffeinejs/http-multipart";
import "./__caffeine__.gen.js"; // side-effect: registers every decorated component (controllers, repositories, config)

// Builds the application IoC container. Returned uninitialized — WebApplication.ready() (or a
// TestContainer in tests) initializes it.
export function createContainer(): CaffeineIoC {
  return new CaffeineIoC();
}
