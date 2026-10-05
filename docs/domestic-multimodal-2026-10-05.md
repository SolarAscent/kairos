# 国内模型与多模态接入（2026-10-05）

主要依据为[生活决策小程序产品与开发说明](https://chatgpt.com/space/page_4d6dfd5f7714819182fb830d7a1c7472)。它是工作中的产品说明，用户在本轮对交互和供应商的调整优先；本轮没有改写该 Page，也没有将其视为冻结版本。

## 本轮界面

首页保持一个主要建议，不再固定询问时长、内容和出门意愿。后端只有在前两名候选接近，且补充答案会改变首选时，才返回一张问题卡片；每个会话最多两问，信息足够就直接建议，选择“先给我一个建议”立即结束提问。问题与答案持久化到会话，可恢复；时长、预算和出门意愿属于当次上下文。

中央＋轻点展开文字、语音、图片卡片。语音按住说话、松手自动收纳、上滑取消；窗口显示波形和逐渐出现、淡出的实时文字。首次进入语音窗口先请求录音授权；按住时授权批准后立即开始录制，建立识别连接期间使用有上限的 PCM 缓存，ready 后按顺序发送。收起、隐藏、卸载、退出会清理录音和连接；失败保留文字草稿，不能伪造收纳成功。

文字、图片提交和语音松手后，首页先出现“正在收纳”的临时卡片。收到真实 Capture 保存回执才提示“已收纳”，模型分析在后台执行，标题先用自然的占位说明，完成后替换为 AI 提炼的短概要。生活列表同步概要标题，不以整段原文作卡片标题。后台处理不阻塞下一次输入。刷新图标仍在生活页右上角。

## 模型配置

推荐 `MODEL_PROVIDER=qwen`，文字／图片使用 `qwen3.7-flash-2026-07-15`，实时语音使用 `qwen3-asr-flash-realtime`。价格和 GLM 备选见[比较文档](domestic-model-comparison-2026-10-05.md)。兼容 Chat Completions 的协议由国内平台提供，调用目标为百炼或智谱。

以下变量只配置在服务端的被忽略 `.env` 或 Secret Manager：

```dotenv
MODEL_PROVIDER=qwen
DASHSCOPE_API_KEY=
DASHSCOPE_WORKSPACE_ID=
QWEN_TEXT_MODEL=qwen3.7-flash-2026-07-15
QWEN_VISION_MODEL=qwen3.7-flash-2026-07-15
QWEN_ASR_MODEL=qwen3-asr-flash-realtime
```

业务空间 ID 使用百炼北京 API Key 页展示的专属 Base URL 中的完整主机前缀，包括 `ws-`。密钥必须属于同一业务空间／地域。客户端仅有自有 API 的地址和微信 AppID，密钥不进入小程序包。

智谱可设置 `MODEL_PROVIDER=glm`、`GLM_API_KEY`、`GLM_TEXT_MODEL=glm-4.7-flash`、`GLM_VISION_MODEL=glm-4.6v-flash`；本轮智谱不提供实时录音输入。选择 Qwen 后 API 与 Worker 都要使用同一模型配置。Compose 已将相应变量注入两者，业务空间 ID 同时传给 API 与 Worker；语音模型配置只由 API 使用。

## 请求与保存

- 已认证的 `GET /v1/media/capabilities` 报告实际配置状态；它不是对厂商网络、账号额度或模型质量的探测。
- 图片经 `POST /v1/captures` 的 IMAGE 输入提交。服务端限制大小、规范 Base64 和 JPEG／PNG 魔数，保存原图资产与 Outbox，再由 Worker 调用视觉模型。
- 语音先经 `POST /v1/media/voice/sessions` 获取60秒内有效的单次票据，再连接自有 `wss://<api-origin>/v1/media/voice/stream`。API检查登录会话并中转到百炼，不暴露厂商凭据。
- 录音采用 PCM 16kHz、16位、单声道，最多60秒。服务端先返回 ready，再接音频帧；客户端在此之前录制并限量缓存。输出 partial、final，结束时输出 done。末帧发送完成后才 finish，服务端等待厂商 session.finished。
- 最终通过 VOICE Capture 自动保存本次识别稿，独立 TRANSCRIPT 资产保存当前录音的原转写、session、provider和model。音频本轮只中转、不落盘；前面已有草稿或多次录音拼接的文字保留为编辑稿，当前出处对应最后一个完成的录音会话。
- Capture、原图、文本和 Outbox 同事务保存；保存回执不等待模型。重复业务提交沿用现有幂等机制。有效被动收纳直接 READY，缺失日期等信息保留于解析审计，不显示无后续流程的“待确认”；这不代表信息已经核实或可以执行。缺模型凭据时保留原始文字／图片并标记解析失败，实时录音则明确不可用，不请求上游。

语音票据是短时连接租赁，不是业务 Capture；每用户最多每分钟12次创建、1条活动录音，适应短录音和上滑取消后的重试。当前票据与转写会话在单个 API 进程内，完成后可在5分钟内提交；服务重启后失效。多实例部署需共享会话存储或固定路由。

## 临时实现边界

本轮图片最多1张、2MiB，仅 JPEG／PNG；这是联调阶段的明确限制，尚未达到产品说明的9张／10MB。图像保存在 PostgreSQL 的受限资产字段，尚未接 COS、图片生命周期和敏感票券加密；不将本轮实现描述为这些生产能力已经完成。

微信开发者工具不能作为真实 PCM 麦克风验证依据，客户端会明确提示使用手机。手机须有录音授权；微信隐私声明需包含实际录音及选图用途，后台 socket 合法域名需配置 `wss://kairos-test.lingnanlaw.com`（另于 request 域名）。已有 HTTPS 反向代理可转发 WebSocket，无需公开额外端口。

## 验证

本地构建、页面事件与录音末帧测试、真实 PostgreSQL / HTTP / WebSocket 集成测试使用受控厂商替身；这些检查证明应用链路，不能证明厂商鉴权或真实模型识别结果。

真实凭据准备后可在独立测试数据库运行：

```sh
pnpm build
MODEL_PROVIDER=qwen TEST_DATABASE_URL=postgres://<local-test-db> node apps/api/scripts/check-domestic-models.mjs --image /absolute/path/synthetic.png --pcm /absolute/path/synthetic-16khz-mono.pcm
```

脚本通过真实 HTTP、WebSocket、Worker 和厂商 API 验证文字、选定图片及选定 PCM 的完整链路，使用随机独立 schema 并清理。仅使用主动准备的合成测试样本，不上传现有用户记录；执行产生小额实际调用费用。未传 `--image` 或 `--pcm` 时只验收文字；缺国内凭据立即报告 blocked，不调用厂商、不更改数据库。回执写入被忽略的 `.local/domestic-models/live-receipt.json`，包含合成样本的概要与分段耗时，不输出密钥或完整识别内容。

本轮已通过真实 Qwen 文字、图片与语音联调；真机麦克风、弱网、授权拒绝和实际图片识别质量须单独验收。

## 即时收纳改版验证

- 完整构建通过；108项单元测试、32项独立 PostgreSQL 集成测试通过；格式检查通过。包含原有权限、幂等、并发租约、延期恢复，以及按住／松手／取消、首授权、尾帧顺序、图片自动提交、失败保留和后台概要更新。
- 本地真实 Qwen / HTTP / WebSocket / Worker 联调中，文字、图片、语音全部 READY，Capture 概要与 `/v1/life` 一致。单次合成样本保存回执7～16ms，模型调用1.89～3.80秒；这些是本地后端指标，不包含手机网络或输入耗时。回执在 `.local/domestic-models/instant-final-local.log`。
- 测试服已发布 `capture-20261005-1940`，数据库容器保持不变。公网 HTTPS/WSS 与实际生产 Worker 的合成样本联调通过：TEXT/IMAGE/VOICE均 READY，概要与生活列表一致；保存回执19～90ms，模型2.438～5.761秒；ASR有20次partial、2次final，finish到done22.5ms（音频已按实时速度发送约4.22秒）；Now返回建议用40ms。数据来自单次服务器探针，不含手机网络，不承诺真机稳定半秒识别。独立probe身份和队列已清理，真实微信登录配置没有改变。回执与截图在 `.local/domestic-models/instant-public-receipt.json` / `instant-public-receipt.jpg`。
- Worker并发上限为2、空闲轮询250ms，同一 Capture 的重复事件避免重复模型调用，过期租约可恢复；解析审计分开保存队列等待与模型耗时。
- 小程序生成包扫描实际服务端密钥字符串，匹配数为0；开发者工具工程私有配置保留。语音动画与手势的真机表现，以及识别在手机上能否稳定于1秒内结束，仍须新版预览验收。

## 历次联调记录

以下记录按迭代保留；早期固定选项、点击开始录音和编辑后提交等交互已被本次即时收纳设计替换。

- 2026-10-05：完整构建和格式检查通过，79项单元测试、24项真实 PostgreSQL 集成测试通过（厂商侧为受控替身）。后续 Skyline 样式修正经过小程序重建及页面测试复验。
- 测试服务器发布 `domestic-20261005-1828`，发布回执为 ready；API / Worker 已更新，原数据库容器保持不变。外网 `/health/ready` 为200，新的 `/v1/media/capabilities` 在无登录时为401，主域名原站点为200。
- 当前开发者工具的 `kairos-staging` 工程已更新生成产物，私有工程配置保留，旧产物备份在工作树的 `.local/deploy/devtools-dist-backup`。原生 Skyline 的滚动选项、加号输入卡片、出门问题卡片、生活页右上角刷新图标经渲染检查；开发工具页面事件验证不能替代手机触摸与麦克风验收。
- 用户已创建并保存专用百炼密钥。本地真实 HTTP / WebSocket / Worker / Qwen 联调通过：TEXT 与 IMAGE 解析成功，合成语音返回20次 partial、最终转写18字，并经 VOICE Capture 生成生活事项；回执在 `.local/domestic-models/live-receipt.json`。
- 测试服 API / Worker 已配置为 Qwen 并重启，健康检查通过、数据库容器不变。密钥以服务器公钥加密传输，服务器私有环境文件权限为600，未进入客户端包或 Git。
- 从服务器容器经真实公网 HTTPS / WSS 接入当前 API 和生产 Worker 的联调通过：TEXT、IMAGE 各生成1个生活对象，实时 ASR 返回20次 partial、2次 final，VOICE 生成2个生活对象。独立 `E2E_PROBE` 身份和对应队列／审计均已清理，微信真实登录配置没有改为 mock。回执为 `.local/domestic-models/public-live-receipt.json`，原始终端截图为同目录 `public-live-receipt.jpg`。
- 当前开发者工具实际点击“说一段话”后，已通过登录后的能力接口，展开语音窗口并提示在手机体验 PCM 录音；开发工具不作为真机麦克风验收。
- 手机首次点击“开始录音”时用户报告“暂时连接不上”。后端已收到其语音会话 POST 并返回201，公网 WSS 探针通过。增加白名单、TLS／证书、握手的脱敏错误分类后，8项诊断测试通过，相关前端38项测试通过。用户关闭旧预览并扫码新版后，已确认手机实时文字可见；首次失败原因未独立确认，不能仅据重试成功断言某个配置错误。
- 用户报告手机开始录音前等待约3～5秒。服务器容器经公网单次计时：会话 HTTP 21.8ms，WSS open 91.5ms，ready 1007.3ms，ready至首次 partial 716.3ms，finish至done 230.9ms。该测量不包含手机网络和录音授权耗时，不作为手机端性能保证；回执为 `.local/domestic-models/public-voice-timing.json`。
- 启动优化已移除每次录音多余的 capabilities GET，直接由真实会话 POST 验证配置；麦克风授权与短时票据请求并行，授权批准和上游 ready 后才开录音，不预连厂商。按请求发出时间保守计算票据年龄，权限确认过慢时重取未使用票据。准备阶段使用自然提示和等待动画；相关前端42项测试通过，TTL修正后页面／启动24项复验通过，小程序重建成功，手机实际提速仍待新版预览重试。
- 用户已确认完成 `wss://kairos-test.lingnanlaw.com` 的 socket 合法域名配置。微信管理后台浏览器操作曾被站点安全策略阻止，本轮没有独立后台读回；录音／相册隐私声明与真机授权仍需实际验收。
- 被忽略目录 `.local/domestic-models/` 已准备主动生成的中文测试图片与16kHz单声道 PCM 合成语音，后续实测不使用现有用户数据。

## 密钥填写入口

用户确认 socket 域名配置完成后，剩余语音配置是百炼默认业务空间的专用 API Key。创建后在被忽略的 `.local/domestic-models/qwen.private.env` 中填写 `DASHSCOPE_API_KEY`，不要放到聊天、小程序或 Git。该文件是本地凭据交接模板；本轮已读取用户保存的密钥，写入本地及测试服 API 与 Worker 的服务端环境并重启服务，真实模型联调通过，手机验收仍需进行。同一百炼密钥可用于 Qwen 文字／图片与实时 ASR，不需另配 TTS。
