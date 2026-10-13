# dsh-desktop-runtime-closure

Dependency-only deploy root defining the dsh runtime that the **Electron desktop
client (`DeepSeekAgent.exe`)** bundles.

It mirrors `python/sdk-runtime` (the SDK/headless closure) and adds everything
the **web profile** needs, plus the three community plugin bundles:

| added package | why |
| --- | --- |
| `@deepseek-ai/dsh-base` | first bundle of the `web` profile |
| `@deepseek-ai/dsh-web-app` | second bundle of the `web` profile |
| `@deepseek-ai/dsh-host-webserver` | serves dsh-web-ui and the WS API |
| `@deepseek-ai/dsh-web-frontend` | the dsh-web-ui static assets (`apps/web`) |
| `@deepseek-ai/dsh-modlens` | community plugin — `vision` capability |
| `@deepseek-ai/dsh-node-flow` | community plugin — `workflow` capability |
| `@deepseek-ai/dsh-market` | community plugin — `market` capability |

## Build

From the repository root, after `pnpm install` has linked this package:

```bash
# 1. build every workspace package (lib/ artifacts)
pnpm run build

# 2. deploy a symlink-free production tree
pnpm --filter dsh-desktop-runtime-closure deploy --legacy --prod \
  --config.node-linker=hoisted --config.auto-install-peers=false \
  --config.link-workspace-packages=true \
  apps/agent-client/resources/dsh-runtime/node

# 3. place a Node 22.19+ runtime beside it (Electron 30 only ships Node 18,
#    which is too old for the dsh CLI)
copy <node-24-dir>\node.exe apps/agent-client/resources/dsh-runtime\node.exe
```

At runtime the client spawns:

```
<resources>/dsh-runtime/node.exe <resources>/dsh-runtime/node/node_modules/@deepseek-ai/dsh/lib/bin.js web --port <port>
```

This is the same "node carrier" shape the Python SDK uses
(`python/sdk-runtime/README.md`), so no `pkg`/SEA step is required.
