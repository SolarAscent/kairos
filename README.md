<p align="center"><img src="docs/assets/cover-kairos.svg" alt="此刻 KAIROS：心有所往，行有所时。" width="100%" /></p>

此刻（KAIROS）是一款正在开发的生活决策助手。你可以随手留下想去的地方、想看的内容或一直想做的事，它会结合当下的时间和行动条件，帮你找到一个合适的开始，让那些保存过的念头真正走进生活。

我们希望它减轻的是选择的负担：你不必先整理分类，也不用在一长串推荐里反复比较。每次只给出一个有依据的行动，是否接受由你决定；条件不合适时，也可以暂时没有建议。

### 目前做到哪里

当前版本已经跑通文本记录、后台解析、生活事项保存、行动推荐和反馈的后端流程，并提供本地体验网页和原生微信小程序客户端。后端使用 TypeScript、NestJS 和 PostgreSQL；小程序包含登录、此刻、文字输入与生活列表，支持会话续期及失败重试。已在微信开发者工具中接通真实微信登录与 HTTPS API，并验证文本业务闭环；手机触控、键盘与网络仍待真机验收。其他部署需自行配置 AppID、服务端 AppSecret 和 HTTPS API。图片、语音和云服务仍在后续计划中。

### 在本地体验

准备好 Node.js 24、pnpm 和 PostgreSQL 后，先将 `.env.example` 复制为 `.env`，填写数据库连接与 JWT 密钥，再执行以下命令：

```sh
pnpm install
pnpm build
pnpm db:migrate
```

随后在三个终端分别运行 `pnpm dev:api`、`pnpm dev:worker` 和 `pnpm dev:demo`，即可打开 [本地演示页](http://localhost:5173) 体验完整流程，并在 [API 文档](http://localhost:3000/docs) 中查看接口。若使用 Docker，也可以在配置完成后运行 `docker compose up --build`，通过 `http://localhost:4173` 访问演示页。

更详细的启动与测试方式见[开发指南](docs/development.md)，当前实现的范围和已知差距记录在[代码审查](docs/code-review.md)中。

### 微信小程序

执行 `pnpm build:miniprogram` 后，在微信开发者工具中导入 `apps/miniprogram/dist`。无 AppID 时可先显式配置本地模拟登录；默认不会自动回退。配置步骤、真机接入条件及人工验收项目见[微信接入说明](docs/wechat-setup.md)，分阶段安排见[开发计划](docs/wechat-integration-plan.md)。

### 共同开发

GitHub 是代码协作入口，微信开发者工具用于小程序编译、预览和上传。新成员克隆仓库、安装依赖后，从当前团队分支创建自己的功能分支；通过 Pull Request 审查、CI 检查后再合并。只开发小程序界面的成员可连接团队测试 API，无需获取服务端 AppSecret 或部署数据库。

微信上传权限与 GitHub 写权限分别管理。需要上传的成员应由管理员在对应小程序账号添加为项目成员并开通开发者权限；仅体验成员不能代替开发者权限。具体配置和协作步骤见[多人开发与上传](docs/wechat-setup.md#多人开发与上传)。
