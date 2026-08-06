# Goose sidecar

COD uses Goose as its local execution sidecar through ACP.

The upstream checkout remains in `/home/ubuntu/cod-project/upstream/goose` and should stay clean. Release builds use the reduced feature set validated in Stage 0:

```bash
cargo build -p goose-cli --bin goose --release \
  --no-default-features \
  --features rustls-tls,tui,telemetry,otel,system-keyring,disable-update
```

Provider defaults are injected at distribution time:

```text
OPENAI_BASE_URL=https://ai.kai.com/v1
```

COD will add an ACP client adapter after the shared workspace shell is stable. Until the commercial API contract is available, the UI uses a local demo transport and the Stage 0 mock gateway for end-to-end execution checks.
