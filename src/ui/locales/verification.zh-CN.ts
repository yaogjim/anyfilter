/**
 * Simplified-Chinese UI resources for the verification and capture sections of
 * the side panel.
 *
 * Same key set as `verification.en.ts`, one value per key, so the two tables can
 * never drift: every key the components pass to `t(...)` exists here. Dynamic
 * values are `{name}` placeholders substituted by the shared `Translate`
 * implementation; placeholders carry technical values (model name, formatted
 * amount, domain reason detail, rule label, sample text) that must not be
 * translated.
 *
 * Wording notes preserved verbatim in meaning: the spend cap is a local estimate
 * and not a provider-enforced hard cap; an unknown charge keeps its reservation
 * and stopping does not refund it; a request that may already have been charged
 * is never retried on its own; and nothing is sent without an explicit click and
 * a confirmation of the exact text.
 */

/** Capture-name key set, spread into {@link verificationZh} as well. */
export const captureZh = {
  'capture.heading': '采集管理',
  'capture.loading': '加载中…',
  'capture.status.off': '已关闭 — 不会从页面读取任何内容。',
  'capture.status.paused': '已暂停 — 保留 {stored} 个样本。',
  'capture.status.active': '采集中 — 已存储 {stored} 个样本。',
  'capture.pause': '暂停采集',
  'capture.resume': '继续采集',
  'capture.start': '开始采集',
  'capture.turnOff': '关闭',
  'capture.deleteSamples': '删除样本',
  'capture.privacyNote':
    '仅在本机保存已加载的 X 文本；采集本身不调用模型。正常过滤仍可能向所选服务商发请求；验证外发前请逐条确认。',
  'capture.detailsSummary': '采集范围与删除说明',
  'capture.scopeNote':
    '默认关闭。开启后，它会读取浏览器已在打开的 X 主页、搜索或帖子页面加载过的公开文本，并在本浏览器中保留本地副本。当你的账号可识别时会跳过自己的帖子；否则会等待观察。没有文本或匹配到受保护占位符的帖子会被跳过，但这些检查无法保证每个已保存帖子都是公开或可安全分享的。采集本身不发起模型请求，也不改变过滤隐藏的内容；正常过滤仍可能将帖子发送给你所选的服务商。此样本库并非随机抽样、也未经人工复核，因此无法据此得出准确率。删除样本只会移除此样本库 — 你的规则、阈值和密钥都会保留。如果你手动验证过某个样本，其独立的任务记录（不含帖子文本）以及已花费或未结算的费用在删除后仍会保留。',
  'capture.retentionNote':
    '样本库最多保留 {max} 个样本；超出时先丢弃最旧的。样本在七天后过期，并会在扩展后台下次运行时移除。已读取但未存储的观察：{skipped} 条。设置中的“清除全部”不会删除这些样本；请在此使用“删除样本”。',
} as const;

export const verificationZh = {
  'verification.heading': '单条验证',
  'verification.loading': '加载中…',
  'verification.budgetNote':
    'USD 1 是按估算费用控制的本地预算，并非服务商强制执行的消费限额。发送样本可能向你的 TypeSafe 账户扣费。',
  'verification.budgetOn': '预算已开启',
  'verification.enableBudget': '开启验证预算（USD 1 上限）',
  'verification.stopBudget': '停止验证预算',
  'verification.stopNote':
    '停止会拒绝所有新请求。它无法撤回已发送的请求：该请求仍可能被扣费，其预留会作为未知保持冻结，而不会退回。',

  // 预算状态行（`statusLine`）。`{amount}` 是已格式化好的金额。
  'verification.status.disabled':
    '验证预算已关闭。在你于下方开启之前，不会发送任何内容。',
  'verification.status.disabledHeld':
    ' 已发送请求预留的 {amount} 仍被冻结；停止不会退回该预留。',
  'verification.status.onForModel': '预算已开启：{model}',
  'verification.status.cap': '上限 {amount}',
  'verification.status.spent': '已花费 {amount}',
  'verification.status.held': '冻结 {amount}',
  'verification.status.available': '可用 {amount}',

  // 单次运行结果（`resultText`）。`{detail}` 是不翻译的领域详情。
  'verification.result.match':
    '匹配 — 分数 {score}，阈值 {threshold}。该分数是模型自身的判断，不是准确率。',
  'verification.result.noMatch':
    '不匹配 — 分数 {score} 低于阈值 {threshold}。该分数是模型自身的判断，不是准确率。',
  'verification.result.undecided':
    '未决 — 该调用已计费，但对此规则未返回可用答案。{detail}',
  'verification.result.unknown':
    '未知 — 请求可能已发送且未记录到可用用量，因此其预留保持冻结，且不会被自动重试。{detail}',
  'verification.result.skipped': '未发送 — {reason}。{detail}',

  // 未发送的原因（`skipLabel`）。原因代码本身是领域值。
  'verification.skip.notAuthorized': '未获授权',
  'verification.skip.noKey': '未存储 TypeSafe 密钥',
  'verification.skip.sampleNotFound': '样本已不再存储',
  'verification.skip.notSendable': '该样本不允许离开此浏览器',
  'verification.skip.ruleNotCompiled': '该规则对此样本没有可用的判断问题',
  'verification.skip.budgetDisabled': '验证预算已关闭',
  'verification.skip.capExceeded': 'USD 1 上限不足以再覆盖一次请求',
  'verification.skip.budgetRefused': '预算拒绝了此次预留',
  'verification.skip.alreadyRecorded': '完全相同的任务已记录；绝不会重复发送',
  'verification.skip.jobInactive': '停止或删除先生效，因此未发送任何内容',
  'verification.skip.storage': '请求无法完成',
  'verification.skip.wrongSender': '请求并非来自本扩展自身的页面',

  // 预算/费用/安全说明（`disclosureLines`）。`{model}` 与 `{cap}` 是技术值，不翻译。
  'verification.disclosure.model':
    '模型：TypeSafe Jev 1.13（{model}）。模型已固定并核验；此处无法选择其他模型、端点或密钥。',
  'verification.disclosure.cap':
    '花费上限：本验证预算为 {cap}。任何内容发出前都会先冻结公布的最坏情况费用。这是按 Jev 1.13 公布价格做的本地估算，不是服务商强制执行的硬性花费上限；服务商定价可能变化。',
  'verification.disclosure.charge':
    '真实请求可能从你存储的 TypeSafe 密钥所对应的账户扣费，且无法撤回或退款。',
  'verification.disclosure.thirdParty':
    '所选样本可能包含第三方内容。在请求调用前，请确认这一条帖子可以发送。',
  'verification.disclosure.score': '返回的分数是模型自身的判断，不是准确率。',
  'verification.disclosure.unknownUsage':
    '如果响应未报告可用的用量，其预留将作为未知保持冻结，而不是被猜测。',

  // 精确原文旁的警告（`flagText`），键为领域 flag key。
  'verification.flag.exactState':
    '这就是一次验证将发送的精确存储状态：作者、完整正文以及任何引用或父帖文本。不会从页面重新读取，也尚未发送任何内容。',
  'verification.flag.truncated':
    '该正文在采集时已被截断，因此上面的文本可能不是所读取帖子的完整内容。',
  'verification.flag.excerptMismatch':
    '存储的摘录与存储的正文不一致，说明此前显示的简短预览描述的是不同的文本。请将该样本视为不确定。',
  'verification.flag.thirdParty': '此预览包含他人撰写的引用或父帖内容。发送前请完整阅读。',

  // 预览读取被拒绝的原因（`previewRefusalText`）；原因代码是领域值。
  'verification.previewRefusal.wrongSender': '请求并非来自本扩展自身的页面',
  'verification.previewRefusal.sampleNotFound': '样本已不再存储',
  'verification.previewRefusal.unreadable': '无法加载预览',

  // 单行来源标签（`sourceLabel`），每个采集页面一个。
  'verification.source.home': '主页',
  'verification.source.search': '搜索',
  'verification.source.status': '帖子',
  'verification.sourceLabel': '来源',
  'verification.allSources': '全部来源',

  // 简短相对时间（`relativeTime`）。
  'verification.time.justNow': '刚刚',
  'verification.time.minutesAgo': '{minutes} 分钟前',
  'verification.time.hoursAgo': '{hours} 小时前',
  'verification.time.daysAgo': '{days} 天前',

  // 有界、分页的样本列表。
  'verification.localSamples': '本地样本',
  'verification.noSamples':
    '还没有已存储的样本。请在“采集管理”中采集。不会自动发送任何内容。',
  'verification.searchSamples': '搜索样本',
  'verification.searchPlaceholder': '搜索正文或来源',
  'verification.selectFree': '选择样本不收费 — 不会发送任何内容。',
  'verification.badge.truncated': '已截断',
  'verification.badge.promoted': '推广',
  'verification.badge.reply': '回复',
  'verification.noMatching': '没有匹配的样本。',
  'verification.previous': '上一页',
  'verification.page': '第 {page} / {count} 页',
  'verification.next': '下一页',

  // 详情面板。
  'verification.backToSamples': '← 返回样本列表',
  'verification.selectSample': '选择一个样本以查看其完整原文。选择不收费。',
  'verification.exactTextHeading': '将要发送的精确原文',
  'verification.previewLoading':
    '正在加载精确存储原文… 在显示之前不会发送任何内容。',
  'verification.previewUnreadable': '无法读取存储的原文。',
  'verification.cannotSend': '此样本无法发送。',
  'verification.fullSource': '完整来源',
  'verification.quotedPost': '引用帖',
  'verification.replyingTo': '回复给',

  // 规则选择。
  'verification.ruleLabel': '启用的语义规则',
  'verification.chooseRule': '请选择一条规则…',
  'verification.threshold': '阈值',
  'verification.noApplicableRule':
    '没有适用的已启用语义规则。仅针对回复的规则需要父帖上下文。',

  // 确认与单次发送。
  'verification.confirm':
    '我已阅读上面的精确原文，并确认这一条帖子可以发送给 TypeSafe。它可能向我的账户扣费，且无法撤回。',
  'verification.running': '正在执行单条验证…',
  'verification.send': '发送此样本进行验证',
  'verification.sendNote':
    '一次点击仅针对此样本和此规则发送一条请求。不会排队、重复或遍历，且除非你按下按钮，否则不会发出任何请求。模型、价格、端点和已存储的 TypeSafe 密钥在此固定，无法编辑。在此样本的精确原文加载、显示并确认之前，按钮保持禁用。',
  'verification.disclosureSummary': '预算、费用与安全说明',

  // 结果下方的追踪摘要。
  'verification.trace.requested': '请求',
  'verification.trace.answered': '应答',
  'verification.trace.tokensIn': '输入 token',
  'verification.trace.unknown': '未知',
  'verification.trace.out': '输出',
  'verification.trace.recordedCost': '记录费用',
  'verification.trace.truncated': '所采集正文已被截断',

  'verification.unknownHeld':
    '此次调用的预留会一直冻结，直到你进行核对，因为该请求可能已被扣费。',

  // 预算开启/停止的确认。被拒绝时改为原样显示领域详情。
  'verification.message.enabled': '验证预算已为固定的 Jev 1.13 模型开启。',
  'verification.message.stopped':
    '验证预算已停止。在你重新开启之前，不会发送任何新请求。已发送的请求仍可能被扣费，其预留会作为未知保持冻结；停止不会退回它。',

  ...captureZh,
} as const;