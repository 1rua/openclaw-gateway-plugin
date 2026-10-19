# 共享会话管理同步与验证

OpenClaw 插件版本统一为 `1.1.0`，原生宿主范围保持 `2026.7.1-2`。本次将主仓
`f0b3f1bd4f6f3301b820e38c9f3241bcac05cd10` 的完整会话管理补丁合入独立插件，
契约 pin 和完整生成快照固定到同一主仓提交。

## 基线与行为

独立仓基线为 `97200b89ff2191b940fcff3862eec53685688700`，其 tree
`21d123c2fb0f664fbce4f579ab2ddcf92aa462ed` 与原主仓插件 pin
`432e7c0545ecfe36af25fd4c451d777d434ae8fc` 完全相同。补丁在该干净基线上先通过
`git apply --check`，再完整应用，保留现有主分支的原生会话与取消修复。

- `conversation-management-v1` 仅在宿主原生生命周期 API 可用且客户端提出时协商。
- 会话列表按账号分页，归档、恢复和删除写入 OpenClaw 原生 API；文件夹与自定义顺序使用账号范围 CAS。
- 原生操作前持久化设备与请求身份，原生成功但回执落盘失败时支持重启后同 ID 恢复。
- 删除和待确认屏障保护读取、发送与重新绑定。旧原生存在证据绑定 `storePath/sessionKey`，合法新路由不继承旧路由的删除依据。

静态清单与源码、runtime 均声明会话管理能力。包、锁文件根节点与原生清单版本均为
`1.1.0`，依赖解析完全未变。构建工具补齐 runtime 共享向量复制，保持独立仓构建与原补丁
helper 的 61 份发布产物一致。CI 的构建后 `git diff` 与未跟踪 runtime 门禁保持原样。

## 验证结果

完整执行记录位于 [evidence/2026-10-19-conversation-management](./evidence/2026-10-19-conversation-management)。

| 检查 | 结果 |
| --- | --- |
| 契约工具 Python 测试 | 5 项通过 |
| pin 检查、重新生成及目录 diff | 全部通过，生成快照包含 26 个文件 |
| TypeScript 类型检查 | 通过 |
| 完整 npm 测试 | 37 文件、208 项通过，耗时 78.32 秒 |
| 原始 host-turn 边界 | 24 项仍随全套运行；测试文件与基线逐字节相同 |
| 新会话管理回归 | 源码与编译产物共 22 项，覆盖真实原生生命周期、协商、receipt 恢复与重绑定 |
| 连续两次构建 | 均与同一份 61 文件 SHA-256 清单完全一致 |
| runtime 单独执行共享向量 | 70 项通过，直接读取包内契约 |
| 原始契约字节 | 主仓、源码快照、runtime 的 10 份 Schema、10 份向量及分派索引全部一致 |
| 原生安装与加载 | OpenClaw `2026.7.1-2` 官方安装成功，`1.1.0` 状态为 `loaded`，channel/tool 齐全，diagnostics 为空 |
| 已安装运行包 | 与审查清单的全部 61 份文件逐字节一致 |

CORE 为 `sha256:032f580246eb4a214624bded717819b4d5a76191208207edc9e5a4607f5c4d23`。
原始 host-turn 测试文件 SHA-256 为
`7a14031e8d925fb79eaaee30a5e089b8eafda8e116f566796dfddf29a2df179e`。

本地验证复用了同一锁文件下的依赖副本，`npm ls --depth=0` 确认所有固定版本。
使用 Node `24.18.0`、npm `11.16.0`、Python `3.12.14`，临时目录均位于磁盘上的
`/workspace/gateway-sync/tmp/openclaw`；测试与原生安装使用独立的 OpenClaw home/state，
没有修改主仓 `.openclaw-gateway-plugin` 的代码或安装。

## 执行命令

先设置固定工具链、独立临时路径和主仓契约源：

```bash
export PATH=/workspace/open-android-intelligence/.toolchains/node-v24.18.0-linux-x64/bin:/workspace/toolchains/oai-python/bin:$PATH
export TMPDIR=/workspace/gateway-sync/tmp/openclaw
export OPENCLAW_HOME="$TMPDIR/test-home"
export OPENCLAW_STATE_DIR="$TMPDIR/test-state"
export OPEN_ANDROID_GATEWAY_CONTRACT_ROOT=/workspace/open-android-intelligence/gateway-contract
```

契约生成后，以生成目录替换包内快照，再执行检查。以下输出目录要求尚不存在：

```bash
npm run contract:generate -- --output "$TMPDIR/generated-contract"
diff -qr "$TMPDIR/generated-contract/gateway-contract" gateway-contract
python tools/test_contract_source.py
npm run contract:check
npm run typecheck
npm test
npm ls --depth=0
```

构建前从补丁提供、同步原始契约字节并更新静态能力后的 runtime 记录审查清单。
使用主仓的清单工具，两次构建分别检查新增、删除和内容字节；两轮均通过：

```bash
manifest_tool="$OPEN_ANDROID_GATEWAY_CONTRACT_ROOT/patches/conversation-management/runtime-build-manifest.py"
python "$manifest_tool" --runtime-root runtime --write /workspace/gateway-sync/evidence/openclaw/runtime-reviewed.json
npm run build
python "$manifest_tool" --runtime-root runtime --compare /workspace/gateway-sync/evidence/openclaw/runtime-reviewed.json
npm run build
python "$manifest_tool" --runtime-root runtime --compare /workspace/gateway-sync/evidence/openclaw/runtime-reviewed.json
```

原生 smoke 直接执行仓库 smoke 脚本中的官方安装命令，避免第三次重复构建；加载结果由仓内断言工具验证：

```bash
export OPENCLAW_HOME="$TMPDIR/smoke-home"
export OPENCLAW_STATE_DIR="$TMPDIR/smoke-state"
./node_modules/.bin/openclaw plugins install ./ --force
./node_modules/.bin/openclaw plugins inspect open-android-intelligence-gateway --runtime --json > /workspace/gateway-sync/evidence/openclaw/native-inspect.json
node tools/assert-openclaw-runtime.mjs < /workspace/gateway-sync/evidence/openclaw/native-inspect.json
```

发布安装仍应固定通过 CI 的完整插件提交 SHA。Android APK 需来自主仓 `f0b3f1bd` 或使用相同
契约的更新提交。这里的结果证明本地插件验证，不代表远端 CI 或手机部署完成；本次没有发布标签、
合并分支或部署用户宿主。
