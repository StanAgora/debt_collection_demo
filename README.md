# AI 催收外呼 Web Demo

一个零依赖 Node.js Web Demo，用来演示债务人管理、计划外呼、预测式外呼路由、Agora Voice Agent 通话回传质检，以及账号管理。

## 启动

```bash
npm start
```

打开 `http://localhost:4173`。

默认账号：

- 管理员：`admin` / `admin123`
- 质检：`qa` / `qa123456`

## 已实现能力

- 债务人信息展示：姓名、电话、欠款金额、合同信息、逾期期数、逾期时间、历史催收、承诺还款、还款状态。
- 计划拨打列表：新增债务人自动进入；有催收记录但仍需复催的客户保留；已还款客户自动移除；展示第几次拨打。
- 预测式外呼模拟：先通过手机外呼 SIP Trunk 呼叫客户，接通后桥接至 Agora SIP 地址。
- 通话路由配置：配置手机外呼 SIP Trunk、Agora SIP 地址、启停状态和绑定关系。
- 质检系统：展示每通通话的摘要、录音地址、转写，并支持人工标签和备注。
- Agora webhook：提供通话记录回传接口。
- 账号管理：新增账号、停用/启用账号、重置密码、基础审计日志。

## Agora webhook 示例

接口地址：

```text
POST /api/webhooks/agora/calls
Content-Type: application/json
```

示例 payload：

```json
{
  "debtorId": "debtor_chen",
  "phone": "+8613810010001",
  "status": "已完成",
  "durationSec": 216,
  "recordingUrl": "https://example.com/recordings/call.wav",
  "transcript": [
    { "speaker": "AI", "text": "您好，这里是还款提醒服务。" },
    { "speaker": "客户", "text": "我三天后先还一部分。" }
  ],
  "summary": "客户承诺三天后部分还款，仍需复催。",
  "promiseAmount": 1000,
  "promiseDate": "2026-10-14",
  "promiseNote": "客户口头承诺部分还款",
  "needRecall": true,
  "repaymentStatus": "未还款"
}
```

默认 Agora SIP 地址已经预置为：

```text
sip:gptest@cn-north-1-sbc.ai.agora.io:5060;transport=tcp
```

当前外呼和桥接是 Demo 层模拟，后续可以把 `/api/calls/:debtorId/start` 替换为真实 FreeSwitch/呼叫平台任务创建逻辑。
