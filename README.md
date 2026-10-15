# Open Android Intelligence Gateway for OpenClaw

OpenClaw 原生 Gateway 插件，将 Android 设备连接到 Open Android Intelligence Gateway Protocol v2.1。插件发行版本从 `1.0.0` 起独立演进，协议版本 `2.1.0` 和 OpenClaw 宿主版本 `2026.7.1` 分别声明；账号隔离、配对、附件暂存和审计由本插件的 Gateway Core 管理。

## 安装

本轮仓库版本为 `1.0.2`。固定安装入口以发布记录为准；请将下方占位符替换为已经通过
CI 的完整 40 位插件提交 SHA，发布记录提供对应标签后也可按标签安装。

```bash
openclaw plugins install git:github.com/1rua/openclaw-gateway-plugin@<40位插件提交SHA>
```

首次启用后检查插件注册状态：

```bash
openclaw plugins inspect open-android-intelligence-gateway --runtime --json
```

插件只支持清单中声明的 OpenClaw API 版本范围。宿主超出范围时，管理数据保持可读，Gateway 对外服务停止。

## 协议契约

`contract-pin.json` 锁定主仓中唯一维护的 Gateway Protocol 契约提交。仓库内的 `gateway-contract/` 是由该固定提交生成的运行与一致性快照；CI 会逐文件比较 pin 对应的契约与快照。插件安装后使用包内契约，不会在 Gateway 启动时联网下载。

`1.0.2` 固定主仓提交 `851abc44e7ebf5a5aa0ea7ffe311d59be1538058`，CORE 为
`sha256:63223ba149355032800eeae8a9f0827d542bbde7ca9e4eeb19f93df30e7febde`。
用户与 Agent 的附件在发出事件或 ACK 前采用到宿主 `history-media/open-android-intelligence/`
专属原件区，处于 OpenClaw `media/` 缓存清理范围之外。新客户端使用参与签名的查询参数
`format=stream-v1` 按块读取，旧无格式请求保留有界 JSON/Base64 外壳；外壳兼容仅适用于相同
核心摘要，不能让旧 CORE 的 App 登录本轮插件。

若核心 Schema 变化，需先更新本仓契约 pin 与生成快照，再发布插件和 Android 客户端的兼容版本。只升级其中一端会在协议协商时得到 `PROTOCOL_INCOMPATIBLE`。

## 开发与验证

使用 Node.js 24.18.0、npm 11.16.0 与 Python 3.12：

```bash
npm ci
npm run typecheck
python3 tools/test_contract_source.py
npm run contract:check
npm run contract:generate -- --output /tmp/openclaw-generated-contract
npm test
npm run build
npm run plugin:install-smoke
npm run plugin:inspect-smoke
```

`runtime/` 保存固定 Git 安装使用的 JavaScript 入口。`npm run build` 从 TypeScript 源码重新生成该目录，并恢复 Schema 的发布原始字节以保持核心摘要一致；CI 会检查生成结果与已跟踪内容一致。

CI 从 `contract-pin.json` 指向的主仓提交生成契约文件，再将生成结果与包内 `gateway-contract/` 逐项比较。手动生成时，输出目录必须尚不存在：

```bash
npm run contract:generate -- --output /tmp/openclaw-generated-contract
diff -qr /tmp/openclaw-generated-contract/gateway-contract gateway-contract
```

契约快照验证需要一个检出 `contract-pin.json` 所指向完整提交的应用仓库：

```bash
OPEN_ANDROID_GATEWAY_CONTRACT_ROOT=/path/to/checkout/gateway-contract npm run contract:check
```

每个 Gateway 账号拥有独立数据库、密钥来源、附件目录、队列和审计。插件不持有 Android 授权权威，不建立设备正文的长期仓库，也不接管 OpenClaw 的对话和记忆。

## 许可证

MIT，见 [LICENSE](./LICENSE)。
