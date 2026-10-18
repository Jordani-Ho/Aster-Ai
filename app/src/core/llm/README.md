# 模型客户端与自带模型（M1-21）

应用所有老师起草、改稿、方案和师生镜子、学生追问共用 personal.ts。index.ts 保留协议级客户端与 SSE 解析；签字路径不引用本目录。

## 接入、保存与路由

首次选择角色后必须测试本人模型成功，再保存并进入首页；旧用户无接入记录也要完成这一步。测试用 prompts/model-connection.md 的短句，绝不借后备模型冒充接入成功。修改凭证、服务商、地址或模型后必须重测。恢复有效设置直接使用，不强制再次联网。

settings/personal-model 保存 {provider,baseUrl,model,apiKey,testedAt}，只经已有 AES-GCM LocalStore 写入，结构化中继和完整文件备份均包含。保存后触发既有备份组件检查；备份状态记录已捕获的 modelTestedAt，版本变化时即使当天已有成功备份也重做，失败仍保留本机设置并由原机制重试。不会写 localStorage、构建环境、URL 或日志。设置中已有凭证留空可保留，不回填密码输入框。家里网关仅将凭证临时放请求内存转发，不入业务存储。

优先浏览器直连。只有 fetch TypeError（浏览器不能区分 CORS、DNS、TLS 等）才尝试签名 POST /v1/proxy，直连与代理共用 10 秒超时预算。HTTP 错误、超时及不合法回复在正常业务调用时才尝试原有 /v1/chat/completions 后备（另有 10 秒预算）；后备开关关闭或也失败时交回调用方既有固定问句/节气建议/保留草稿机制。流式输出一旦已有 token，不再切换另一模型拼接。后备成功才显示“今天用的是备用模型，请检查您的模型账户”。

代理信封 {url,apiKey,body} 中 body 是完整原始 Chat Completions JSON 文本，NIP-98 对整个信封做 payload 摘要；代理不覆盖 model、不添加网关账户凭证，不记录请求/回复。网关默认从 providers.json 生成精确目标 URL 白名单，禁止重定向。额外地区/自定义服务需部署者将完整 URL 加入 proxyAllowedUrls；未加入仍可直连。此设置不能用来代理任意网页或本机模型。

服务商模型名、默认地址、接入点要求和注册页只由 providers.json 驱动，不按服务商在 TS 中分支。豆包清单保留官方默认模型名作说明，但按任务卡使用用户的 ep- 接入点 ID 填入 model。其他兼容接口无通用默认值，由用户提供。帮助步骤见 public/help/，真实账户截图待补。

## 官方核对（2026-10-17，美国当地日期）

| 服务商 | 默认接口根地址 / 模型 | 官方依据 |
| :-- | :-- | :-- |
| DeepSeek | https://api.deepseek.com / deepseek-flash | [首次调用](https://api-docs.deepseek.com/)：当前示例已不再用旧 deepseek-chat 别名 |
| 百炼 | https://dashscope.aliyuncs.com/compatible-mode/v1 / qwen-plus | [兼容接口](https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope)、[原有北京域名与 qwen-plus](https://help.aliyun.com/zh/model-studio/model-calling-in-sub-workspace)；旧域名仍可用，新业务空间域名可编辑，凭证须同地域 |
| Kimi | https://api.moonshot.cn/v1 / kimi-k3 | [中国站快速开始](https://platform.kimi.com/docs/get-api-key)（原 moonshot.cn/docs/intro 重定向）；[国际站](https://platform.kimi.ai/docs/overview) 为 api.moonshot.ai/v1，需要相应账户，不能混用 |
| 豆包 | https://ark.cn-beijing.volces.com/api/v3 / 默认 doubao-seed-2-1-pro-260915，实际填用户接入点 ID | [Base URL 与鉴权](https://docs.volcengine.com/docs/ark/base-url-and-authentication?lang=en)、[OpenAI SDK 兼容](https://www.volcengine.com/docs/82379/1330626)；官方 Bearer API Key 支持 Model ID，卡片要求的 Endpoint ID 仍由用户填写 |
| 其他兼容接口 | 用户填写 / 用户填写 | 无单一服务商或可核实的通用默认值；以该服务商官方 Chat Completions 文档为准（协议示例可参考上述 DeepSeek 官方文档） |

## 浏览器直连实测

探测日期 2026-10-17；真实 Chromium、http://localhost 源，Cloudflare trace 仅核验出口国家为 US，不记录 IP。各 POST 均携带合成无效 Bearer 和合成短句，不读取或使用真实账户。读到 401 表示这次跨域错误响应可读，**不证明有效账户推理成功、任意部署源或手机均可用**。浏览器 TypeError 无法确定是 CORS、网络还是 TLS；不凭服务器 curl 成功代替浏览器证据。国内网络尚未测试，按发起人要求留空。

| 服务商 | 美国网络 | 国内网络 |
| :-- | :-- | :-- |
| DeepSeek | 可读 HTTP 401（3456ms）；真实账户成功未验 | |
| 百炼（默认北京原有域名） | 可读 HTTP 401（3498ms）；真实账户成功未验 | |
| Kimi（中国站） | 可读 HTTP 401（4012ms）；真实账户成功未验 | |
| 豆包（北京） | fetch TypeError（3481ms），本次不能直读；有效账户未验，应用自动尝试代理 | |
| 其他兼容接口 | 取决于用户填的服务商，未验 | |

每次 NIP-98 请求仍用 crypto.getRandomValues 生成 128 位随机 nonce，合法重试不复用旧事件，网关继续拒绝原事件重放。

V2-03 的独立视觉路径见 [vision.md](vision.md)。它只调用本人所选视觉模型，不复用家里后备或图片代理；存储与 UI 接线待 V2-01。
