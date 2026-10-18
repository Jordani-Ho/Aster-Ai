# M1-16 内测部署：把知衡放在发起人家里的一台电脑上

这台电脑跑四个容器：**中继（relay）**、**模型网关（gateway，含推送）**、**手机网页应用（web）**、**Cloudflare Tunnel（cloudflared）**。
家里路由器**不开任何端口**，也不用公网 IP：cloudflared 从家里主动连到 Cloudflare，外面的人用 HTTPS 访问。

```
手机 / 老师的电脑
   │ https://app.<域名>    → Cloudflare → cloudflared（家里）→ web 容器（静态页面 + /push /v1 反代）
   │ wss://relay.<域名>    → Cloudflare → cloudflared（家里）→ relay 容器（Nostr 中继）
   └ https://gw.<域名>     → Cloudflare → cloudflared（家里）→ gateway 容器（直连排障用）
```

- 中继/网关/网页的**访问日志全部关闭**；数据只在这台电脑的 `deploy/home/data/`（不进仓库）。
- 页面里的中继与网关地址是**构建时**常量，所以 `web` 容器每次启动时会用当前 `.env` 里的域名重新构建一次 app。
- 这份手册面向发起人本人，每条命令都写了预期看到什么。

---

## M1-17：手机开通老师与邀请学生（当前入口）

这一节替代下文旧版的手工复制成员步骤。`.env` 的 `MEMBER_PUBKEYS` 可留空，`SELF_TEST_MEMBER` 默认0；保持模型和域名等部署变量。运行现有 `./setup.sh` 后，再按原步骤启动；脚本只生成本机一次性部署口令，不把口令打印到日志。

> 从早期部署（M1-16 或更早）升级上来的，先按 [6.8 代码升级后重建镜像](#68-代码升级后重建镜像开放模式与种子成员) 重建 `relay/gateway/web` 镜像；旧镜像不认识 `community_open`，也没有 `/invite/seed`，直接重跑配置不会生效。

1. 在部署电脑本机查看 `deploy/home/data/teacher-setup-code.txt`，只交给发起人指定的第一位老师。
2. 老师在手机打开应用，只点“我是老师”即到首页。展开“我是这个社区的老师”，输入部署口令，点“登记为社区老师”。看到“社区已建立，可以邀请学生”。口令只能认领到一个后台身份，重跑setup不重置；同一人失败重试可继续。
3. 老师点“邀请学生”，把链接或二维码发给学生。7天内可重复使用；学生点开就到问诊首页，不输入后台编号。过期请老师重新生成。
4. 学生登记写入 `data/gateway/members.json`，网关即时生效，无需重启。原 `data/gateway-members.json` 仅迁移旧名单时读取；重复setup不会丢失新成员。gateway挂载整个可写data/gateway目录，支持原子替换。
5. 独立中继默认仍关闭开放模式；此内测部署通过 `RELAY_COMMUNITY_OPEN=true` 放行任意已认证连接，模型/推送网关仍只接受邀请成员。改成false退回原白名单模式，需把成员明确写入配置；未认证连接仍不能读取消息。

---

## 0. 这台电脑的现状（2026-10-17 核对）

| 项目 | 现状 |
| :-- | :-- |
| 系统 | WSL2 · Ubuntu 24.04（systemd 已启用） |
| WSL 用户 | `dell@Jordamo`（下面命令都以这个普通用户运行，**不要用 root**） |
| 内存 / 磁盘 | 3.7 GiB / 940 GB 可用（已有 1 GiB swap，构建时实测未用满、未 OOM） |
| Node.js | 已装 v22.22.2（本仓库开发也需要） |
| Docker | 已装：Docker 29.1.3 / Docker Compose v2.40.3（2026-10-17） |
| 到 trycloudflare.com 的网络 | 通（已用临时隧道实测） |

> 第一次安装 Docker 的第 1 步需要 sudo 密码；后续启动/重启都不需要 sudo。

---

## 1. 第 1 步：在 WSL 里安装 Docker（需要 sudo 密码）

打开 Windows 终端，进入 WSL：

```bash
wsl -d Ubuntu
```

确认是普通用户（预期输出 `jordamodell` 或你自己的用户名，不是 `root`）：

```bash
whoami
```

然后逐段执行（每段都会要一次密码）：

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

把当前用户加入 docker 组，并让 systemd 开机启动 Docker：

```bash
sudo usermod -aG docker "$USER"
sudo systemctl enable --now docker
newgrp docker
```

验证（预期：`Docker version 28.x` 与 `Docker Compose version v2.x`）：

```bash
docker --version
docker compose version
docker run --rm hello-world
```

`hello-world` 的预期输出里会有一句 `Hello from Docker!`。
如果提示 `permission denied while trying to connect to the Docker daemon`，退出 WSL（`exit`）后重新 `wsl -d Ubuntu` 再试。

> 3.7 GiB 内存编译中继可能吃紧。若第 3 步 `docker compose build relay` 被系统杀掉（OOM），先加 4 GB 交换文件（需要 sudo，执行一次即可）：
> ```bash
> sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
> echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
> ```

---

## 2. 第 2 步：准备仓库和 .env

仓库在 `D:\projects\aster-ai-codex`，WSL 里的路径是 `/mnt/d/projects/aster-ai-codex`：

```bash
cd /mnt/d/projects/aster-ai-codex/deploy/home
cp .env.example .env
chmod 600 .env
```

用文本编辑器打开 `.env`，按M1-17入口填写模型与域名；成员一项可留空。其他配置：

| 变量 | 填什么 |
| :-- | :-- |
| `MEMBER_PUBKEYS` | 老师和学生的 64 位十六进制公钥，逗号分隔（就是 App 里显示的那串「公钥十六进制」） |
| `UPSTREAM_API_KEY` | 模型服务商的 API Key（部署时不要在聊天里贴出来） |
| `VAPID_SUBJECT` | 你的联系邮箱，`mailto:you@example.com` |
| `APP_DOMAIN` / `RELAY_DOMAIN` / `GATEWAY_DOMAIN` | 域名模式填，例如 `app.example.com`；无域名自测留空，交给 `quick-start.sh` |
| `CF_TUNNEL_TOKEN` | 域名模式下 Cloudflare 隧道的 token；无域名留空 |

`.env` 不要提交、不要发给别人。`SELF_TEST_MEMBER=1` 会额外生成一对只用于验收的自测密钥（公钥自动加进成员名单），正式对外前改成 `0` 并重跑 `./setup.sh`。

---

## 3. 第 3 步：域名模式（推荐，真实内测用）

### 3.1 Cloudflare 准备（在浏览器里做，不在这台电脑上）

1. 把一个域名托管到 Cloudflare（修改域名的 NS 记录，等生效）。
2. 进入 **Zero Trust → Networks → Tunnels → Create a tunnel**，类型选 **Cloudflared**，名字填 `aster-home`。
3. 创建后会显示安装命令，其中 `--token` 后面那一长串就是 `CF_TUNNEL_TOKEN`，复制到 `.env`。
   **不要**在这台电脑上执行它给的 `cloudflared service install`；容器会替我们运行。
4. 在隧道的 **Public Hostname** 里加三条：

   | 子域名 | 服务（Service） |
   | :-- | :-- |
   | `app.<你的域名>` | `http://web:8080` |
   | `relay.<你的域名>` | `http://relay:8080` |
   | `gw.<你的域名>` | `http://gateway:8787` |

   `http://web:8080` 这种写法是容器内部服务名，Cloudflare 面板里原样填即可。
   页面里的推送与模型请求都走 `app.<域名>/push` 与 `app.<域名>/v1`（web 容器里同源反代到网关），所以 **gw 子域名只用于直连排障**，浏览器不需要它。
5. Cloudflare 不需要任何端口转发；路由器也不要动。

### 3.2 第一次生成配置并构建（在 WSL 里）

```bash
cd /mnt/d/projects/aster-ai-codex/deploy/home
./setup.sh
```

预期看到类似：

```
成员：2 个
应用域名：app.example.com
中继域名：relay.example.com
构建镜像（relay 首次要在容器里编译 Rust，约 10–30 分钟；之后有缓存会快很多）…
...
生成 VAPID 推送密钥…
VAPID 已生成并写入 .env（不要提交 .env）
生成验收用自测成员密钥…
自测成员公钥：xxxx…
生成中继配置 data/relay-config.toml（relay_url=wss://relay.example.com/）…
生成网关配置 data/gateway-config.json 与成员名单 data/gateway-members.json…
gateway config: publicUrl=https://app.example.com members=3
完成：
  - 数据目录：/mnt/d/projects/aster-ai-codex/deploy/home/data（已加入 .gitignore）
  - 域名模式启动：./start.sh
  - 无域名自测：./quick-start.sh（会生成 trycloudflare 临时地址并写回 .env）
  - 验收探测：./verify.sh
```

首次中继构建很久是正常的（Rust 编译），**不要中途 Ctrl-C**。

### 3.3 启动

```bash
./start.sh
```

预期最后打印容器状态，四个服务都是 `running`：`relay`、`gateway`、`web`、`cloudflared`。
用手机浏览器打开 `https://app.<你的域名>`，应该看到「知衡 · 身份」页面；生成身份后可以开始采集。

### 3.4 验收

```bash
./verify.sh
```

预期输出摘要（全部 `PASS`、`RESULT PASS`）：

```
== 1/5 网络探测（应用 / 中继 / 网关） ==
PASS 应用页面可打开（200）
PASS 网关无凭据返回 401
PASS 网关拒绝非成员（403）
PASS 网关接受成员请求并经隧道返回 202（推送路由，无订阅也 202）
PASS 中继拒绝非成员 AUTH（rejected）
PASS 中继接受成员 AUTH
RESULT PASS
== 2/5 数据目录 ==
...
== 3/5 docker compose logs 隐私扫描（relay / gateway / web） ==
PASS 日志里没有请求正文标记
PASS 日志里没有完整公钥
PASS 日志里没有 IP 地址
== 5/5 结论 ==
全部通过。
```

---

## 4. 第 4 步：没有域名时的自测模式（trycloudflare）

Cloudflare 临时隧道不需要域名和账号，但**地址每次重启都会变**，只适合自测，不能当作内测入口。

```bash
cd /mnt/d/projects/aster-ai-codex/deploy/home
./quick-start.sh
```

它会：准备镜像与占位配置 → 起两条临时隧道 → 读出两个 `https://xxx.trycloudflare.com` 地址 → 写回 `.env` 的 `APP_DOMAIN` / `RELAY_DOMAIN` → 重新生成中继/网关配置 → 重建 `relay/gateway/web`。

预期最后看到：

```
已就绪（临时地址，重启后会变；只适合自测）：
  应用：https://xxxx.trycloudflare.com
  中继：wss://yyyy.trycloudflare.com
  网关：https://xxxx.trycloudflare.com（页面同源访问 /v1 与 /push）
验收：./verify.sh
```

把「应用」地址发到手机上打开即可。注意：

- 每次 `wsl --shutdown`/重启后，**临时地址会变**，必须重跑 `./quick-start.sh`；这时旧链接失效，需要重新发链接。
- 这种模式只暴露「应用」和「中继」两个临时地址；网关不单独暴露，页面通过 `app/push`、`app/v1` 同源访问（M1-08 要求应用与网关同源）。
- 自测模式下 Cloudflare 隧道容器保留少量日志（只有临时地址与连接状态），用来读取地址；拿到地址并重建容器后日志不再增长。
- **WSL 闲时会被 Windows 回收**：如果最后一个 WSL 会话退出、一段时间没人用，WSL2 会停掉，容器和临时隧道随之停止；下次启动 WSL 后临时地址会变，必须重新跑 `./quick-start.sh`。做自测时保持一个 WSL 终端开着（或 `wsl -d Ubuntu -- bash -lc "sleep 7200"` 这种保活）。**注意：WSL 被回收时所有容器都会停，域名模式也一样**——域名模式只是 hostname 固定、重连后地址不变，不等于容器常驻；长时间在线（无论哪种模式）都要按下面第 6.6 节做保活。
- **短时间反复重建可能被 Cloudflare 限流**：容器反复重启、连续多次重跑脚本时，cloudflared 日志会出现 `quick tunnel provisioning failed with status 429`（HTTP 429、`error code: 1015`），响应头 `retry-after` 给出还要等多少秒（本次实测约 35 分钟）。这时**不要再反复重启容器**（只会继续撞限流），等限流解除后重跑 `./quick-start.sh` 即可；需要稳定地址请用域名模式。

### 从自测模式切到域名模式

1. 在 `.env` 里把 `APP_DOMAIN` / `RELAY_DOMAIN` / `GATEWAY_DOMAIN` 改成你的域名，`CF_TUNNEL_TOKEN` 填 Cloudflare 隧道 token。
2. `./setup.sh`
3. `docker compose --profile quick down`（停掉临时隧道和容器）
4. `./start.sh`

反向切回自测：把域名清空后跑 `./quick-start.sh` 即可。

---

## 5. 对照任务卡的验收清单

| # | 验收项 | 怎么跑 | 预期 |
| :-- | :-- | :-- | :-- |
| 1 | 干净机器按 README 跑起来 | 本文件第 1–3 步 | 没报错，`docker compose ps` 四个容器 running |
| 2 | 手机经 Tunnel 打开应用，能连中继、调网关 | 手机打开 `https://app.<域名>`；`./verify.sh` | 页面出现；中继成员 AUTH 通过；网关成员推送 202 |
| 3 | 非成员公钥连不上中继 | `./verify.sh` 第 1 步 | `PASS 中继拒绝非成员 AUTH` |
| 4 | `docker compose logs` 无请求内容/公钥全文/IP | `./verify.sh` 第 3 步 | 三条 PASS，日志原文在 `data/verify-logs.txt` |
| 5 | 重启后数据还在 | 见下面「重启与数据持久化」 | 重启后 `./verify.sh` 仍通过，`data/` 文件数与大小不变 |

---

## 6. 日常运维

### 6.1 添加新成员（新学生/新老师）

1. 让对方在 App 里生成身份，把「公钥十六进制」发给你。
2. 在 `.env` 的 `MEMBER_PUBKEYS` 里加一个逗号和新公钥。
3. `./setup.sh`（会重建中继/网关配置）。
4. 让新配置生效：

   ```bash
   docker compose --profile domain up -d --force-recreate relay gateway
   ```

   预期：两个容器重新创建并 running；新成员可以连中继、调用网关，老成员不受影响。
   移除成员反向操作即可；历史事件不会因此删除。

### 6.2 重启

- 只重启容器：`docker compose --profile domain down && ./start.sh`
- 重启 WSL：在 Windows 终端执行 `wsl --shutdown`，再 `wsl -d Ubuntu`，然后
  ```bash
  cd /mnt/d/projects/aster-ai-codex/deploy/home && ./start.sh
  ```
- 整机重启：开机后确认 Docker 服务已启动（`sudo systemctl status docker`），再执行上面的 `./start.sh`。
  （本卡用 `wsl --shutdown` 模拟整机重启，见 PR 说明。）

### 6.3 备份中继数据

```bash
cd /mnt/d/projects/aster-ai-codex/deploy/home
docker compose --profile domain stop relay gateway
tar czf ~/aster-home-backup-$(date +%F-%H%M).tar.gz data/
docker compose --profile domain start relay gateway
```

预期：`data/` 里主要是中继 SQLite、网关推送订阅文件、生成的配置与成员名单。备份文件里的 `data/verify-logs.txt` 是验收日志，可删。
恢复：停容器 → 解压覆盖 `data/` → `./start.sh`。**恢复后建议重跑 `./setup.sh`**，确认配置与 `.env` 一致。

### 6.4 停用

```bash
docker compose --profile domain down
```

数据仍在 `deploy/home/data/`。要彻底清空：`docker compose down` 后再删除 `data/`（不可恢复，先备份）。

### 6.5 看状态 / 排障

```bash
docker compose --profile domain ps          # 容器状态
docker compose logs cloudflared             # 域名模式：cloudflared 日志驱动是 none，一般没输出
docker compose exec web wget -qO- http://localhost:8080/ | head   # 页面在容器内是否正常
docker compose exec gateway node -e "fetch('http://localhost:8787/v1/chat/completions',{method:'POST'}).then(r=>console.log(r.status))"  # 网关在容器内是否正常
```

排障需要临时打开某个服务的日志时：把 `compose.yaml` 里该服务的 `logging: driver: none` 注释掉，重建容器，**查完改回去**（日志默认必须关闭；不要把带日志的版本提交）。

### 6.6 让服务一直在线（防止 WSL 被回收）

WSL2 在最后一个会话退出约 1 分钟后会被 Windows 回收，容器和临时隧道随之停止（域名模式也一样，只是地址不变，见第 4 步的注意）。家用内测要长期在线，做两件事：

1. 登录时自动保活：用 Windows 任务计划程序，在用户登录时以隐藏窗口跑一个常驻 WSL 会话。下面命令**直接粘贴到 PowerShell 执行一次**即可（改系统配置属于用户自己的操作，脚本不会替你注册）：

   ```powershell
   $action = New-ScheduledTaskAction -Execute "wsl.exe" -Argument "-d Ubuntu --exec sleep infinity"
   $trigger = New-ScheduledTaskTrigger -AtLogOn
   $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
   $settings = New-ScheduledTaskSettingsSet -Hidden -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
   Register-ScheduledTask -TaskName "Aster-WSL-Keepalive" -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Aster 内测：登录时保持 WSL 常驻，防容器被回收" -Force
   ```

   含义：`-Hidden` 隐藏窗口；`-ExecutionTimeLimit 0` 不设执行时限；`-RestartCount` / `-RestartInterval` 失败后自动重试；`-Force` 重复执行时覆盖同名任务。想取消就 `Unregister-ScheduledTask -TaskName "Aster-WSL-Keepalive" -Confirm:$false`。

2. 接通电源时不睡眠（避免电脑入睡后容器停机）：

   ```powershell
   powercfg /change standby-timeout-ac 0
   powercfg /change hibernate-timeout-ac 0
   ```

   两个 `0` 都表示“从不”。想还原把 `0` 换成分钟数即可。

3. 整机重启后怎么验证：

   ```powershell
   Get-ScheduledTask -TaskName "Aster-WSL-Keepalive"   # 状态应是 Ready / Running
   wsl -l -v                                            # Ubuntu 的 STATE = Running
   ```

   ```bash
   wsl -d Ubuntu -- bash -lc "cd /mnt/d/projects/aster-ai-codex/deploy/home && docker compose ps"
   ```

   容器起来后：无域名模式重跑 `./quick-start.sh`（临时地址会变），域名模式跑 `./start.sh`，最后 `./verify.sh` 六项全 PASS 即重新在线。

### 6.7 升级 cloudflared

`compose.yaml` 里三处 cloudflared 用的是固定版本加摘要 `cloudflare/cloudflared:2026.9.3@sha256:072c067d25ccbe61d46e18f0d0723255f2bb5304f7317caa95b27031520ff92c`（发布于 2026-09-24，Apache-2.0）。升级时：

1. 到 Docker Hub 的 `cloudflare/cloudflared` 页挑一个发布满 14 天的新 tag，记下 `tag` 和 digest：`docker pull cloudflare/cloudflared:<tag>` 后用 `docker image inspect --format '{{.RepoDigests}}' cloudflare/cloudflared:<tag>` 看 `@sha256:…`。
2. 把 `compose.yaml` 三处 `image:` 换成 `cloudflare/cloudflared:<tag>@sha256:<digest>`（三处保持一致）。
3. 重建并验证：无域名自测跑 `./quick-start.sh`，域名模式跑 `./start.sh`，最后 `./verify.sh` 六项全 PASS。

### 6.8 代码升级后重建镜像（开放模式与种子成员）

`relay/gateway/web` 三个镜像是把仓库源码打进镜像的（`relay` 还要在容器里编译 Rust），不是挂载源码运行。所以**代码升级后只重跑配置不够，必须重建这三个镜像**。用早期镜像时会出现这些症状：

- `./verify.sh` 的中继探测 FAIL：`中继非成员 AUTH 期望被拒，实际 rejected`（旧 `relay` 不认识 `data/relay-config.toml` 里的 `community_open`，仍按白名单只放行成员，开放模式不生效）。
- 老师手机“我是这个社区的老师”登记失败：旧 `gateway` 没有 `/invite/seed` 路由，旧 `web` 也不反代 `/invite/*`（探测 `POST /invite/seed` 会得到 405，而不是网关的 403）。
- 页面仍是旧版应用：`web` 镜像里的前端在旧代码上构建。

升级步骤（在 `deploy/home` 里执行，可直接复制）：

```bash
cd deploy/home
git -C ../.. pull --ff-only                  # 或按第 2 步更新仓库到最新 main
docker compose build relay gateway web       # relay 首次 10–30 分钟；3.7 GiB 内存可能吃紧，OOM 时按第 2 步先加 swap
SKIP_BUILD=1 ./setup.sh
SKIP_BUILD=1 ./quick-start.sh                # 无域名自测；域名模式改用 ./start.sh
./verify.sh                                  # 预期六项全 PASS，含“中继开放模式接受已认证连接”
```

升级后核对：

1. `data/relay-config.toml` 里有 `community_open = true`（内测部署默认开放；关闭方法见下）。
2. `data/gateway/seed.json`（只有 `tokenHash`）和 `data/teacher-setup-code.txt`（一次性口令）在位；旧目录里的 `data/gateway-members.json` 会在 `./setup.sh` 时自动迁移到 `data/gateway/members.json`，不丢成员。
3. `/invite/seed` 不再是 405：用假口令探测应得到网关的 403（**不要用真实口令探测，也不要打印口令**）。

种子成员（老师首次登记）流程：

1. 在部署电脑本机打开 `deploy/home/data/teacher-setup-code.txt` 读取一次性口令，只交给发起人指定的第一位老师；**不外传、不打印、不贴聊天记录**。
2. 老师在手机打开应用，点“我是老师”，展开“我是这个社区的老师”，输入口令，点“登记为社区老师”；看到“社区已建立，可以邀请学生”。
3. 口令只能认领到一个后台身份；重跑 `./setup.sh` 不会重置口令，也不会覆盖已认领记录或已加入成员。登记成功后老师再点“邀请学生”发链接/二维码。

关闭开放模式 / 回滚：

- 只关开放模式、保留新代码：在 `.env` 加一行 `RELAY_COMMUNITY_OPEN=false`，重跑 `SKIP_BUILD=1 ./setup.sh`（按成员重写白名单配置），再重启中继（无域名 `docker compose --profile quick up -d --force-recreate relay`，域名模式 `./start.sh`），最后 `./verify.sh` 应显示“中继拒绝非成员 AUTH”——此时新成员要先把公钥写进 `MEMBER_PUBKEYS` 再重跑 setup。
- 回滚到旧代码：`git -C ../.. checkout <旧提交>`，再 `docker compose build relay gateway web` 并用 `./quick-start.sh` / `./start.sh` 重启；`data/` 是挂载卷，保留不动。

---

## 7. 隐私边界（内测必须有数）

- 中继只存加密事件（Nostr 端到端加密的外层包裹）。中继能看到收件公钥、AUTH 身份与连接时间，**看不到内容**；详见 `relay/README.md` 的「已裁决的隐私边界」。
- 模型网关不记录请求/回复内容；`data/gateway-config.json` 里把指标日志写到了 `/dev/null`。
- relay / gateway / web 的 Docker 日志驱动都是 `none`；`verify.sh` 会扫描这三份日志，确认没有请求正文标记、完整公钥和 IP。
- Cloudflare Tunnel 在 Cloudflare 边缘终止 TLS，因此 **Cloudflare 能看到解密后的 HTTP**（页面 HTML、请求的 URL/路径、NIP-98 里有公钥；中继/网关的业务内容本身是端到端加密的）。这是选择 Cloudflare 隧道的已知代价，内测接受；正式落地时的隧道/入口方案另行评估。
- `.env` 含 API Key、VAPID 私钥、中继成员名单，权限设为 600，不进仓库、不发给任何人。

---

## 8. 已知限制（内测版）

1. 一条命令部署只覆盖**单机、单实例**；没有监控告警、没有自动备份（按 6.3 手动备份）。
2. 无域名模式（trycloudflare）地址每次重启都会变，只适合自测；cloudflared 进程一旦重启也会换地址（`quick-start.sh` 已带重试循环）。真实内测用域名模式。
3. 应用目前能连中继、能经同源 `/push` 调用网关；模型整理/起草的客户端在 App 里还没有设置界面（M1-15a 的遗留边界），所以「调网关」验收用的是推送路由的成员鉴权请求（`/push/notify` 202），不消耗模型额度。
4. 中继首次构建要编译 Rust，3.7 GiB 内存下约 16 分钟；OOM 时按第 1 步末尾加 swap。
5. `data/relay` 目录给了 777 权限（中继容器以 uid 10001 运行）；内测机单用户可接受，正式部署再收紧。
6. 无域名模式 cloudflared 的日志（仅用于读临时地址）会记录它自己的边缘 IP 和内部容器地址，以及失败的 URL 路径；**不记录客户端 IP、请求正文或完整公钥**，且不在 `verify.sh` 的日志扫描范围内。域名模式该服务日志驱动是 `none`。

---

## 9. 本次真实验收记录（2026-10-17，WSL2 / 无域名 quick 模式）

Docker 装好后，在本机跑完了除“域名模式 + 真实模型 Key”以外的验收：

| 项目 | 结果 |
| :-- | :-- |
| 镜像构建 | relay/gateway/web 三个镜像都构建成功（relay 161 MB、gateway 348 MB、web 594 MB）；relay 首次编译 Rust 约 16 分钟，峰值内存约 1.6 GiB used / 3.1 GiB available，未 OOM，1 GiB swap 未被使用 |
| 起服务 | `./quick-start.sh` 生成两条 trycloudflare 临时地址；web 容器启动时用临时地址重新构建 app，`dist` 里能搜到 `wss://<relay 临时地址>` 与 `https://<app 临时地址>` |
| 端口 | `docker ps` 无任何宿主机端口发布；relay/gateway/web 只在 compose 内部网络 |
| `./verify.sh` | 应用 200、网关无凭据 401、非成员 403、成员推送 202、中继拒绝非成员 AUTH、中继接受成员 AUTH，全部 PASS；日志扫描（无请求正文标记/完整公钥/IP）PASS |
| 手机模拟（Playwright，390×844 移动端） | 经临时隧道打开应用、以合成成员身份连接后页面显示“中继：已连接”；页面上下文同源请求 `/v1` 401、`/push` 成员鉴权 202；手机宽度无横向溢出 |
| 日志 | relay/gateway/web 的日志驱动是 `none`，`docker compose logs` 连读取都返回“logging driver does not support reading”；cloudflared 临时隧道日志只含隧道地址、连接状态、自身边缘 IP 与失败 URL 路径 |
| WSL 重启持久化 | `wsl --shutdown` 后重新启动：`data/relay/nostr.db` 的 sha256 完全一致（118784 字节、event 表仍有数据），重新 `./quick-start.sh` + `./verify.sh` 全部 PASS（整机重启未做，用 WSL 重启代替） |

**没有覆盖的**：
- 域名模式（需要真实域名 + Cloudflare Zero Trust 隧道 token，当前 `.env` 没有）。
- 真实上游模型调用（`UPSTREAM_API_KEY` 为空；网关功能用推送路由 202 验证，不消耗额度）。
- 真实手机（用 Playwright 移动端模拟代替）。
- 施工环境里没有 sudo，按约定没有改任何系统配置；Docker 由用户自己安装。

## M1-21 自带模型

每个使用者在手机上接入自己的模型账户。家里网关只代理浏览器无法直连的请求，或在已接入用户的模型失败时提供内测后备。网关不保存用户凭证和内容，日志仍关闭。

.env 的 MODEL_FALLBACK_ENABLED 默认为 true；推广时设 false，重跑原 setup.sh 并更新 gateway 容器使配置生效。额外地区或其他服务需代理时，在 MODEL_PROXY_ALLOWED_URLS 以逗号填写核实过的完整 HTTPS /chat/completions 地址，重跑 setup.sh；不要填内网或元数据地址。此项不影响手机直连。服务商清单与日期、美国/国内探测边界见 app/src/core/llm/README.md。真实账户与手机仍需内测验收。
