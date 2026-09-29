# 时间线复核模式：首期设计

状态：已按本设计实现（R1–R4 完成，R4 于 2026-09-29 在 Canary 验收）。需求与验收用例见 `timeline-review-prd.md`。本文只讲怎么接入现有代码，不涉及真实浏览或模型调用。

## 1. 现有代码里有什么

| 位置 | 现状 | 对复核模式的意义 |
| --- | --- | --- |
| `src/features/feed-filter.ts` | 每帖有 `pending / scored / rule-only / failed` 四种状态。`scored` 里已经保存了**全部规则的分数**和 `questionsKey` | 数据基本已有，不需要新的模型请求 |
| 同上 `everyQuestionAnswered()` | 判断所有问题是否都有有效回答 | 直接用它区分“绿色”和“琥珀” |
| 同上 `apply()` | 命中就调用 `view.hide()` | 复核模式要把它换成“只装饰，不隐藏” |
| `src/domain/timeline-view.ts` | 接口只有 `hide / show / scan / read / unmark` | 需要新增装饰和清除 |
| `src/infrastructure/timeline-view.ts` | `hide` 动画折叠，隐藏后内容不可点 | 复核模式不走这条路径 |
| `src/domain/capture.ts` | 已有 `sampleIdFor(post)` 和输入指纹 | 标注的身份用它，不重复造 |
| `src/features/evaluation-capture.ts` | 可选的观察者，关闭时不影响过滤 | 复核用同样的“可选、默认惰性”模式 |
| `src/infrastructure/capture-store.ts` | 采集库，300 条，7 天 | **不复用**，标注单独存 |

## 2. 总体思路

正常过滤与复核共用同一次判断结果。复核只改变判断之后的**显示策略**。

```
分类结果 → FeedFilter 记录状态
             ├─ 正常模式：apply() → view.hide()（照旧）
             └─ 复核模式：reviewObserver 收到判定快照 → view.decorate() 装饰
```

## 3. 数据结构

### 3.1 判定快照（只读，随判断产生）

```ts
interface ReviewSnapshot {
  sampleId: string;          // 复用 sampleIdFor(post)
  inputHash: string;         // 复用 captureInputHash
  postId: string;
  threadId: string;
  state: 'kept' | 'flagged' | 'undecided';  // 绿 / 棕红 / 琥珀
  undecidedReason?: 'pending' | 'failed' | 'missing-answer' | 'no-context';
  rules: Array<{ ruleId: string; score: number | null; threshold: number; hit: boolean }>;
  direct: boolean;           // true：本帖命中；false：线程联动
  rulesFingerprint: string;
  at: number;
}
```

规则：

- `kept` 仅当 `status === 'scored'` 且 `everyQuestionAnswered()` 为真且没有命中，或 `rule-only` 且没有命中且没有需要模型回答的规则。
- `pending`、`failed`、缺回答、缺父帖上下文一律是 `undecided`。**不能**用 `reasons.length === 0` 推出“绿色”。
- 输入变化（正文、引用、父帖）时生成新快照，旧快照作废。

### 3.2 人工标注（单独存储）

```ts
interface ReviewLabel {
  sampleId: string;
  inputHash: string;
  overall: 'hide' | 'keep' | 'uncertain';
  rules: Array<{ ruleId: string; label: 'match' | 'no-match' | 'insufficient' }>; // 只含实际看过的
  noRuleCovers?: string;      // “现有规则不覆盖”的原因，一句话
  valuable: boolean;          // 值得看（金色）
  revision: number;           // 更正序号，撤销记为删除并保留 revision
  source: 'in-timeline-assisted';  // 永远不标 blind
  at: number;
}
```

“暂时隐藏 / 恢复”是页面动作，**不写入标注库**。

## 4. 各层怎么改

### 4.1 领域和分类（`FeedFilter`）

- 新增一个可选的 `ReviewObserver` 端口，风格与 `CaptureOutcomeReporter` 相同：不存在或未开启时什么都不做。
- 在分类结果、规则变更、线程联动变更这几处发出 `ReviewSnapshot`。
- 复核开启时 `apply()` 不调用 `hide()`，改调用 `decorate()`；退出时清除装饰，并按当前设置重新执行一次 `apply()`。
- 沿用现有的 generation 与逐帖 attempt 机制，迟到的旧响应不产生快照。
- 不新增任何模型请求。

### 4.2 页面适配（`TimelineView`）

- 接口新增 `decorate(postId, view)` 和 `clearDecoration(postId)`；旧的 `hide / show` 不改。
- 装饰内容：边框、状态文字标签、展开面板挂载点。
- 标签和面板放在一个带标记属性的宿主里（沿用 `PROCESSED_ATTRIBUTE` 的做法），防止 MutationObserver 因为自己注入的节点而重复扫描。
- 只给视窗附近的帖子挂完整面板，节点被回收时清理监听器。
- 事件不冒泡到 X 的点赞、转发等按钮。
- 用 `prefers-reduced-motion` 关闭动画。
- 面板样式用 shadow DOM 隔离，避免和 X 样式互相污染。

### 4.3 内容脚本（`content.ts`）

- 复核开关是一个**全局设置**（`settings.reviewMode`，默认开启），对所有 X 页面有效，刷新和新开页面都保持同一状态；页面通过设置变化事件跟随，不再有按页面的运行时消息。
- 侧栏首页和设置页里的开关写同一个设置。页面工具条上的“退出”也是关闭这个全局设置。
- 复核模式开启时不隐藏任何帖子；要真正隐藏，需要关闭它。
- 开启和退出**不修改** `Settings.filterOn`、规则或阈值。

### 4.4 存储与消息

- 标注单独放在 `chrome.storage.local` 的新 key 里，与采集样本库分开。
- 默认上限 1000 条标注，超出时淘汰最旧的未“值得看”标注；可以整体删除。（这是默认值，可调整。）
- 内容脚本只发送最小化的标注消息（样本身份、结论、规则标签、值得看）。后台负责校验消息来源、大小和格式，串行写入并处理更正，这与现有 `record-outcomes` 的做法一致。
- “清空数据”同时清除标注库，并使清空前的迟到写入失效。

### 4.5 工具条与筛选

- 筛选只做显示：被筛走的帖子用现有的“装饰隐藏”类，不走 `hide()`，可一键“显示全部”。
- 分数滑杆只对选定的某条规则、已有分数的帖子生效，未评分与本地广告不参与。
- 滑杆状态只在内存，不写回设置。
- 工具条位置也只在页面内存里：拖动标题行改变位置，随窗口尺寸变化保持在窗口内；默认折叠，只显示计数、暂停、筛选、退出。
- 单帖面板是挂在 `body` 上的固定定位节点，优先放在帖子右侧，放不下时放左侧或贴窗口边，随滚动和窗口变化重新定位；帖子完全滚出视口时隐藏。

## 5. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 满屏红绿造成阅读负担 | 默认弱化非当前帖，聚焦或悬停才展开完整信息 |
| 虚拟列表复用节点导致标注串帖 | 以 `sampleId + inputHash` 匹配，不按位置或颜色 |
| 线程里一条命中让整串看起来违规 | 明确标注“本帖命中 / 线程联动”，标注只落在用户实际判断的那条 |
| 标注被误当作准确率证据 | `source` 固定为 `in-timeline-assisted`，报告里与盲审分开 |
| 复核模式意外触发收费请求 | 不新增分类调用；测试里断言开启、退出、拖动滑杆时请求数不变 |
| 装饰破坏 X 原有交互 | 不改 X 的按钮，事件不冒泡，验收用例覆盖 |

## 6. 开发顺序与验证

| 阶段 | 内容 | 验证 |
| --- | --- | --- |
| R1 | 判定快照、`decorate` 接口、复核开关和退出 | 单测：快照状态判定（绿/棕红/琥珀）、开关不改设置、迟到响应被丢弃；夹具页：命中帖保持可见 |
| R2 | 标注存储、后台消息、单帖面板、撤销、值得看 | 单测：规则标签只含勾选项、更正与撤销、上限淘汰、清空后不复活；夹具页：刷新后重新对上 |
| R3 | 工具条、筛选、分数滑杆、暂时隐藏 | 单测与夹具：滑杆不发请求、不改阈值，节点复用不串帖，线程联动标注 |
| R4 | 真实浏览器验收（Canary） | 手动确认视觉、键盘、不遮挡 X 按钮；复核模式全程请求数不变 |

各阶段用现有命令验收：`pnpm typecheck`、`pnpm test:unit`、`pnpm build`、`pnpm e2e`。代码改动后重新构建 `dist/` 供试用。

## 7. 与其他工作的关系

- 复核标注是“有提示的诊断数据”，不能替代 Jev 基线和随机盲审；两条工作线互不阻塞、分开存、分开报告。
- 远期设想（模型推荐金色、优先队列、自动滚动、其他内容源）见 `roadmap.md`，首期不为它们预留抽象。
