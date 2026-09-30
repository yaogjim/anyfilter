/**
 * Simplified Chinese UI strings for the side-panel and options-page shells
 * (translate-key resource).
 *
 * Must keep exactly the same key set as `shell.en.ts`, with the same `{name}`
 * placeholders per key. Placeholders carry technical or user-authored values
 * that must not be translated (counts, provider error details). Rule names,
 * post text and backend error details are never stored here.
 */
export const shellZh = {
  'shell.loading': '加载中…',
  'shell.overview': '过滤概览',
  'shell.settingsHeading': '设置',
  'shell.openFullPage': '在新标签页打开',

  'shell.status.filterOff': '过滤已关闭 · 显示全部 {count} 条帖子',
  'shell.status.addApiKey': '请在设置中添加 API 密钥以启用语义过滤',
  'shell.status.failureRateLimited': '服务提供方正在对此密钥限流——将自动重试',
  'shell.status.failureAuth':
    '服务提供方拒绝了 API 密钥（401/403）——请在设置中检查',
  'shell.status.failureNetwork': '无法连接到服务提供方：{detail}',
  'shell.status.failureBadResponse': '服务提供方返回了意外的响应：{detail}',

  'shell.nav.home': '主页',
  'shell.nav.views': '页面导航',
  'shell.nav.settings': '设置',
  'shell.nav.verification': '验证',
  'shell.filterOn': '启用过滤',

  'shell.hidden.postsTitle': '隐藏的帖子',
  'shell.hidden.tabs': '已隐藏内容',
  'shell.hidden.tabPosts': '帖子 {count}',
  'shell.hidden.tabReplies': '回复 {count}',
  'shell.hidden.groupBy': '分组方式',
  'shell.hidden.byRule': '按规则',
  'shell.hidden.byCategory': '按分类',
  'shell.hidden.noneYet': '暂无内容。',
  'shell.hidden.nothingYet': '暂无隐藏内容，浏览信息流即可开始过滤。',
  'shell.hidden.adBadge': '广告',
  'shell.hidden.hideAgain': '再次隐藏',
  'shell.hidden.putBack': '恢复到信息流',
  'shell.hidden.openOnX': '在 X 中打开 ↗',

  // 主页横幅：需要先配置才能过滤时显示。
  'shell.banner.configure': '去配置',

  'shell.tiles.hidden': '已隐藏',
  'shell.tiles.kept': '已保留',
  'shell.tiles.scanned': '已扫描',
  'shell.tiles.timeSaved': '节省时间',
  'shell.tiles.spent': 'Jev 费用',
  'shell.tiles.tokens': '令牌用量',
  'shell.tiles.more': '其他数据',

  'shell.reason.inConversation': '对话中的回复',
  'shell.reason.repliesUnder': '回复于',

  'shell.post.showMore': '显示更多',
  'shell.post.video': '视频',

  'shell.options.title': 'AnyFilter 设置',
  'shell.options.subtitle': '在 X 上进行过滤。服务提供方与阈值随编辑保存；规则在应用时保存。',
  'shell.options.sections': '设置分区',
  'shell.options.onThisPage': '本页内容',
  'shell.nav.appearance': '外观',
  'shell.nav.models': '模型与密钥',
  'shell.nav.behavior': '过滤行为',
  'shell.nav.rules': '规则',
  'shell.nav.capture': '验证样本',
  'shell.nav.data': '数据',
} as const;