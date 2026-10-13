/**
 * Standalone Vitest config for the Electron plugin-host suite.
 *
 * The repo-wide `vitest.config.ts` mounts `scripts/test-invariants.ts` as a
 * global setup file, which imports the Cordis workspace packages. Those are
 * only linked after a full `pnpm install`, which the sandbox blocks. The
 * plugin host is pure Node with no Cordis dependency, so this isolated config
 * runs its spec without that setup — keeping the suite runnable pre-install.
 */

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/agent-client/tests/plugin-host.spec.ts', 'apps/agent-client/tests/cordis-host.spec.ts', 'apps/agent-client/tests/catalog.spec.ts', 'apps/agent-client/tests/workbench.spec.ts', 'apps/agent-client/tests/scan-extensions.spec.ts', 'apps/agent-client/tests/dsh-web-launcher.spec.ts', 'apps/agent-client/tests/api-proxy.spec.ts', 'apps/agent-client/tests/workbench-preconditions.spec.ts'],
    // Deliberately omit scripts/test-invariants.ts (Cordis-only setup).
    setupFiles: [],
    coverage: { enabled: false },
  },
})
