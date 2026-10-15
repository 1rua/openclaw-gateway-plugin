# 更新记录

## 1.0.2 - 2026-10-15

- Agent 与用户附件在发出事件或 ACK 前先采用到宿主长期原件目录，发送临时源退休后仍可读取历史。
- 历史 metadata、cache-grant、content 支持签名 `format=stream-v1`；原件按固定缓冲分块读取，无新增业务大小限制，保留旧有界 JSON/Base64 表示。
- 用户附件历史使用独立索引，不受 ACK 清理临时上传 ID 影响；Agent 纯附件历史与实时 parts 一致，宿主删除后不从残留引用复活。
- 固定契约提交 `851abc44e7ebf5a5aa0ea7ffe311d59be1538058`，构建后保留 Schema 原始字节。App 与插件需要使用相同 CORE 配套升级。
- 临时工作目录回收后，在持久副本重建业务实现并重新验证；新源码指纹与旧本地提交的恢复边界记录在仓库报告中。

## 1.0.1 - 2026-10-08

- 完整声明原生 Gateway channel，补充清洁环境下的固定 Git 提交安装检查。
- 增加从主仓 pin 生成契约快照的 CI 步骤，并完善仓库忽略规则。

## 1.0.0 - 2026-10-08

- 从应用主仓拆出 OpenClaw Gateway 插件并保留目录历史。
- 增加独立 npm 依赖锁、OpenClaw 原生清单、Git 固定版本安装入口和插件 CI。
- 锁定 Gateway Protocol 契约提交，并随插件仓发布生成的契约快照与可加载 JavaScript。
- 保持 Gateway Protocol 2.1.0 与 OpenClaw API 2026.7.1 的兼容声明。
