# 开发与验证

Node.js 24，pnpm 11.25.0，PostgreSQL 17。复制 `.env.example` 后填写本地数据库连接和随机 JWT 密钥。`.env` 不进入 Git，也不进入镜像。

## 本地

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm db:migrate
pnpm dev:api
# 另外两个终端：
pnpm dev:worker
pnpm dev:demo
```

`dev:*` 使用共享包的 `dist`；修改 contracts/domain/agent-core/db 后重新执行 `pnpm build`。网页只用于本地调试，正式客户端仍采用微信原生小程序。网页通过 `VITE_API_BASE_URL` 指向 API，默认 `http://localhost:3000`。

原生工程位于 `apps/miniprogram`，使用 `pnpm build:miniprogram` 构建并导入生成的 `dist`。本地模拟与真实微信的配置、部署准备和验收步骤见[微信接入说明](wechat-setup.md)。

`.env.example` 推荐 `MODEL_PROVIDER=qwen`，使用服务端 `DASHSCOPE_API_KEY`；文字和图片默认固定 `qwen3.7-flash-2026-07-15`。实时语音还需要北京业务空间的 `DASHSCOPE_WORKSPACE_ID`，使用 `qwen3-asr-flash-realtime`。`MODEL_PROVIDER=glm` 可选择智谱文字／图片模型和 `GLM_API_KEY`。价格与选择依据见[国内模型比较](domestic-model-comparison-2026-10-05.md)，接入与验收见[本轮说明](domestic-multimodal-2026-10-05.md)。

没有模型凭据时可显式设置 `MODEL_PROVIDER=mock` 体验原文本闭环。真实模型未配置或失败时不会自动切换 Mock；文字和图片原始输入保留，缺配置直接标记解析失败，临时模型故障进入 Outbox 重试，最多 8 次。`GET /v1/media/capabilities` 明确报告图片和实时语音是否配置，语音缺配置不启动录音或上游请求。生产禁止 `WECHAT_MOCK_LOGIN=true`。

本轮情境、行动规划、实际时间消耗与内部开始／完成闭环，以及腾讯位置服务配置和当前能力边界，见[后端规划说明](backend-planning-2026-10-05.md)。

## 验证

```sh
pnpm format:check
pnpm typecheck
pnpm test
TEST_DATABASE_URL=postgres://user:password@localhost:5432/life_test pnpm test:integration
```

集成测试使用独立随机 schema，结束后清理该 schema；请指定本地测试数据库。覆盖 HTTP、认证隔离、事务幂等、Worker、模型失败及租约/删除竞态，不调用真实外部服务。CI 另构建三个 Docker target。

## 数据迁移

`pnpm db:migrate` 按名称执行 `packages/db/migrations` 中的编号 SQL，事务内记录已执行版本，并用 PostgreSQL 锁防止并发迁移。不要改写已应用的迁移。

`pnpm db:generate` 只在 `packages/db/migration-drafts` 生成供审查的草案。手写基线未包含 Drizzle snapshot，首次生成可能是全量建库 SQL，不能直接复制到已有数据库执行；应审查差异，另写下一个编号的增量迁移。

Compose 的 migrate 服务完成后才启动 API 和 Worker。默认端口只绑定本机；示例口令只用于本地开发。
