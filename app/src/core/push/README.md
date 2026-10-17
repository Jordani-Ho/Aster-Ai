# 网页推送客户端

`createPushClient(config)`提供 subscribe、unsubscribe、notifyRecipient(pubkey)。订阅必须由用户点击触发；使用标准 SW、PushManager 和 VAPID 公钥。
App 的提醒设置提供开启/关闭按钮和 iOS未安装/不支持环境的主屏幕提示。配置地址和公钥只保留在当前界面内存；私钥从本地已解锁身份传入，不上传。
每次请求含随机requestId，使当前main尚未含nonce的NIP-98 helper生成不同事件；网关忽略该字段，不当作消息内容。

`syncWhenOpen(sync)`供中继模块传入同步函数：打开、恢复前台及恢复网络时触发，避免并发同步，卸载移除监听。此分支起点的M1-05尚未合并，因此没有伪造消息收发；真实发送后通知和打开自动中继同步均待该模块接入。其接口可单独测试。
SW的推送事件完全忽略载荷，只显示“知衡：有新消息”，点击聚焦同源页面并发 aster:sync-requested 消息，或打开首页。

不支持推送时仍可打开网页；iOS必须添加到主屏幕，通知权限由用户授予。提供manifest便于安装。应用与gateway需同源HTTPS反向代理；VAPID公钥由部署方提供。
没有缓存离线页面、没有原生推送、没有后台定时作业。真实手机推送和真实中继同步未验收，见任务卡完成记录。
