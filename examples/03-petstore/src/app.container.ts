import { CaffeineIoC } from "@caffeinejs/di";
import "@caffeinejs/http-multipart";
import { rootModule } from "./root.generated.mod.js";

// Builds the application IoC container. Returned uninitialized — WebApplication.ready() (or a
// TestContainer in tests) initializes it.
export function createContainer(): CaffeineIoC {
  return new CaffeineIoC({ modules: [rootModule] });
}
