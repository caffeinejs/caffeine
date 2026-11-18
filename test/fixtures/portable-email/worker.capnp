using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [(
    name = "portable-email",
    worker = (
      modules = [(name = "worker.mjs", esModule = embed "bundle.mjs")],
      compatibilityDate = "2024-09-01",
    ),
  )],
);
