# 首轮实施计划与验收边界

## 产品依据

按 Space 已冻结的 Demo 范围实现一条闭环：Capture → Parse → Life → Context → Now → Feedback。保持模块化单体；API 与 Worker 分进程运行；PostgreSQL 是唯一业务事实源，文件服务与外部 Provider 通过接口隔离。首轮不加入 Redis、BullMQ、pgvector、微服务、Agent Runtime 或真实票券核销。

## 先后顺序

1. 仓库骨架：pnpm workspace、统一 TypeScript/Zod 契约、Drizzle schema、可重复迁移、PostgreSQL 本地环境。
2. 认证与 API 基础：微信 code2Session adapter、本地开发模拟 Provider、短期 JWT、哈希存储且轮换的 Refresh Token、request_id/trace_id、统一错误响应、健康检查及 OpenAPI。
3. Capture 管线：写 Capture 与 CAPTURE_CREATED Outbox 事件在同一事务提交；先回执 capture_id；Worker 幂等抢占 Outbox，以受约束 Provider 解析，持久化对象、Facet、Relation、来源及可重建投影。
4. Now Engine：从投影召回当前用户的对象，先做明确硬约束过滤，再按 Git 管理的评分权重排序；保存会话、候选与推荐不可变快照，只给一个行动或 QUIET。
5. 反馈学习：反馈事件按 client_event_id 去重并追加保存；Outbox Worker 异步生成单条偏好信号；不将未经确认的推断展示成事实。
6. 演示接线：提供极薄的本地页面展示登录、输入、处理中状态、生活对象、情境、推荐及反馈。后续原生小程序复用 API 契约，不在此处引入跨端框架。

## 第一轮直接演示的验收路径

- 新用户可在本地模拟登录，拿到 bearer access token 和 refresh token；生产默认不允许模拟登录。
- 提交一段文字后立即得到 capture_id；在后台处理完成前 Capture 和原文已保存在数据库。
- Worker 处理同一事件不产生重复 Life Object；失败保留原 Capture 并按退避策略重试，超过上限标记失败。
- 用户只能读取自己名下的 Capture、Life Object、决策会话和反馈。
- 空记录时 Now 返回 QUIET；存在合适记录时保存评分明细并只返回一个主要行动。
- 接受或跳过操作写为不可变事件，重复 client_event_id 不产生重复偏好信号。
- OpenAPI、迁移和启动配置随仓库交付；没有配置的腾讯云、微信、模型服务明确显示为未配置。

## 刻意延后的工作

首轮先交付文本闭环和 Provider 契约；图片上传/COS、语音/腾讯 ASR、腾讯 LBS 实测、正式微信密钥接入、复杂追问策略、导出/账号删除、通知、安全资产/KMS、生产 RLS 运维、监控告警及真机 UI 验收列为下一轮工作。API/Worker 结构已经给这些模块留出边界，但不把接口占位算作已实现功能。
