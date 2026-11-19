using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "app", worker = (
      modules = [(name = "worker.mjs", esModule = embed "bundle.mjs")],
      compatibilityDate = "2026-11-18",
      compatibilityFlags = ["nodejs_compat"],
      bindings = [(name = "LATCH", service = "latch")],
    )),
    (name = "latch", external = (http = ())),
  ],
  sockets = [(name = "http", address = "127.0.0.1:0", http = (), service = "app")],
);
