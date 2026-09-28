---
description: 汇总变更、自动递增版本号，提交推送并发布 GitHub Release
argument-hint: [0.3.0.0 | minor | major，留空则末位自动 +1]
---

# /ship — AnyFilter 发布流程

严格按以下顺序执行，任何一步失败立即停下并报告原因，不得跳过继续。
用户参数：$ARGUMENTS（可为空）。

## 1. 汇总变更

- 运行并阅读结果：
  - `git status --short`
  - `git diff --stat` 与 `git diff --cached --stat`
  - `git log --oneline -5`
  - `git tag -l | sort -V | tail -3`（确定上一个发布 tag）
- 结合本次会话完成的工作，归纳交付要点，作为提交说明与 Release Notes 的素材。
- 若工作区无任何变更，向用户确认是想重新发布还是取消，不要自行发明变更。

## 2. 版本号自动累加

- 从 `wxt.config.ts` 读取 `manifest.version`（4 段式，形如 0.2.0.x）。
- 递增规则：
  - 参数留空：末段 +1（例 0.2.0.0 → 0.2.0.1）
  - 参数为 `minor`：第 2 段 +1，后两段清零（例 0.2.0.0 → 0.3.0.0）
  - 参数为 `major`：首段 +1，后三段清零（例 0.2.0.0 → 1.0.0.0）
  - 参数为显式 4 段版本号：直接使用（例 0.3.0.0）
- 同步修改两处：
  - `wxt.config.ts` 的 `manifest.version` → 完整 4 段
  - `package.json` 的 `version` → 前三段（例 0.2.0.1 → 0.2.0）
- 向用户确认一次「旧版本 → 新版本」后再继续。

## 3. 验证与构建

- `pnpm build`：类型检查 + WXT 构建必须成功。
- `pnpm test:unit`：全部测试必须通过，失败则停止并报告。
- `pnpm zip`：确认生成 `.output/anyfilter-<新版本>-chrome.zip`。
- 禁止在此流程中自动发起任何真实（收费）的 Jev 调用或联网评估。

## 4. 提交并推送

- `git add -A` 后用 `git status --short` 复核暂存清单：不得混入
  `.output/`、`tmp/`、`.specstory/`、`.cursorindexingignore`、`.cursor/` 下除 `commands/` 以外的内容。
- 提交说明使用 conventional commit 格式：
  - 标题：`feat|fix|chore: 摘要 (v<新版本>)`
  - 正文：按主题分组（如 规则模型 / 存储迁移 / 执行链路 / 侧边栏 UI / 预览 / 测试与 CI / 文档，按实际情况取舍），只写本次真实完成的项。
- 推送当前分支（`git push`）。

## 5. 发布 GitHub Release

- 撰写中文 Release Notes（写入临时文件，如 `/tmp/release-notes-v<版本>.md`）：
  - 「本版本亮点」：按主题分组，面向使用者，与提交说明一致
  - 「安装」：下载附件 zip → 打开 `chrome://extensions` → 开启开发者模式 → 加载已解压的扩展程序
  - 「Full Changelog」：上一个 tag 到新 tag 的 compare 链接
  - 禁止声称未经真实评估验证的准确率或质量结论
- 执行：
  ```
  gh release create v<新版本> .output/anyfilter-<新版本>-chrome.zip \
    --title "AnyFilter v<新版本>" --notes-file /tmp/release-notes-v<版本>.md
  ```
- 用 `gh release view v<新版本>` 验证 tag、标题与附件均已就绪。

## 6. 汇报

最后向用户汇报：新版本号、提交哈希、Release URL、附件名称与大小、以及任何未尽事项（例如未执行的真实 Jev 评估）。