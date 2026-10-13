# DeepSeek Harness

> ⚠️ **第三方非官方 Fork 声明 / Unofficial Fork Notice**
> 本仓库是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的**非官方 Fork**，由社区成员维护，**与 DeepSeek AI 无任何关联，也未获得其背书、赞助或授权**。
> This is an **unofficial fork** of DeepSeek Harness, **not affiliated with, endorsed by, or sponsored by DeepSeek AI**.
> - 原始项目以 MIT 许可证发布，版权归 DeepSeek 所有（见 [LICENSE](LICENSE)）。本 Fork 沿用 MIT 许可证，并保留全部原始版权与第三方声明（见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）。
> - The upstream project is MIT-licensed, Copyright DeepSeek (see [LICENSE](LICENSE)). This fork retains the MIT license and all upstream copyright / third-party notices.
> - 本仓库额外包含由 Fork 维护者开发的桌面客户端（DeepSeekAgent / `dsh` desktop client），其代码同样以 MIT 许可发布。
> - 商标提示：DeepSeek 相关名称为 DeepSeek 的商标。本仓库仅作事实性描述（"基于 DeepSeek Harness 构建"），不构成任何官方关系的暗示。请遵守上游 [BRAND_GUIDELINES.md](BRAND_GUIDELINES.md)。

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It is built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512).

Documentation: [https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## Developer preview

DeepSeek Harness is in _developer preview_ and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

Review the [safety notice](SAFETY.md) before running the project.

## Run

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding.

## Community and support

- Submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
