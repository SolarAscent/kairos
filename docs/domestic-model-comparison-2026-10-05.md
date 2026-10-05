# 国内模型选择与接入依据（2026-10-05）

本次按中国大陆人民币 API 价格比较，官方网页与文档已读取。价格是查询时的页面值；免费额度、限流、账号开通条件以实际控制台为准。用户本轮尚未准备 KAIROS 专用 API 凭据；后续检查发现百炼控制台已有登录态，本文件不把文档核对或本地模拟称为真实模型调用成功。

## 建议

KAIROS 首选阿里云百炼北京地域：`qwen3.7-flash` 统一处理文字和图片，`qwen3-asr-flash-realtime` 负责边录音边转文字。前者支持文本、图像和视频输入以及结构化输出；实时 ASR 有明确的双向 WebSocket 音频上传与临时/最终文本事件。需要可重复的模型行为时，可分别固定 `qwen3.7-flash-2026-07-15` 和 `qwen3-asr-flash-realtime-2026-02-10`，并在控制台确认账号可用。

这是基于当前价格、接入复杂度与所需交互作出的工程选择，不是各家模型质量排名。实际中文生活记录、模糊图片及有噪语音仍需相同样本比较。[Qwen 视觉能力](https://help.aliyun.com/zh/model-studio/vision-model)、[实时语音指南](https://help.aliyun.com/zh/model-studio/real-time-speech-recognition-user-guide)

## 文本和图片价格

以下为正常在线调用、未命中缓存、未使用 Batch 的单价。表中输入范围包括整个请求上下文；有图片时也要计入图片 token。长请求需按官方阶梯重新估算。

| 平台 / 模型 ID         | 输入价格（元/百万 token） | 输出价格（元/百万 token） | 本表适用范围 / 能力              |
| ---------------------- | ------------------------: | ------------------------: | -------------------------------- |
| 百炼 `qwen3.7-flash`   |                       0.2 |                       0.8 | 北京，输入 ≤32K；文字+图片，推荐 |
| 百炼 `qwen3.8-flash`   |                       0.8 |                       2.7 | 北京，输入 ≤1M；文字+图片        |
| 百炼 `qwen-flash`      |                      0.15 |                       1.5 | 北京，输入 ≤128K；文字           |
| 百炼 `qwen3-vl-flash`  |                      0.15 |                       1.5 | 北京，输入 ≤32K；文字+图片       |
| 智谱 `glm-4.7-flash`   |                      免费 |                      免费 | 文本；适合作为免费试验备选       |
| 智谱 `glm-4.6v-flash`  |                      免费 |                      免费 | 视觉理解；支持工具调用和开关思考 |
| 智谱 `glm-4.6v-flashx` |                      0.15 |                       1.5 | 输入 <32K；视觉理解              |
| 智谱 `glm-5.3-flash`   |                       0.8 |                       2.8 | 文字、图片、视频、文件；更贵     |

百炼 Qwen3.7-Flash 输入 >32K 至256K 为0.6/2.4元，>256K 至1M为1.2/4.8元（输入/输出每百万 token）。短记录应避免累积无限对话历史。推荐默认非思考模式以降低等待时间和输出消耗。

官方来源：[百炼价格表](https://help.aliyun.com/zh/model-studio/model-pricing)、[智谱价格表](https://docs.bigmodel.cn/cn/guide/start/pricing)、[智谱模型概览](https://docs.bigmodel.cn/cn/guide/start/model-overview)、[免费视觉模型](https://docs.bigmodel.cn/cn/guide/models/free/glm-4.6v-flash)。智谱页面也提供同路径 `.md` 版本，本次网页抓取超时时通过官方 `.md` 补充读取。

## 语音是否需要额外模型

推荐方案需要 ASR 模型。语音先转为文字，再与文字或图片一起提交业务模型。KAIROS 当前需要语音输入和实时字幕，不需要语音播报，因此无需再接 TTS。文本/视觉模型本身不负责该实时录音流。

| 模型                                            | 官方计费                                             | 折算元/分钟 | 接入形态 / 取舍                                            |
| ----------------------------------------------- | ---------------------------------------------------- | ----------: | ---------------------------------------------------------- |
| `qwen3-asr-flash-realtime`                      | 北京0.00033元/秒                                     |      0.0198 | WebSocket 输入音频流，实时识别，推荐                       |
| `qwen3-asr-flash` / `qwen3-asr-flash-filetrans` | 北京0.00022元/秒                                     |      0.0132 | 非实时语音转写 / 录音文件任务                              |
| `glm-asr-2512`                                  | 输入16元/百万 token；官方近似0.0002元/秒，输出不计费 |     约0.012 | 官方示例 POST 完整音频文件，可流式返回；单文件≤25MB、≤30秒 |
| 旧 `glm-asr`                                    | 0.06元/分钟                                          |        0.06 | 文件转写，可流式返回                                       |
| `glm-realtime-flash`                            | 音频0.18元/分钟                                      |        0.18 | 实时音视频交互，成本明显更高                               |

`glm-asr-2512` 的“流式输出”不等同于麦克风音频逐帧上传：已核对的接口示例是 multipart 文件请求，不能据此承诺边说边出现文字。为避免持续分割文件造成重复识别和延迟，本轮使用 Qwen 的实时音频上传协议。Qwen 实时 ASR 北京价格表列出新用户10小时免费额度，有效期90天；文字/视觉模型列出100万 token 免费额度，同样需确认开通时间及控制台实际额度。

来源：[百炼 ASR 价格](https://help.aliyun.com/zh/model-studio/model-pricing)、[GLM-ASR-2512](https://docs.bigmodel.cn/cn/guide/models/sound-and-video/glm-asr-2512)、[GLM-ASR](https://docs.bigmodel.cn/cn/guide/models/sound-and-video/glm-asr)、[智谱语音价格](https://docs.bigmodel.cn/cn/guide/start/pricing)。

示例预算（自算、不是平台套餐）：10,000条记录，每条2,000输入+500输出 token，Qwen3.7-Flash 的业务模型约8元；其中1,000条各录音30秒，实时 ASR 约9.90元，合计约17.90元。未计服务器、存储、网络；图片已转换的 token、系统提示、失败重试和额外模型请求需另计。免费额度不纳入长期预算。

## 服务器协议

密钥只由服务器读取。小程序调用自有后端，后端再调用国内厂商；“OpenAI compatible”描述 API 协议格式，不会把内容送往 OpenAI。

文本/图片 HTTP 可使用百炼北京共享域 `https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`；官方同时提供更推荐的业务空间专用域 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions`。共享域仍出现在官方 Base URL 页面，不应误称失效。将地址可配置，避免把未获得的 workspace ID 写成可工作的地址。认证为 `Authorization: Bearer <DASHSCOPE_API_KEY>`。[Base URL](https://help.aliyun.com/en/model-studio/base-url)

建议请求 `model: "qwen3.7-flash"`、`enable_thinking: false`；需要 JSON 时使用 `response_format: {"type":"json_object"}`，并在提示中明确包含 JSON 输出指令。使用直接 HTTP 时 `enable_thinking` 放在 JSON 顶层，不能照搬 Python SDK 的 `extra_body` 包装。图片传入 content 中的 `image_url`，可用受控图片 URL 或 data URI；后端必须限制输入大小和类型。[兼容 Chat API](https://help.aliyun.com/en/model-studio/qwen-api-via-openai-chat-completions)

ASR WebSocket 北京业务空间地址：

```text
wss://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime
Authorization: Bearer <DASHSCOPE_API_KEY>
OpenAI-Beta: realtime=v1
```

上面是官方实时 ASR 示例给出的地址与请求头。服务器应允许配置 WebSocket URL；新账号通过百炼控制台取得实际业务空间 ID 与同地域 API Key 后才能确认真实连接。[官方实时 ASR 示例](https://help.aliyun.com/zh/model-studio/real-time-speech-recognition-user-guide)

连接建立后发送配置并等待 `session.updated`：

```json
{
  "event_id": "unique-event-id",
  "type": "session.update",
  "session": {
    "input_audio_format": "pcm",
    "sample_rate": 16000,
    "input_audio_transcription": { "language": "zh" },
    "turn_detection": {
      "type": "server_vad",
      "threshold": 0.0,
      "silence_duration_ms": 400
    }
  }
}
```

PCM 单声道16位音频按小块发送：`input_audio_buffer.append` 的 `audio` 字段为 Base64。`conversation.item.input_audio_transcription.text` 的 `text` 是确认前缀、`stash` 是可能修正的后缀；按 `item_id` 替换预览为 `text + stash`，避免重复追加。`conversation.item.input_audio_transcription.completed.transcript` 是该句最终内容，应保留全部已完成句子的文本。

使用 VAD 才能在用户持续说话期间实时显示并自动断句。停止录音后，先发送最后音频，再发送 `session.finish`，等待 `session.finished` 后断开连接；直接关 WebSocket 会丢失当前未完成句子。Manual 模式设置 `turn_detection:null`，需要 `input_audio_buffer.commit` 才触发识别，不能用作本轮边说边显示的默认体验。[客户端事件](https://help.aliyun.com/zh/model-studio/qwen-asr-realtime-client-events)、[服务端事件](https://help.aliyun.com/zh/model-studio/qwen-asr-realtime-server-events)、[交互流程](https://help.aliyun.com/zh/model-studio/qwen-asr-realtime-interaction-process)

视觉字幕的淡入、移出、淡出可以由 UI 控制，保存的数据始终是完整最终文本。不能为了动画删除待提交的记录。

## 微信录音与验证边界

微信 `RecorderManager.start` 的合法格式为大写 `"PCM"`；帧回调 `frameSize` 单位为 KB，当前官方说明帧回调支持 mp3/pcm。建议 `sampleRate:16000`、`numberOfChannels:1`、`format:"PCM"`、`frameSize:4`。4KiB 的16kHz/16位单声道音频约128毫秒（根据字节率推算），适合频繁更新字幕。`onFrameRecorded` 返回 `frameBuffer` 和 `isLastFrame`。[微信 start 文档](https://developers.weixin.qq.com/miniprogram/dev/api/media/recorder/RecorderManager.start.html)、[微信帧回调](https://developers.weixin.qq.com/miniprogram/dev/api/media/recorder/RecorderManager.onFrameRecorded.html)

停止流程需要同时等待录音停止与最后帧，再结束识别；阿里官方微信录音示例使用相同 PCM 参数和这一收尾顺序。页面隐藏/卸载、录音错误、socket中断和超时需要停止录音并清理监听。[阿里官方微信示例](https://help.aliyun.com/zh/isi/user-guide/wechat-mini-program)

微信 start 文档明确采样率在 PC 端不支持设置。本次官方读取没有找到足以确认开发者工具所有版本均可输出相同PCM帧的声明，不能用模拟器成功代替真机采样率和实时帧验证。开发者工具用于布局、按钮、接口调试；真实录音还需手机微信，核对录音权限、隐私声明、帧格式及末句完整性。正式小程序需要配置自有后端 HTTPS/WSS 合法域名，密钥不应下发到小程序。[微信网络规则](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html)

没有账号与密钥时，可完成服务端 adapter、流协议、错误处理、客户端 UI 和本地协议测试；仍需明确保留“真实平台鉴权、真实计费调用、真机麦克风端到端验证”三项待验。获取密钥后应执行文字、图片、实音频转写各一项，以及最终文本提交业务后端和数据库读回。
