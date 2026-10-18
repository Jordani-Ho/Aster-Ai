# V2-03 抽象器（独立核心，待 V2-01 接线）

照片只进入一次视觉请求，返回严格特征后立即释放；输出为 {kind:'tongue', features, svg, shichen, jieqi, city}。时辰、节气和城市由调用者提供，不发给视觉模型。当前不导入 store、消息收发或旧照片处理函数，签字路径无改动。

- 调用 abstractTongue 前把字节的所有权交给 TransientPhoto；调用方必须清空 file input、释放 File/Blob/预览引用，不能保留副本。finally 会清零传入的 Uint8Array、置 photo.bytes=null、清空消息中的 data URL，成功/失败/超时/不支持看图全部相同处理。当前没有全局图片缓存。
- 只接受 PNG/JPEG/WebP，头部及 10 MiB 上限是输入格式检查，不能代替模型实际解码；失败请重拍。
- 领域取值、调色板和位置在 domain/tcm/tongue-features.json；校验和固定路径 SVG 在 domain/tcm/tongue.ts。未知用 unknown/null，未见标记用 []；模型自由文本、额外字段、SVG、照片回显一律拒绝。固定几何示意不构成诊断，置信度也不是临床可信度。
- 默认调用本人已经配置的模型，不替换模型名，不借家里账户降级，不把图片送到网关代理。CORS/网络错误请重拍或更换可直连的视觉接口。HTTP 400/415/422 给“请换用支持看图的模型”，包括参数不兼容的情况；这不是能力检测结论。
- JavaScript 字符串不可变，无法强制擦除已经形成的 base64/JSON 和浏览器网络栈的内部副本。这里只能清除应用可控引用和原字节，不声称完成浏览器堆取证级擦除，服务商的数据保留政策也不由本应用控制。

测试使用 固定 SVG 栅格化的合成舌形 PNG、模拟视觉响应和真实 LocalStore/fake-indexeddb：成功输出才可落地/入队，不含图片；失败和超时清空；SVG 确定且不接受外部内容。尚未替换 MirrorPage/问诊的第一版照片入口；全应用“原图不落地”的验收必须等 V2-01 合并后在同一 PR rebase 完成。面部标记可选项未实现。
