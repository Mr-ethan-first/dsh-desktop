# Connect an office-automation MCP server

English | [中文](mcp-office.zh.md)

These **default-off reference configurations** connect an office-automation MCP server to DSH through [`@deepseek-ai/dsh-mcp-client`](../../../packages/mcp/mcp-client/README.md). Pick one, or copy the same generic MCP row for another server.

These third-party configurations are provided as interoperability examples only. Their inclusion does not imply endorsement, recommendation, partnership, or ongoing support by DeepSeek.

## What DSH does

DSH parses the selected Cordis overlay, starts the configured stdio command, discovers MCP tools, and exposes them as `mcp__<serverName>__<tool>`. DSH does **not** download the server, run a package manager, initialize a database, or choose a model or embedding provider. The generic client launches and stops the child with the DSH plugin lifecycle. For HTTP transports the upstream service must already be running.

The stdio bridge deliberately removes ambient variables whose names usually identify credentials and all `DSH_*` variables before launching a child; other ambient variables remain inherited. Each example adds only the baseline override it needs. If an optional upstream feature needs another secret, add that variable to the row's `config.env` instead of putting the secret directly in YAML.

## Choose one

| System | Stars / License | Transport | Upstream prerequisite |
|---|---:|---|---|
| [haris-musa/excel-mcp-server](https://github.com/haris-musa/excel-mcp-server) | ~3,800 · MIT | stdio / streamable-http | `uv` runtime (`uvx`); **no Microsoft Excel needed** (file-based, openpyxl) |
| [dosev-ai/mcp-office](https://github.com/dosev-ai/mcp-office) | local-first suite (excelmcp 65 / wordmcp 50 / pptmcp 46 tools) | stdio | `pip install mcp-office`, Python 3.11+; Office only for COM-backed styling/PDF/tracked-changes |

> **Which to pick?**
> - Want the **highest-star, most battle-tested** single server and cross-platform Excel file work → `excel-mcp-server`.
> - Want the **full Office suite** (Excel + Word + PowerPoint) with Windows COM features → `mcp-office-suite`.
> - Need Outlook/email, calendar, or cloud Microsoft 365 → not covered here; consider a Graph-based MCP server separately.

## Enable one

Pass one overlay to DSH:

```sh
dsh web --patch "$PWD/apps/cli/config/examples/mcp-office/excel-mcp-server.cordis.yml"
```

Replace the filename with `mcp-office-suite.cordis.yml` for the full suite. The path may point to a copied file anywhere on disk. No office server is present in the shipped composition, so omitting `--patch` keeps all disabled.

To keep the selection across runs, merge the chosen file's single `insert` patch into a user patch layer — `$DSH_HOME/profiles/<name>/cordis.patch.yml` for one profile, or `$DSH_HOME/cordis.patch.yml` for every profile on the machine. Do not copy over an existing file: it may already contain unrelated user patches.

## Provider setup

### excel-mcp-server (recommended, high-star)

```sh
# One-time: install the `uv` runtime (https://docs.astral.sh/uv/)
# Then simply run DSH with the overlay; `uvx` fetches the server on first launch.
dsh web --patch "$PWD/apps/cli/config/examples/mcp-office/excel-mcp-server.cordis.yml"
```

Works on Windows/macOS/Linux without Microsoft Excel. Optionally scope files with `EXCEL_FILES_PATH` before starting DSH. For a remote/HTTP deployment, run `uvx excel-mcp-server streamable-http` yourself and use `transport: streamable-http` with `url` + `headers` instead of `command`/`args`.

### mcp-office suite (Excel + Word + PowerPoint)

```sh
pip install mcp-office          # NOTE: PyPI `excelmcp` is an unrelated package — do NOT install it
python --version               # must be 3.11+
dsh web --patch "$PWD/apps/cli/config/examples/mcp-office/mcp-office-suite.cordis.yml"
```

Each server reads its own allowlist root from `EXCEL_ALLOWLIST_ROOTS` / `WORD_ALLOWLIST_ROOTS` / `PPT_ALLOWLIST_ROOTS`, or from the shared `DSH_OFFICE_ROOT` override. Set `DSH_OFFICE_ROOT` before starting DSH to sandbox all three to one directory. COM-backed features (styling, PDF export, tracked-changes) require Microsoft Office installed on Windows; read-only docx/xlsx/pptx tools work without it.

## Optional shared model instruction

Add this short, vendor-neutral instruction to your existing model instructions if the server's tool descriptions do not trigger office use reliably:

> When the user wants to read, create, or edit an Excel/Word/PowerPoint file, call the corresponding office MCP tool under `mcp__excel…`, `mcp__word…`, or `mcp__powerpoint…`.

This is additive guidance only. The examples do not replace DSH's system-prompt persona.

## Verify the tools appear and run

1. Start DSH with the chosen overlay and open a session.
2. Wait for initial discovery (asynchronous), then ask: `List the tools available for Excel.` Confirm the model can see `mcp__excel__…` (or `mcp__excel-office__…` for the suite) tool names.
3. Ask: `Create a spreadsheet at <path> with columns Name and Score and two sample rows.` Confirm the model called the provider's write tool and the file was created under the allowlist root.
4. Ask: `Read back the file and sum the scores.` Confirm the model called the read tool and returned the value.

A new DSH session is required; a Host restart is not. A crashed MCP child triggers automatic reconnection with backoff and a tool re-sync; tools stay listed and calls fail only during the outage, and after the reconnect budget is exhausted the tools are unregistered and reconnection stops until a reload or restart. Initial discovery is asynchronous, so wait for the provider's `mcp__…` tools before sending the first validation prompt.

## Bring another MCP server

Copy the same entry fields and use a unique `id` and `serverName`:

```yaml
- insert:
    - id: office-my-server
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: my-office
        transport: stdio
        command: my-office-mcp
        args: []
        env: {}
        cwd: !!js process.cwd()
```

For a remote server, use `transport: streamable-http`, `url`, and `headers` instead. Provider-specific installation, identity, authentication, models, embeddings, persistence, and licensing remain the provider's responsibility.
