# AI 催收外呼 Web Demo

Node.js 业务页面 + FreeSWITCH SIP 服务器。软电话注册为分机 `1001`，在页面选择客户并点击“呼叫分机”后，分机先响铃；接听后 FreeSWITCH 才呼叫 Agora Voice Agent 并桥接双向音频。

```text
Web → Node.js → ESL → FreeSWITCH → 分机 1001 响铃
                                  ↓ 分机接听
                            呼叫 Agora SIP 入口
                                  ↓ Agora 接通
                     软电话 ↔ FreeSWITCH ↔ Agora AI
```

当前 Agora 默认入口：

```text
sip:gpcz0@cn-north-1-sbc.ai.agora.io:5060;transport=tcp
```

这个模式用软电话扮演客户，不拨打客户手机号。分机不能自行拨号转接；呼叫由页面发起。

## 计划拨打

“计划拨打”是左侧与催收工作台、质检系统并列的独立页面，集中提供待拨客户列表、路由选择、呼叫分机、进行中通话状态及挂断操作。催收工作台保留客户资料、统计概览和通话历史入口。

### Agora 入参预览

在“计划拨打”中点击待拨客户卡片，或点击“查看 Agora 入参”，可打开该客户的 JSON 预览。预览采用 `agent_properties.llm.template_variables` 结构，全部变量值为字符串，并提供字段来源及未填写原因。点击“呼叫分机”不会触发预览。

发起通话时，后端按最新资料生成 `agoraInput` 快照，并生成随机的 16 位英文字母/数字 `taskId`（检查现有通话避免重复）。分机接听后，FreeSWITCH 发往 Agora 的 TCP SIP INVITE 携带以下两个 Header，分机侧不携带：

- `X-Switch-Id: <taskId>`：每次新呼叫生成新 ID；同一呼叫的 SIP 重传沿用原 ID。
- `X-Customer-Str: <Base64>`：`Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')`，编码整个 `agent_properties.llm.template_variables` 外层 JSON，标准 Base64，单行、无压缩、无换行。JSON 使用紧凑格式，解码后与预览结构一致。

质检详情展示 task ID、发起时的 JSON 和 Header 快照、字节数及传递状态，之后修改客户资料不会改变该次快照。状态区分 Header 已准备、Agora 通道已创建、已桥接和已按 task ID 收到回调；这些状态不表示 Agent 已确认采用全部变量。现存旧通话不补造 task ID 或已发送参数。

### 长 SIP Header

应用限制 `X-Customer-Str` **值**最多 65,536 字节（64 KiB，约可容纳 48 KiB 的 UTF-8 JSON；中文按 UTF-8 字节计算）。预览展示当前大小；超限时拨号接口返回 HTTP 413，不创建通话、不拨号、不截断参数。需要精简历史摘要/输入内容再重试；完整通话历史仍保留。当前 `call_context` 会汇总逐通历史，若仅修改整体总结后仍超限，需要后续接入历史摘要压缩逻辑，不能绕过长度检查。

已使用本项目固定镜像的 FreeSWITCH 1.11.3，在隔离网络中验证 2,048、16,384、65,536 字节 Header 均能完整发送到模拟 Agora TCP 接收端，并逐字节比对 Base64、解码 JSON 和 task ID。最大测试 INVITE 为 66,670 字节。现有 FreeSWITCH 配置即可发送，无需添加未经确认的消息长度配置。64 KiB 是本应用实测后的保护上限，不是 FreeSWITCH 极限，也不是 Agora SBC 的接收能力承诺；Agora 侧上限及实际变量使用情况仍需联调。

| 参数 | 当前来源与规则 |
| --- | --- |
| `app_name` / `platform` / `channel` | 独立的欠款 APP、欠款平台、引流渠道字段；三项均为必填 |
| `name` / `gender` | 姓名、性别；未知或未填写时省略 |
| `overdue` / `contract_overdue` | 当前逾期金额（如 `296元4角`）及逾期期数 |
| `commitment` / `complaint` | 客户整体承诺历史和投诉历史；不用于推断上一通电话的结论 |
| `calls_records_connected` / `calls_records_time` | 最近一通电话的接听状态和开始时间；时间输出为 `+08:00` |
| `calls_records_prev_commit_time` | 仅使用上一通电话 Webhook 明确回传的 `promiseDate`，不使用客户累计承诺日期代替 |
| `call_context` | 全部历史记录去重后的按时间汇总，包含已维护的整体总结；本阶段不调用 AI 生成总结 |

暂无数据的上一通还款能力、异常、投诉、核身、争议、意愿，以及合同总期数/已还/未还期数和 `max_ptp_date` 均暂不填入。`max_ptp_date` 表示本通允许的最晚还款时间，不能用历史承诺日期代替。`permission`、`redline`、`strategy`、`target` 留待后续 AI 策略大脑接入。

登录后可通过 `GET /api/debtors/:debtorId/agora-input` 获取相同的预览；接口只读取现有资料，不发起通话或发送参数。

## 债务人资料与通话历史

债务人列表提供姓名、电话号码、性别、欠款 APP、欠款平台、欠款引流渠道、当前逾期金额与期数、是否有过承诺、是否有投诉历史及通话历史总结。点击“编辑”可维护这些资料，原有合同、产品、逾期天数和还款状态仍保留。APP、平台和渠道在新增/编辑表单和后台接口中均为必填，不接受空白值；部分更新允许省略未修改字段，发起呼叫时也会检查三项是否完整。

每条债务人记录都有“通话历史（条数）”入口，按时间倒序展示该客户的全部通话，包括失败、未接通和进行中的拨打；可进入单通电话的录音地址、转写与质检详情。旧数据中只有历史摘要的记录也会保留展示，并与完整通话记录去重。

通话历史总结可人工填写；留空时明确展示“最近一次”通话摘要，不自动生成多次通话的 AI 总结。数据版本 4 会一次性补齐旧债务人缺失的来源资料：APP「钱小乐」、平台「召集令」、渠道「榕树贷」，采用此前提供的演示示例，保留已有非空值。列表、编辑窗口和入参字段来源中标注演示资料；后续可修改成实际资料。新建债务人不会自动套用演示值。原有通话快照不改写。性别、承诺和投诉情况仍保持“未知”；已有承诺还款记录会标记“有过承诺”，清除当前承诺不会抹掉这一历史标记。

## 服务监控

左侧“服务监控”页面每 10 秒读取一次检测结果，也可手动刷新。`GET /api/monitor` 需要登录；检查结果在后台共享缓存 10 秒，避免重复探测。

- 后台服务：Node.js / Web API 的运行时长和内存、FreeSWITCH 核心与 internal/external SIP profile、ESL 事件同步、JSON 数据读取及读写权限、Agora 结果回传接口配置和最近回传时间。回传接口、呼叫控制和数据访问由现有 Node.js 进程提供，并非独立容器。
- SIP 分机：展示路由中配置的分机及当前实际注册的分机、注册状态、软电话客户端、连接 IP/传输协议和注册剩余时间。无法读取 FreeSWITCH 注册表时显示“状态未知”，不误报为“未注册”。
- Agora VoiceBot：检查启用路由对应 SIP 入口的 TCP 连通性，显示当前已桥接会话数及最近成功桥接时间。检测从 Web 容器发起，不发送 SIP INVITE、不创建 AI 通话。尚未配置 Agora 的运行状态 API，因此“入口可达”不等于 VoiceBot 已运行或音频正常；当前无已桥接会话时明确标注 VoiceBot 状态待验证。
- 通话计划生成Agent、债务人全生命周期策略编排Agent、金标质检Agent、分案管理员Agent：均按演示需求显示“运行正常”，同时标记“演示状态 · 待接入真实 Agent”。

监控页面请求失败时会提示状态待确认，并标出上次检测时间，不将旧的正常结果作为当前状态。页面打开后若 Node.js 停止，可显示请求失败；刷新整个网页时仍依赖 Web 服务可用。本页面不使用 Docker 守护进程接口，展示的是应用层健康状态。

## 启动：推荐公网 Linux 主机

需要 Docker 和 Docker Compose 2.24+。默认采用已固定 digest 的社区镜像 `safarov/freeswitch`（验证版本为 1.11.3），不是 Agora 托管服务。镜像为 amd64，Apple Silicon 通过模拟运行；可在 `.env` 换成自己维护的兼容镜像。

1. 生成 `.env`，把下面 IP 替换成服务器实际公网 IPv4。脚本会生成独立的随机 ESL 密码、分机密码和 Webhook token，不覆盖已有配置。

   ```bash
   node scripts/setup-env.js 203.0.113.10
   ```

   或复制 `.env.example` 为 `.env`，填写 `FREESWITCH_PUBLIC_IP` 并替换全部密码占位符。`203.0.113.10` 只是文档示例，不能用于真实通话。

2. 启动（Linux host 网络减少 SIP/RTP 的 Docker NAT 问题）：

   ```bash
   docker compose -f compose.yaml -f compose.linux.yaml up -d --build
   ```

3. Web 仅监听服务器本机 `127.0.0.1:4173`。在本机部署时打开 <http://localhost:4173>；远程服务器可以通过 SSH 转发访问：

   ```bash
   ssh -L 4173:127.0.0.1:4173 user@your-server
   ```

默认 Web 账号：管理员 `admin / admin123`；质检 `qa / qa123456`。已有 `data/db.json` 会保留；首次启动自动迁移默认路由到分机 1001 和新 Agora 地址，自定义旧 Trunk 路由会停用，待手动确认。

## 在 Mac / Docker Desktop / OrbStack 上启动

```bash
# 使用软电话能访问的 Mac IPv4 初始化配置；已有 .env 就直接编辑。
node scripts/setup-env.js 192.168.1.10
# 使用桥接网络和端口映射，不能套用 Linux host 网络配置。
docker compose up -d --build
```

这可以用于本地注册、振铃和信令验证。**局域网 IP 不能保证 Agora 能回传音频**：跨公网双向语音需要 FreeSWITCH 的可达公网地址，以及路由器将 SIP/RTP 端口转发到 Mac。运营商 CGNAT 下通常无法做入站端口转发，建议部署到公网 Linux 主机。

软电话和 FreeSWITCH 在同一台 Mac 时，也建议使用 Mac 的局域网 IP 作为代理地址，并将 SIP 身份设置为 `sip:1001@demo.local`。使用 `127.0.0.1` 可能让 Linphone 在 Contact 中携带容器无法访问的回环地址，导致收不到 ACK、接听约 32 秒后自动挂断。如果使用公网地址，同网段软电话还取决于路由器是否支持 NAT 回环。

## 软电话配置

例如 Linphone，添加一个普通 SIP 账号（不是 Linphone 云账号）：

| 字段 | 值 |
| --- | --- |
| SIP 身份 / 地址 | `sip:1001@demo.local` |
| 用户名 / Authentication ID | `1001` |
| 密码 | `.env` 中的 `SIP_EXTENSION_PASSWORD` |
| 域 / Realm | `demo.local`，与 `SIP_DOMAIN` 一致 |
| SIP 服务器 / 出站代理 | `sip:服务器IP:5060;transport=tcp` |
| 传输 | TCP；分机侧也可用 UDP |
| 音频编解码 | PCMU / PCMA（G.711 μ-law / A-law） |
| 媒体加密 | 此演示使用普通 RTP，关闭强制 SRTP / ZRTP |

`demo.local` 是 SIP 注册域，不需要公网 DNS；通过代理地址指定实际服务器。启用“注册”，确认注册成功。若软电话把服务器和身份域合并配置，服务器可填实际 IP，FreeSWITCH 会将注册记录归入配置的 SIP 域；推荐保持上表的身份和代理分离。

在网页“通话路由”确认 FreeSWITCH 已连接，在“计划拨打”页面选择路由并点击“呼叫分机”，在软电话接听后等待 AI 接入。页面显示：分机呼叫中 → 分机振铃 → 正在连接 AI → 通话中 → 已完成。“计划拨打”页面支持挂断。

默认只配置了分机 `1001`。如需更多分机，在 `deploy/freeswitch/freeswitch.xml.template` 的 directory 中增加 user 和独立密码，重新创建 FreeSWITCH 容器，再在页面添加对应路由；页面添加路由不会自动创建 SIP 账号。

## 网络端口

| 端口 | 用途 |
| --- | --- |
| TCP/UDP 5060 | 软电话注册和 SIP 信令 |
| TCP 5080 | FreeSWITCH external profile 的本地 SIP 端口 |
| UDP 10000–10099 | 双向 RTP 音频 |
| TCP 8021 | ESL 控制接口，仅内部使用；默认 Compose 不向宿主机发布 |
| TCP 4173 | Web，默认仅本机访问 |

允许服务器向 Agora 域名的 TCP 5060 发起连接，RTP 出站目标端口由 Agora 的 SDP 协商决定；本地 UDP 10000–10099 需要可达。`transport=tcp` 只表示 SIP 信令使用 TCP，音频仍走 RTP/UDP。Linux 配置将 ESL 绑定在回环地址。

默认桥接网络为 `172.30.86.0/24`；如与现有网络冲突，同时修改 `.env` 的 `DEMO_SUBNET` 和 `ESL_ALLOWED_CIDR`。修改环境变量后用 `docker compose up -d --force-recreate`，单纯 restart 不会更新容器环境。

## 运行检查

```bash
docker compose ps
docker compose logs --tail=80 freeswitch web
# ESL、internal/external profile 和分机注册检查，不会发起呼叫。
docker compose exec web node scripts/check-freeswitch.js
```

使用 Linux 部署时，上述每条 compose 命令也要加 `-f compose.yaml -f compose.linux.yaml`。也可以查看 FreeSWITCH 注册：

```bash
docker compose exec freeswitch sh -c 'fs_cli -H 127.0.0.1 -p "$FREESWITCH_ESL_PASSWORD" -x "sofia status profile internal reg"'
```

- FreeSWITCH 未就绪：检查 ESL 密码、ACL 和容器健康状态。
- 分机未接通：检查注册状态、用户名、域和软电话网络；默认振铃超时 30 秒。
- 分机接听后失败：查看通话记录的结束原因和容器日志；Agora 等待接通超时 45 秒，需确认 SIP 入口启用、鉴权/白名单要求及 G.711 支持。
- 接通无声 / 单向声音：检查 `FREESWITCH_PUBLIC_IP`、SDP 中媒体地址、UDP 端口及 NAT。
- ESL 断线时页面显示“状态待确认”，禁止重复占用分机；重连后通过 UUID 核对。若已错过挂断事件，记录会明确标注状态同步不完整，不伪造通话时长。

## 只运行 Web / 使用已有 FreeSWITCH

```bash
export FREESWITCH_HOST=127.0.0.1
export FREESWITCH_ESL_PORT=8021
export FREESWITCH_ESL_PASSWORD=your-esl-password
export SIP_DOMAIN=demo.local
npm start
```

`npm start` 不自动读取 `.env`，环境变量需要由终端或进程管理器注入。已有 FreeSWITCH 需要启用 `mod_event_socket`，配置 `user/1001@demo.local` 的 directory dial-string，并有名为 `external` 的 Sofia profile。没有 FreeSWITCH 连接时可以浏览业务数据，但不会模拟呼叫成功。

## Agora 结果回传

客户上下文通过上述 `X-Customer-Str` 发送给 Agora，通话结果通过 Webhook 回传到本应用。使用 `X-Switch-Id` 的原始值匹配通话。

保留以下**应用自定义的标准化接口**。它不是对 Agora 原生 Webhook 格式的声明；应由适配层根据 Agora 的实际事件格式及通话 ID 映射调用：

```text
POST /api/webhooks/agora/calls
Authorization: Bearer <AGORA_WEBHOOK_TOKEN>
Content-Type: application/json
```

```json
{
  "taskId": "Ab12Cd34Ef56Gh78",
  "recordingUrl": "https://example.com/recording.wav",
  "transcript": [
    { "speaker": "AI", "text": "您好，这里是还款提醒服务。" },
    { "speaker": "客户", "text": "我明天先还一部分。" }
  ],
  "summary": "客户承诺部分还款，需要复催。",
  "promiseAmount": 1000,
  "promiseDate": "2026-10-16",
  "needRecall": true
}
```

`taskId` 使用该次通话实际发出的 16 位 ID，大小写敏感；兼容顶层 `task_id`、`switch_id`、`X-Switch-Id` 字段。旧接口仍支持 `callId` 或 `switchUuid`（FreeSWITCH 分机通道 UUID）。同时提供多个标识时必须指向同一通话，否则返回 409；未知 ID 返回 404，缺失或无效标识返回 400。未知 task ID 不会回退到其他通话的 callId。重复回传更新已有记录，不创建重复通话、不覆盖质检标签；通话开始/结束及计时始终由 FreeSWITCH 事件控制。Agora 原始回调的嵌套结构、认证方式及结果字段，需拿到真实样例后配置适配；当前接口按上述标准化格式接收。此版本不提供本地录音文件服务。

## 测试

```bash
npm test
# 可选：需要 Docker，本地模拟双端，自动创建并清理隔离容器/网络
node scripts/verify-sip-headers.js --docker
```

使用 Node 内置测试工具，无需安装 npm 依赖。覆盖 ESL 分帧/认证/断线、SIP 地址校验、接听后桥接的命令构造、早期媒体、未接通、Agora 失败、HTTP 与 ESL 集成、重复占用、Webhook 幂等更新和断线恢复，以及 UTF-8 Base64、task ID 匹配/冲突、长度边界与超限不拨号。自动测试使用本地测试端，不向 Agora 发起呼叫。

验证范围：已启动真实 FreeSWITCH 容器，并用本地 SIP 测试端验证 Digest 注册、183 早期媒体不提前触发第二路呼叫、分机 200 接听后通过 TCP 呼叫第二路并产生桥接事件，以及未注册分机失败路径。Web 容器构建、健康检查、实际 ESL 连接和页面渲染函数均已检查。尚未用真实软电话与 Agora 完成公网双向语音验收。业务数据仍用单进程 JSON 文件存储，适合演示，请勿并行运行多个 Web 实例写同一份数据。
