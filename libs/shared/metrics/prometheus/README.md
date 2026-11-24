# shared-metrics-prometheus

Add `PrometheusRegistryProvider` and `PrometheusServer` to an app's providers, and `PrometheusConfig` to its `RootConfig`. The server serves the registry on `GET /metrics` on its own port (`PROMETHEUS_CONFIG__PORT`, default 9464), separate from the app's HTTP port. Keep that port in-cluster: it must not be exposed through an ingress.

Define metrics on the registry injected via `PrometheusRegistry`. HTTP apps can apply `PrometheusRouteMiddleware` to count and time requests.
