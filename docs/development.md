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

`MODEL_PROVIDER=mock` 显式启用规则模拟；`openai-responses` 使用 `.env` 中的 `OPENAI_API_KEY` 和 `OPENAI_MODEL`。未配置或拼错 Provider 会报错。真实模型失败进入 Outbox 重试，最多 8 次，原始输入保留；不会自动改成 Mock 伪装成功。生产禁止 `WECHAT_MOCK_LOGIN=true`。

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
