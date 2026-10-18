# V2-03 视觉请求

vision.ts 使用现有 PersonalModel 的地址、凭证和模型名，直接 POST /chat/completions，Bearer 认证、非流式、image_url data URI，30 秒超时，cache:no-store、credentials:omit、redirect:error。不新增 SDK 或依赖。请求仅带外观提取提示词和图片，不带姓名、地理、时辰或诊断。

本卡明确指定千问、Kimi、豆包等现有用户账户；未接入 OpenAI 服务、未查找或使用开发机真实密钥，所有测试替身凭证均为合成值。通用协议名中的 OpenAI 兼容不表示更换服务商。

## 官方核对（2026-10-18）

| 服务商 | 官方出处 | 核实内容 |
| :-- | :-- | :-- |
| 千问 | https://help.aliyun.com/zh/model-studio/vision | Chat Completions 的 image_url 支持 Base64 data URI，需选择支持视觉的型号和账户对应地域地址；不把现有 qwen-plus 强行改成其他型号 |
| Kimi | https://github.com/MoonshotAI/Kimi-K2.5 | 官方 K2.5 仓库给出视觉输入 image_url/data:image/png;base64 示例及 api.moonshot.cn/v1 接入；不由现有 kimi-k3 名字推断能力 |
| 豆包 | https://docs.volcengine.com/docs/ark/image-understanding?lang=zh 及 https://docs.volcengine.com/docs/ark/chat-api?lang=zh&redirect=1 | 图片 URL 或 Base64，image_url 内容类型，使用用户实际视觉接入点 |

已知纯文本旧型号提前提示；未知、定制接入点须实际请求，不因名称猜测支持。图像输入遭 HTTP 400/415/422 拒绝时提示换用支持看图的模型，其余失败提示重拍。没有自动能力探测或图片重复尝试。

美国/国内的有效账户视觉调用、各手机、部署源 CORS 尚未实测。旧 M1-21 无效凭证的跨域结果不能充当视觉调用成功证据。真实模型质量也未验，不承诺医疗准确性。
