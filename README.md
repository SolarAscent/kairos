<p align="center"><img src="docs/assets/cover-black.svg" alt="此刻：让想做的事，遇见合适的时刻。" width="100%" /></p>

此刻是一款正在开发的生活决策助手。你可以随手留下想去的地方、想看的内容或一直想做的事，它会结合当下的时间和行动条件，帮你找到一个合适的开始，让那些保存过的念头真正走进生活。

我们希望它减轻的是选择的负担：你不必先整理分类，也不用在一长串推荐里反复比较。每次只给出一个有依据的行动，是否接受由你决定；条件不合适时，也可以暂时没有建议。

### 目前做到哪里

当前版本已经跑通文本记录、后台解析、生活事项保存、行动推荐和反馈的后端流程，并提供一个用于本地体验的网页。后端使用 TypeScript、NestJS 和 PostgreSQL，默认通过模拟登录与 Mock 模型验证流程；原生微信小程序、图片与语音输入，以及真实云服务的接入仍在开发计划中。

### 在本地体验

准备好 Node.js 24、pnpm 和 PostgreSQL 后，先将 `.env.example` 复制为 `.env`，填写数据库连接与 JWT 密钥，再执行以下命令：

```sh
pnpm install
pnpm build
pnpm db:migrate
```

随后在三个终端分别运行 `pnpm dev:api`、`pnpm dev:worker` 和 `pnpm dev:demo`，即可打开 [本地演示页](http://localhost:5173) 体验完整流程，并在 [API 文档](http://localhost:3000/docs) 中查看接口。若使用 Docker，也可以在配置完成后运行 `docker compose up --build`，通过 `http://localhost:4173` 访问演示页。

更详细的启动与测试方式见[开发指南](docs/development.md)，当前实现的范围和已知差距记录在[代码审查](docs/code-review.md)中。
