# gateway · 模型网关

一个很薄的无状态转发服务：把智能体请求转给大模型，让学生不需要自己申请 API Key（技术白皮书 §3、§6.3）。

- 接收 OpenAI 兼容请求（`POST /v1/...`），转发给配置的上游，流式返回原样透传。
- 只接受社区成员签名的请求（Nostr NIP-98），公钥在成员名单里才放行。
- 按公钥限流，数值在配置文件里。
- **日志只记录时间、公钥的前 8 位、耗时、状态码**，不记录请求或回复的内容。
- 无状态，可任意部署多份；代码约 100 行。

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
| `upstreamBaseUrl` | 上游 OpenAI 兼容接口根地址 |
| `upstreamModel` | 网关统一使用的模型；**改这一行就切换上游模型** |
| `upstreamApiKeyEnv` | 保存上游密钥的环境变量名（密钥不写进文件） |
| `membersFile` | 成员名单文件，JSON 数组，元素是 64 位十六进制公钥（M1-01 身份公钥） |
| `rateLimit` | `windowMs` 时间窗与 `maxPerWindow` 上限 |
| `logFile` | 日志文件路径；省略则输出到标准输出 |

成员名单是社区数据，部署时由运营者维护（自动同步属于后续任务卡）。

## 鉴权：NIP-98

请求头 `Authorization: Nostr <base64(事件 JSON)>`。事件为 kind `27235`，带 `["u", 完整请求 URL]`、`["method", "POST"]` 和 `["payload", 请求体 SHA-256 十六进制]` 标签。网关校验签名、事件时间（前后 60 秒）、URL、方法、请求体摘要，再查成员名单：签名不通过返回 401，非成员返回 403。

## 测试

```sh
npm test
```

测试用本地 mock 上游和合成数据，覆盖任务卡 M1-07 的 6 条验收用例（含读取日志确认不含任何请求内容）。
