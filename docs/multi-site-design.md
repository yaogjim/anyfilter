# 多站点适配：设计

状态：**阶段 1 已实现**（X 用户主页、List）；阶段 2、3 只是设计，未承诺，未实现。整体方向见 `anyfilter-vision.md`，远期条目见 `roadmap.md` 第 5 条。本文回答两件事：还要适配哪些页面，以及通用网页的内容怎么读到、怎么判断、怎么复核。

## 1. 三个阶段

| 阶段 | 范围 | 权限变化 | 状态 |
| --- | --- | --- | --- |
| 1 | X 用户主页（Posts 标签）、X List 时间线 | 无，仍然只有 `https://x.com/*` | 已实现 |
| 2 | 通用网页的**单篇文档**判定（如一篇博文），页面徽标，复用复核颜色约定 | 逐站授权，默认关闭 | 设计 |
| 3 | 按站点的**信息流适配器**（Substack 首页与评论、HN、Reddit 等） | 同上，逐站 | 设计 |

### 1.1 阶段 1 实际做了什么

- 这两类页面和主页用同一套 `article[data-testid="tweet"]` 单元格，所以读取、隐藏、复核装饰都没改。唯一的差别是页面白名单，已经抽成 `src/domain/x-pages.ts`，不依赖 DOM，可以单测。
- 用户主页只放行 Posts 标签（`/<handle>`）。Replies、Media、Likes、关注者列表不放行：回复标签里的帖子没有父帖上下文，`replies` 范围的规则会退化；Media 和 Likes 不是普通帖子流。
- List 只放行 `/i/lists/<id>` 本身，不放行成员和关注者页。
- 验证样本采集（`capture.ts` 的 `xPageOf`）**刻意保持更窄**，仍然只有主页、搜索、帖子页。过滤和复核只读屏幕上已有的内容，不留存；采集会存帖子文本。主页和 List 上的帖子不会进入验证样本库，`PRIVACY.md` 里的采集说明因此不变。
- 已知的产品取舍：你专门打开一个人的主页，说明你想看他的帖子，过滤模式下仍可能把其中命中规则的帖子折叠。可以在侧栏里恢复，复核模式下只标注不隐藏。如果这在实际使用里让人不舒服，再考虑“主页不隐藏，只复核”的开关，现在不加。

## 2. 内容单元有三种形态

现在的代码只有一种单元：X 上的一条帖子。多站点要先分清：

| 形态 | 例子 | “过滤”的含义 |
| --- | --- | --- |
| 信息流 | X、Substack 首页或归档、HN、Reddit | 逐条判断，隐藏或标注，和现在一样 |
| 单篇文档 | 一篇博文（如 noahpinion 上的文章） | 整页一个判定，用页面徽标显示。**不隐藏正在读的文章**；最多提示“这页可能是 XX”，由用户决定 |
| 文档内的子项 | 评论区、嵌入的推文 | 属于信息流形态，需要按站点写适配器 |

一个提醒：好文章（如上面的例子）本来就不该被过滤，这类页面的价值是“值不值得读”的提示，和 `anyfilter-vision.md` 里“往上挑”的方向一致，不是“往下筛”。

## 3. 读取网页内容

### 3.1 选择：Defuddle

Obsidian Web Clipper 的做法（核对过 `src/content.ts`）：在内容脚本里对当前文档调用 `new Defuddle(document, { url })`，取回 `content / title / author / published / description / language / image / schemaOrgData` 等字段，解析前先展开 Shadow DOM，并给解析加了超时。Defuddle 是 MIT 协议，由同一作者维护，源码见 https://github.com/kepano/defuddle。

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| **Defuddle（选用）** | 宽松，保留正文的同时去掉导航、侧栏、评论等噪声；有元数据；有 X、Reddit、HN、GitHub 等站点抽取器可参考；`includeReplies` 可控制回复 | 依赖多一个包，需要测量打包体积 |
| Mozilla Readability | 老牌，稳定 | 偏严格，只面向文章，元数据少，一些页面直接返回空 |
| 自己取 `og:title`、`meta author`、`article` 或 `main` 的 `innerText` | 零依赖 | 对结构杂乱的页面很脆，提取质量会直接变成判定质量，最后还是要补 |

只用核心包取纯文本和元数据，**不引入 `defuddle/full`**（Markdown 转换我们用不上）。

### 3.2 提取结果

```ts
interface ExtractedDocument {
  url: string;            // 页面地址，去掉 query 与 fragment
  canonicalUrl: string;   // link[rel=canonical]，缺则等于 url
  title: string;
  author: string;
  site: string;
  published: string;
  description: string;
  language: string;
  text: string;           // 纯文本，已按字数上限截断
  wordCount: number;      // 截断前的字数
  truncated: boolean;
}
```

### 3.3 送给模型的内容

- 整篇文章一次发给模型比一条推文贵得多，所以要有硬上限。**取标题、摘要、小标题，加正文开头若干字**，上限数值要先在真实页面上测量，不预设。
- 被截断要在判定里如实标出（`truncated`），不能把“只看了开头”当成“看完了”。
- 页面上嵌入的内容（比如文章里引用的推文）当作作者放进正文的内容看待，不递归展开。
- 缓存键用规范化 URL 加正文内容哈希，和现在 `postContentKey` 的思路一致：正文变了，旧答案作废。

## 4. 权限与隐私

`roadmap.md` 已有的约束：**不把 X 的站点权限扩大成全站读取。**

- `optional_host_permissions` 声明可选的全站权限，默认不授予。
- 侧栏里的“在这个站点启用”按钮调用 `chrome.permissions.request({ origins: [origin] })`，一次只授权一个站点，用户可随时在同一位置撤销。
- 授权后通过 `chrome.scripting.registerContentScripts` 动态注册该站点的内容脚本；未授权的站点扩展完全读不到。
- 阶段 2 的第一版**只做手动**：用户点“判断本页”才提取、才外发，不自动扫描。自动模式要另外定义打扰上限和费用上限，见 `roadmap.md` 第 2、3 条的做法。
- 实现前要验证两件事：侧栏点击能否拿到 `activeTab`（这决定第一版能不能连持久授权也不要）；`permissions.request` 从侧栏页调用是否满足用户手势要求。
- 首次在某站点外发前，明确告知：**这一页的文字会发给你选的模型服务商**。`PRIVACY.md` 要新增专门一节，列出发送的字段（标题、作者、摘要、截断后的正文、被问的规则）。
- 默认不处理登录后的私密页面：邮件、网盘、内网、网银等。要不要外发是逐来源的决定，见第 7 节。

## 5. 数据模型与适配器

### 5.1 数据模型：只加字段，不另起一套

`Post` 现在绑定了 X（`statusUrl`、`handle`、status ID）。复核、评估、缓存、面板都在用它，另起一套代价太大。建议只增不改：

- `source: 'x' | 'web'`，缺省为 `'x'`，旧数据不用迁移。
- `url`：规范链接。有它时 `postUrl` 直接返回它，否则退回现在的 `statusUrl`。
- `title`：文章标题，X 帖子为空。
- `kind` 增加 `'article'`。
- 文章的 `id` 用规范化 URL 的哈希。

`classifier.ts` 里的 `stateOf` 要区分：帖子送 `author/text/quoted/replyingTo`；文章送 `title/author/site/published/description/text`，并带 `truncated`。

### 5.2 适配器

```ts
interface SiteAdapter {
  id: string;
  /** 这个 URL 属于哪种形态，不认识就返回 null。 */
  surface(url: URL): 'feed' | 'document' | null;
  /** 信息流：就是现在的 TimelineView。 */
  feed?(): TimelineView;
  /** 单篇文档：读出文本，画页面徽标。 */
  document?(): DocumentView;
}
```

X 成为第一个适配器，行为不变。其余站点按 `surface()` 匹配，没有匹配的站点什么都不做。

## 6. 规则、成本、复核

- **规则要有适用范围。** 现有 10 条规则是按 X 短文本调的（见 `rule-tuning-2026-09.md`）。给规则加 `surfaces`，与现在的 `scope` 并列；内置规则保持只适用于 `post`。
- **文章的候选规则**（只是方向，规格要按 `filter-rules.md` 的格式先写清楚再实现）：标题党、纯营销、SEO 垃圾、低信息量复述、明显的机器批量生成内容。
- **预算。** 沿用现有的费用上限，并新增“单页字数上限”。
- **复核。** 页面徽标沿用 `anyfilter-vision.md` 的颜色约定，并且文字也要标出来（棕红、绿、琥珀、金色），不能只靠颜色。标注复用 `ReviewLabel`，身份用规范化 URL 加内容哈希。徽标在页面里用 Shadow DOM，不改页面自己的样式。
- **评估。** X 上的准确率数字**不能**搬到文章上。文章要有自己的样本、盲审和报告。文档样本默认只存摘录加 URL，不存整篇，版权和隐私都更稳妥。

## 7. 阶段 3：信息流适配器的进入条件

每加一个站点，先回答 `roadmap.md` 的四个问题，再写适配器：

1. 内容的身份怎么识别（稳定 ID 是什么）？
2. 能不能外发给模型？私密内容默认不外发。
3. 本地保存多久？
4. 用户怎么删除？

候选次序，按价值和风险粗排（不是承诺）：

| 站点 | 单元 | 备注 |
| --- | --- | --- |
| Substack 首页、归档、Notes、评论 | 卡片、评论 | 与阶段 2 的文档判定共用站点授权 |
| Hacker News | 条目、评论 | 结构简单稳定 |
| Reddit | 帖子、评论 | 不同界面版本的结构可能不同，进入时先逐一验证 |

不做自动识别“任意网页里的重复卡片”这种通用启发式：误判难以解释，也无法评估。

## 8. 验收

**阶段 1**（已完成）：

- `pnpm test:unit`：`scripts/test/x-pages.test.mjs` 覆盖路径分类，包括保留路径、超长用户名、List 的成员页、Replies 标签、以及“采集比过滤更窄”。
- `pnpm e2e`：在离线夹具上验证 `/<handle>` 和 `/i/lists/<id>` 会被读取并标注，`/<handle>/with_replies` 和 `/notifications` 不会。

**阶段 2**（进入条件）：

- 先在真实页面上测量 Defuddle 的打包体积和提取质量：至少取 20 个不同站点的文章页，人工确认标题、作者、正文提取是否正确，并统计失败率。
- 上面第 4 节两个平台行为已验证。
- 你定义好文章规则的规格。
- 在这之前不写实现代码。
