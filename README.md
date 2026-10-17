# Aster · 知衡治未病社区

一个去中心化、公益性的中医治未病社区：老师传承思想，学生学会照顾自己，AI 智能体只起草、不定论、不签字。

> 自己才是自己最好的医生。每个成年人都是自己身心健康的第一责任人。

## 先读这两份

| 文件 | 内容 | 读者 |
| :-- | :-- | :-- |
| [`docs/charter.md`](docs/charter.md) | 《知衡治未病社区宪章》：我们信什么、守什么 | 所有人 |
| [`docs/tech-whitepaper.md`](docs/tech-whitepaper.md) | 技术白皮书：怎么建，施工依据 | 开发者 |

## 当前状态

**M0 开仓**：已完成仓库骨架，还没有业务功能。下一步是 M1 单师闭环，任务卡见 [`docs/tasks/`](docs/tasks/)。

## 目录

```
docs/        宪章、技术白皮书、任务卡
team/        发起人决策记录、错题本
app/         手机网页应用（React + TypeScript）
domain/tcm/  中医领域内容：十问歌、八字、子午流注、急症红线、模板
prompts/     智能体提示词（纯文本，与代码分离）
relay/       Nostr 中继的部署说明
gateway/     模型网关（无状态转发，不记录内容）
```

## 本地运行

```bash
cd app
npm install
npm run dev      # 开发
npm test         # 测试
npm run build    # 构建
```

## 参与开发

施工智能体（Codex、DeepSeek 等）请先读 [`AGENTS.md`](AGENTS.md)。

M1-15b 环境阶段：根目录 `npm run e2e` 编译带双策略补丁的真实中继，启动真实网关与本地模型/推送替身，运行 Chromium 双上下文冒烟；完整问诊与试点指标待 M1-15a 合并后接。前提、缓存和验证边界见 [e2e/README.md](e2e/README.md)。
