# 微信小程序接入与联调

此轮提供原生文本客户端和现有 KAIROS API 的接线。没有 AppID 也可编译；只有显式开发配置才能使用本地模拟登录。真实微信登录与 HTTPS API 已在原生开发者工具中验证；云托管、手机真机交互及微信平台审核尚未验收。分阶段范围见[接入计划](wechat-integration-plan.md)。

## 不依赖凭证的本地开发

先按[开发指南](development.md)启动 PostgreSQL、API 和 Worker。服务端本地 `.env` 使用 `NODE_ENV=development`、`WECHAT_MOCK_LOGIN=true` 和 `MODEL_PROVIDER=mock`。客户端另行配置：

```sh
cp apps/miniprogram/config.example.json apps/miniprogram/config.local.json
```

把 `config.local.json` 中 `loginMode` 改为 `mock`，其余默认值保留。该文件已被 Git 和 Docker 忽略。然后：

```sh
pnpm install --frozen-lockfile
pnpm build:miniprogram
pnpm wechat:check
```

在微信开发者工具中导入 `apps/miniprogram/dist`，编译类型为小程序。构建已将 TypeScript、共享 Zod 和 MobX 打包，无需再次点“构建 npm”。构建默认选择 3.7.1 基础库，开发者工具需支持 Skyline。无 AppID 时使用工具支持的游客／测试工程模式，不能据此验证真实微信身份或上传体验版。若当前工具限制游客 Skyline，请用真实开发 AppID 继续验收，不能把网页截图作为通过证据。

本地开发请求指向 `http://127.0.0.1:3000`。仅在本地开发者工具中手动启用“不校验合法域名、web-view 域名、TLS 版本以及 HTTPS 证书”进行调试；仓库默认 `urlCheck=true`。手机的 127.0.0.1 是手机自身，真机需可访问的 HTTPS 测试域名。修改源码后重新构建；`dist` 是生成目录，不在其中手改代码或存放私钥。

打开后点“开发模式登录”，留下文字，在生活页查看原文与后台处理状态，进入此刻选择时间和状态，获取建议并接受／换一个。未登录时不发业务请求；后台理解轮询有次数上限，离开页面停止，回到前台或手动刷新后继续。文本草稿和失败操作键保留在当前页面实例中，关闭整个小程序后不保证恢复；不要将这理解为离线队列。

## 配置真实微信

先准备一个开发／测试小程序 AppID、服务端 AppSecret、微信开发者权限和 HTTPS API 域名。不要在聊天中发送 AppSecret，也不要将它放入 `config.local.json`、小程序源码或 project 配置。

客户端配置例子（AppID 和域名必须替换）：

```json
{
  "environment": "staging",
  "appId": "wx0123456789abcdef",
  "apiBaseUrl": "https://your-api-domain.invalid",
  "loginMode": "wechat",
  "appVersion": "0.2.0"
}
```

构建器拒绝未替换的 `.invalid` 域名。`apiBaseUrl` 只能是 origin，不附带 `/v1`、查询参数或账号密码；路由已由客户端统一添加。可以用 `MINIPROGRAM_CONFIG=/absolute/path/config.json pnpm build:miniprogram` 选择另一份配置。非 develop 环境拒绝 Mock、游客 AppID 和非 HTTPS 地址。运行时也会阻止 Mock 在体验版和正式版登录。

服务端变量以 `infra/wechat-staging.env.example` 为模板，在部署平台 Secret Manager 填写真实值。设置 `NODE_ENV=production` 与 `WECHAT_MOCK_LOGIN=false`；staging 同样使用生产级启动校验。执行：

```sh
pnpm wechat:check
pnpm wechat:check:server
```

服务端预检读取本地 `.env` 或进程环境变量，仅报告缺失项，不输出密钥；通过只证明格式和前后端 AppID 一致，不证明微信已接受凭证。一个 API 部署绑定一个微信 AppID；不同环境的数据库、微信配置和密钥分开。

登录链路为 `wx.login → /v1/auth/wechat/login → code2Session → 内部 userId + Access/Refresh Token`。微信 session_key 不返回客户端也不进入日志。code2Session 不盲目重试；Refresh Token 轮换响应丢失时客户端要求重新登录。业务写操作在当前页面内保留 UUID，请求超时后重试同一内容沿用原键；修改文本会产生新操作。

## 测试环境部署准备

优先复用已有服务器，使用 `infra/compose.wechat-staging.yml` 隔离部署 API、常驻 Worker 和 PostgreSQL。无需为首轮联调新购云服务。现有服务器的续费、带宽与流量费用仍按原套餐计算；此方案不自动续费或升级。CloudBase 云托管保留为后续迁移选项，但需要另行确认常驻 Worker 和 PostgreSQL 的完整报价。

Compose 项目名为 `kairos-staging`，独立网络与数据库卷；API 只绑定宿主机 `127.0.0.1:3100`，数据库不发布端口。运行期 API、Worker、数据库内存上限合计 1408 MiB、CPU 配额合计 1.25 核；迁移另限 256 MiB / 0.25 核。上限并非资源预留，Docker 构建也不受这些运行期限额约束，应在低负载时构建并观察现有应用。API/Worker 使用非 root 用户、只读根文件系统、临时目录和轮转日志。健康检查为 `/health/live` 和 `/health/ready`。

在服务器的新发布目录中准备代码和被 Git 忽略的 `.local/wechat-staging.env`，参考 `infra/wechat-compose.env.example`。数据库密码与 JWT 密钥分别生成至少 32 字节随机值（如各运行一次 `openssl rand -hex 32`），设置文件权限为 `600`。数据库密码使用十六进制，避免拼接连接字符串时出现 URL 转义问题。AppSecret 仅注入 API，Worker 与迁移任务不接收微信密钥。不要把真实环境文件写入云助手命令历史或日志，也不要把 `docker compose config` 的展开结果贴到聊天。

```sh
# 用当前发布版本作为唯一 tag，替换以下占位 tag。
docker build --target api -f infra/Dockerfile -t kairos-staging:release-REPLACE .
# 将相同 tag 写入 .local/wechat-staging.env 的 KAIROS_IMAGE。
docker compose --env-file .local/wechat-staging.env -f infra/compose.wechat-staging.yml config --quiet
docker compose --env-file .local/wechat-staging.env -f infra/compose.wechat-staging.yml up -d
docker compose --env-file .local/wechat-staging.env -f infra/compose.wechat-staging.yml ps -a
curl --fail http://127.0.0.1:3100/health/ready
```

`api` 镜像包含同次构建的 Worker 和迁移代码，各服务明确指定入口，避免重复构建。先迁移隔离的 staging 数据库，成功后才启动 API 和 Worker。缺少任一 Compose 必需变量即停止。发布前记录镜像 tag；回退时切回上一 tag 并重新 `up -d`，数据库迁移不自动回退。暂停本环境可执行同一 Compose 命令的 `stop`；不要执行 `down -v` 或删除既有应用的容器、网络、卷。

HTTPS 使用 `infra/Caddyfile.wechat-staging.example` 的独立站点块。先确认自有测试子域名 DNS 指向服务器、网关采用 host 网络并可访问 loopback、3100 端口空闲，再备份现有 Caddyfile，仅追加新站点块。执行 `caddy validate` 成功后热加载，不替换整份配置、不重启现有应用。公网只代理 `/v1/*` 与健康检查，Swagger 不通过此入口公开。申请证书前应确认 DNS；公网路由启用后同时验证原站点及新测试域名。尚未完成生产限流，测试入口仅供受控联调，不据此开放正式运营。

这份文件是部署准备材料；真实镜像构建、服务启动、证书签发、域名准入与真机登录各自需要成功回执，不能由 Compose 校验代替。

为 API 配置有效 HTTPS 域名及证书，在微信控制台按最新要求配置 request 合法域名和适用的隐私说明。确认 API 可以访问微信服务，API 和 Worker 可经私网访问同一 PostgreSQL。生产数据库不对公网开放。纯 wx.request 接入不需要浏览器 CORS 豁免；网页 Demo 的跨域配置另行管理。

2026-10-05 更新：文本、图片、流式语音输入及腾讯地图 WebService 已接入测试环境。录音与位置仅由用户主动操作触发，地图 Key 和模型密钥仅供服务端使用。地址解析、坐标保存及双向步行路线已通过真实服务验收，手机定位及正式发布所需的平台隐私配置仍须分别验证，详见[腾讯地图接入说明](tencent-map-setup-2026-10-05.md)与[多模态接入说明](domestic-multimodal-2026-10-05.md)。当前没有 `wx.cloud.callContainer` 通道，使用 HTTPS + wx.request 及语音 WebSocket；如果后续选择云托管专用调用，应新增 transport adapter 并独立验收。

尚未实现发布上传自动化；取得 AppID、代码上传密钥和测试环境后再配置 miniprogram-ci。不要将构建通过理解为发布条件齐备：完整隐私设置、账号删除／导出、生产限流和 RLS 等仍在后续计划。

## 自动与人工验收

```sh
pnpm format:check
pnpm build
pnpm exec vitest run tests/unit
TEST_DATABASE_URL=postgres://user:password@localhost:5432/life_test pnpm test:integration
```

数据库测试创建随机 schema 后清理，不使用真实账号或微信服务。它将原生请求客户端接到 HTTP API 和真实 PostgreSQL，检查一次已提交但回执丢失的 Capture 重试不会重复建记录，再验证 Worker、Life、Now、Feedback 与注销。单元测试覆盖微信响应分类、刷新并发、退出竞态和环境门禁。

以下项目必须在有真实凭证后逐项执行，并记录日期、基础库、手机系统与结果：

- 微信首次登录和同账号再次登录映射到同一个内部 userId；另一微信账号看不到前者记录。
- 文本提交即时回执，Worker 完成后列表更新；后台切换和返回无无限轮询。
- API 暂停／断网时保留当前输入，重试不重复保存；登录 code 失效时能重新登录。
- Access Token 过期的并发请求只刷新一次；Refresh Token 失效或响应丢失时重新登录。
- 接受／更换反馈不重复写，已跳过对象在当前轮不重复推荐；无候选显示空态。
- 退出后本机内容和令牌清除；弱网退出明确提示远端撤销可能未完成。
- 小屏、刘海屏、键盘弹出、长文本、基础库兼容、触控和读屏标签通过实际页面检查。
- 体验版关闭域名校验豁免，真实登录模式通过；没有密钥进入客户端包。

平台参考：[微信登录](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/login.html)、[网络请求](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html)、[官方 Skyline 示例](https://github.com/wechat-miniprogram/miniprogram-demo)。微信文档站在本次检索中无法直接打开，控制台要求以接入时可访问的官方说明为准。

## 当前联调交接（2026-10-04）

HTTPS 测试入口为 `https://kairos-test.lingnanlaw.com`，已在原生开发者工具使用真实微信登录并跑通文本业务 API。准确的完成范围、运行时修复和待验收项见[联调更新](wechat-integration-plan.md#原生微信联调更新2026-10-04-2318)。

打开 `apps/miniprogram/dist` 项目后点击“预览”，使用有权限的微信扫码。依次操作微信登录、＋、输入一句测试文字、留下、生活、此刻、给我一个建议、就做这个、退出重登。检查触控、键盘遮挡、真实网络和重登后数据；预览二维码过期后重新生成。当前是开发预览，尚非审核通过的正式小程序。不要关闭 HTTPS 或合法域名校验来掩盖接入问题。

## 多人开发与上传

### 拉取与本地配置

首轮协作版本位于 `codex/wechat-integration`；其 Pull Request 合入后，新开发从 `main` 开始。每位成员使用自己的本地工作目录和功能分支：

```sh
git clone https://github.com/SolarAscent/kairos.git
cd kairos
git switch codex/wechat-integration
git switch -c codex/your-feature
pnpm install --frozen-lockfile
cp apps/miniprogram/config.example.json apps/miniprogram/config.local.json
```

仅开发小程序时，把 `config.local.json` 设置为 `staging`、团队的小程序 AppID、团队 HTTPS API 地址及 `loginMode: wechat`。AppID 与 API 地址由项目负责人提供，不需要服务端 AppSecret。执行 `pnpm build:miniprogram`，用本人微信登录微信开发者工具，导入 `apps/miniprogram/dist` 并选择不使用云服务。每次修改 `src` 后重新构建，禁止直接修改生成的 `dist`。本地模拟后端配置见本文前面的章节。

提交前运行 `pnpm format:check`、`pnpm build` 和 `pnpm exec vitest run tests/unit`；修改后端时同时运行独立测试数据库上的集成测试。推送自己的分支并创建 Pull Request，由另一名成员审查后合并。GitHub Actions 验证构建、单元／PostgreSQL 集成测试和 Docker 镜像；当前流程不自动部署服务器或上传微信版本。

`.env`、`config.local.json`、`.local/`、开发者工具私有设置、代码上传私钥与 AppSecret 均不进 Git。后端维护者独立管理服务端配置，前端成员连接测试 API 即可。需要修改测试后端时协调部署版本，避免客户端接口与线上版本不一致。

### 添加开发者与上传

管理员在正确的小程序账号中进入“成员管理”，将对方添加为“项目成员”，核对微信身份并开通“开发者权限”，完成平台要求的确认流程。后台具体入口名称以当前界面为准；“体验成员”用于体验版测试，不等同于开发者。对方用获授权的微信登录开发者工具后，即可对该 AppID 开发、预览和上传代码。

代码上传、提交审核和正式发布是不同步骤。普通协作者需要开发者权限；需要负责审核、发布、回退的成员，再由管理员单独分配相应“开发管理”权限。GitHub 仓库成员需要另在仓库 Settings → Collaborators 添加；没有仓库写权限的成员也可以通过 fork 提交 Pull Request。

上传前确认本地代码来自已审查的提交、真实微信登录模式、正确的 API 环境和开启的域名校验。在开发者工具“上传”填写版本号与说明，说明中记录 Git 提交短 SHA；然后到微信后台版本管理查看开发版本。只有开发者测试通过后，再由负责发布的人安排体验版、审核和正式发布。

微信官方流程参考：[协同工作和发布](https://developers.weixin.qq.com/miniprogram/dev/framework/quickstart/release.html)。本次官方文档页未能通过检索工具直接读取，后台角色及确认步骤请以管理员当前可见界面为准。
