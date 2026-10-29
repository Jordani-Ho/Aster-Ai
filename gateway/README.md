# gateway · 模型网关

无状态模型代理与内测失败后备。M1-21 发起人新决定：每个人先接通自己的模型，家里网关不再作为首选模型。

- 模型转发只接受 `POST /v1/chat/completions`（另有明确列出的邀请和推送入口），其他路径一律 404；上游账户的微调、文件等接口不对成员开放。
- 转发 OpenAI 兼容请求，流式返回原样透传；上游模型由配置统一决定，客户端不能自选。
- 只接受社区成员签名的请求（Nostr NIP-98），公钥在成员名单里才放行；同一事件 60 秒内不可重放。
- 按公钥限流，且**按路由分组**：进馆/登记（`/invite/*`）、推送（`/push/*`）、模型转发各自一个额度，互不挤占；数值在配置文件里。
- 请求体默认上限 1 MB，超限在读取过程中立即返回 413。
- 上游请求默认 120 秒超时；客户端断开连接时同时中止上游请求，避免空耗额度。
- **日志只记录时间、公钥的前 8 位、耗时、状态码**，不记录请求或回复的内容；默认输出到标准输出。
- M1采用单实例：成员名单和推送订阅由本机文件保存。

## 运行

```sh
npm ci
UPSTREAM_API_KEY=你的上游密钥 node server.js            # 使用同目录的 config.json
UPSTREAM_API_KEY=你的上游密钥 node server.js 我的配置.json
```

## 配置（config.json）

| 字段 | 含义 |
| :-- | :-- |
| `port` | 监听端口，默认 8787 |
| `publicUrl` | 对外地址，用于校验 NIP-98 的 `u` 标签；`null` 时用请求的 Host |
| `upstreamBaseUrl` | 后备 OpenAI 兼容接口根地址（不含 /v1）；空值使用共享清单的 DeepSeek 项 |
| `upstreamModel` | 后备模型；空值使用共享清单的 DeepSeek 项，显式值可切换 |
| `upstreamApiKeyEnv` | 保存上游密钥的环境变量名（密钥不写进文件） |
| `membersFile` | 成员名单文件，JSON 数组，元素是 64 位十六进制公钥（M1-01 身份公钥） |
| `maxBodyBytes` | 请求体上限，默认 1048576（1 MB），超过返回 413 |
| `upstreamTimeoutMs` | 上游超时，默认 120000（120 秒），超时返回 504 |
| `rateLimit` | `windowMs` 时间窗；`invites.maxPerWindow`、`push.maxPerWindow`、`model.maxPerWindow` 三组独立额度（旧配置只有 `maxPerWindow` 时三组都用它） |
| `logFile` | 可选。日志文件路径；省略则输出到标准输出（推荐交给部署方收集） |

成员名单支持M1-17邀请兑换即时登记；也可由部署者维护文件，鉴权每次重读，无需重启。

## 鉴权：NIP-98

请求头 `Authorization: Nostr <base64(事件 JSON)>`。事件为 kind `27235`，带 `["u", 完整请求 URL]`、`["method", "POST"]` 和 `["payload", 请求体 SHA-256 十六进制]` 标签（带请求体的请求强制要求 payload）。网关校验签名、事件时间（前后 60 秒）、URL、方法、请求体摘要，再查成员名单：签名不通过返回 401，非成员返回 403，同一事件 id 在 60 秒内第二次出现返回 401。

## 测试

```sh
npm test
```

测试用本地 mock 上游和合成数据，覆盖任务卡 M1-07 的 6 条验收用例，以及审核补充的四项安全测试：路径白名单、请求体上限（声明长度与分块读取）、防重放、上游超时与客户端断连中止；最后逐行检查日志不含任何请求内容。

M1-08：网页提醒见 push/README.md；gateway/push 为唯一有状态组件。

## M1-17 邀请与成员热更新

`POST /invite/redeem`、`/invite/seed`、`/invite/core-seed`、`/invite/teacher`、`/invite/core-add` 都要求普通 NIP-98、请求体摘要、防重放、体积和限流。成员文件兼容旧数组；新写入时保存成员、老师和核心成员身份。旧名单不整体迁移，只依据本机 `seed.json.usedFor` 认出旧部署口令登记的老师，其余旧成员不推断角色。学生邀请只接受老师签名。

`core-seed.json` 只存核心登记口令的 SHA-256 与 `usedFor`；成功后申请身份登记为核心成员，不自动授予老师身份，并删除本机 `core-member-code.txt` 与 `core-member.html`。核心成员对 `/invite/teacher` 签发最长 7 天的一次性推荐事件；新老师扫码后，网关把该事件绑定到首次请求身份，写入推荐者、老师、时间、理由，并登记老师身份。推荐记录存在本机 `teacher-recommendations.json`，日志与响应不含理由。`/invite/core-status` 只给成员身份签名查询；核心成员可签发 `/invite/core-add` 一次性晋升邀请，目标须是已登记老师。部署口令 `/invite/seed` 保留为没有核心成员时的老师登记兜底，不授予核心身份。

成员名单由MemberStore原子写临时文件、fsync、rename；每次鉴权重读，不重启就生效。M1单进程文件存储，不支持多个网关同时写同一文件。Docker必须挂载可写目录（内测为 `/app/data/members.json`），不能绑定只读单文件。重跑部署只增补配置成员，不覆盖邀请已加入成员。

`seedTokenFile` 与 `coreSeedTokenFile` 都只存口令 SHA-256 及 `usedFor`。老师部署口令允许同一身份重试；核心登记在名单写入中断时只允许原身份重试，成功后失效。口令不进日志或响应；页面选择角色本身不构成服务器授权。

邀请不保存学生资料，没有用户业务数据库。后台日志规则保持原有四字段，不记录邀请、口令或请求内容。旧聊天/推送测试及新增邀请/原子失败测试由 `npm test` 执行。

## M1-21 用户模型代理与后备

POST /v1/proxy 使用与原聊天路由相同的成员 NIP-98、摘要、防重放、体积上限、限流、超时和断开中止。请求 {url,apiKey,body}，body 为原始 Chat Completions JSON 文本；只转发 Content-Type 与用户 Bearer，不覆盖模型。日志仍只有原四字段，不含 URL、凭证或内容。请求内存只活到转发结束；没有持久化或供应商账户库。

默认精确目标从 app/src/core/llm/providers.json 读取（Docker 镜像复制同一文件），额外地区/自定义服务的完整地址由可信部署者加入 proxyAllowedUrls。禁止用户任意目标、userinfo、query、fragment 与重定向；显式白名单项需部署者核实，不能配置元数据/内网目标。测试的 fetchUpstream 注入仅接本机模拟上游，生产不配置。

fallbackEnabled 默认 true（兼容既有部署），false 时原 POST /v1/chat/completions 返回 503，不调用社区账户；不关闭自带模型代理。部署在 .env 设置 MODEL_FALLBACK_ENABLED=false 后重跑既有 setup.sh 生成配置，无需新脚本。MODEL_PROXY_ALLOWED_URLS 为逗号分隔的额外完整目标。客户端不会在首次测试时调用后备。
