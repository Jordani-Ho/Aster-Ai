# 知衡内测部署（家里电脑 / WSL2 + Cloudflare 临时隧道）

> 第二版。发起人自用：一条命令把中继、模型网关、手机网页和临时网址都起起来。
> 固定域名、服务器迁移留到下一步；这里不配置域名，也不需要路由器开端口。

## 一、需要什么

- 一台常开的家里电脑（Windows），已装 **WSL2 + Ubuntu**。
- WSL 里装好 **Docker**（含 `docker compose`）、**Node 22**、`curl`、`git`。
  安装命令（在 Ubuntu 终端里，一次就够；需要 sudo 密码）：
  ```bash
  sudo apt-get update
  sudo apt-get install -y curl git
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"   # 之后退出 WSL 重开，docker 才不用 sudo
  ```
- 不需要域名、不需要公网 IP、不需要路由器端口映射。

## 二、第一次启动（一条命令）

在 WSL 里进入仓库的 `deploy/home/`，然后：

```bash
cp .env.example .env    # 第一次才需要；VAPID 密钥后面会自动生成
./quick-start.sh
```

第一次会构建镜像（中继要在容器里编译 Rust，约 10–30 分钟；以后有缓存会快很多）。
脚本最后一行会打印**手机可以直接打开的网址**，例如：

```text
手机直接打开这个网址：
https://example-words-here.trycloudflare.com
```

Cloudflare 临时隧道**每次重启都会换网址**；换网址后重新跑 `./quick-start.sh` 即可。

## 三、第一次使用：先登记老师

1. 手机打开上面打印的网址。
2. 选「我是老师」，按提示接入自己的模型（Kimi 等，见 `docs/内测怎么开始.md`）。
3. 进入「管理」→「我是这个社区的老师」→ 输入**一次性部署口令**。
   口令在这台电脑上：

   ```bash
   cat deploy/home/data/teacher-setup-code.txt
   ```

   登记成功后就可以「邀请学生」；把邀请链接发给另一台设备（学生）打开。
4. 学生打开邀请链接 → 点「开始使用」→ 接入自己的模型 → 进入镜子页。

## 四、日常启动与停止

- 启动（不重新构建）：`cd deploy/home && docker compose --profile quick up -d`
  但临时隧道地址可能变了；**日常请直接重跑 `./quick-start.sh`**，它会等到网页可用并把新网址打印在最后一行。
- 停止（数据保留）：`docker compose --profile quick down`
- 看状态：`docker compose --profile quick ps`

## 五、验收

```bash
cd deploy/home
./verify.sh
```

六项检查：应用页面 200、网关无凭据 401、网关非成员 403、网关成员 202、中继成员 AUTH 通过、中继开放模式接受任意已认证身份；
另外检查数据目录/配置文件在位，并扫描 relay/gateway/web 日志里没有请求正文、完整公钥或 IP。
最后一行会再打印一次手机可直接打开的网址。

## 六、数据与隐私

- 所有数据在这台电脑的 `deploy/home/data/`：中继数据库、网关成员与推送订阅、一次性登记口令、验收日志。**不要提交这个目录。**
- `.env` 里有 VAPID 密钥等，也**不要提交**；`data/teacher-setup-code.txt` 不要发给别人。
- 想彻底重来：`docker compose --profile quick down`，再删除 `data/`（不可恢复；先确认不再需要这些本机资料）。
- 中继只存端到端加密后的信件；relay/gateway/web 的容器访问日志全部关闭。

## 七、社区仪表盘（可选）

- 想收各馆的运行统计：在 `.env` 填 `DASHBOARD_PUBKEY`（运营方生成的 64 位十六进制公钥）和 `DASHBOARD_URL`（例如 `https://应用域名/#dashboard`）。
- 两项任意一项留空：各馆完全不发统计，老师管理页也会写明“未配置”。
- 仪表盘只读，只显示各馆每天交的计数/时长；不含病历、舌象、钱账、名字、城市、IP。
- **仪表盘私钥不进 `.env`、不进仓库**。运营方在自己的浏览器打开 `DASHBOARD_URL` 时带上 `#dashboard=<私钥>` 一次；页面读完会把钥匙收进本浏览器 sessionStorage（关掉浏览器即失效），地址栏不再保留。没有钥匙时页面不显示任何数据。
- 改完 `.env` 后重跑 `./quick-start.sh`（或 `docker compose --profile quick up -d --force-recreate web`）让页面按新变量重建。

## 八、常见问题

- **最后一行不是网址 / 报错“没读到应用隧道地址”**：Cloudflare 临时隧道会被限流（429）。等 1 分钟再跑 `./quick-start.sh`；脚本遇到 429 会自动退避重试。
- **手机打不开网址**：电脑要保持开机、WSL 不要关；先在本机运行 `./verify.sh` 看第一项是否 PASS。
- **Docker 没运行**：`sudo systemctl start docker`，或退出 WSL 重开后再试。
- **想强制重建镜像**（改了代码以后）：`docker compose --profile quick build --no-cache relay gateway web`，再跑 `./quick-start.sh`。
- **登记口令在哪**：`deploy/home/data/teacher-setup-code.txt`；只在本机，注册一次后仍然保留，别外传。

## 九、下一步（现在不用做）

固定域名（Cloudflare Zero Trust 命名隧道）与香港/东京服务器是内测稳定后的第二步，届时另开部署卡；本文与脚本只覆盖临时隧道自测。
