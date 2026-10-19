# 身份（V2）

V2 起身份在本机自动生成并直接存放：`createIdentity()` 用 `nostr-tools` 随机生成 32 字节私钥，`Identity` 只有 `{ privateKey, publicKey, npub }`；没有助记词、恢复、账户派生或抄写核对。持久化由 `core/store` 明文保存身份记录（V2 不再包裹）。

- `createIdentity()`：新身份；`identityFromPrivateKey(bytes)`：由私钥还原（家人/测试用）。
- `links.ts`（V2-07）：换手机时本机记“旧公钥 → 新公钥”的对应关系，供名单替换与旧签名病历的收件/验签；只存公钥，不存身份资料或记录内容。
- 本模块不连接中继、不处理持久化、不采集任何用户资料；测试数据全部为合成身份。
