import type { pageEn } from './page.en';

/** “本页”视图的中文文案。键必须与 `page.en.ts` 完全一致。措辞按 article-rules.md：
 * 页面“读起来像”某种东西并显示概率，不对页面或作者下断言。 */
export const pageZh: Record<keyof typeof pageEn, string> = {
  'page.nav': '本页',
  'page.heading': '本页',
  'page.intro':
    '只在你按下按钮时读取你打开 AnyFilter 的这个标签页，并把开头 {count} 字一次性发给你的模型服务商。不保存，也不会在后台自动判断。',
  'page.judge': '判断本页',
  'page.judging': '正在判断…',
  'page.judgedPage': '{title} · {units} 字',
  'page.untitled': '无标题页面',
  'page.truncatedNote': '只判断了开头 {count} 字。',

  'page.notArticle.title': '没有当作文章来判断',
  'page.notArticle.blocked': '这像是一个人机验证页或错误页。',
  'page.notArticle.tooShort': '这一页文字太少，无法当作文章判断。',
  'page.notArticle.rootPage': '这是网站首页，不是单篇文章。',
  'page.notArticle.loginPage': '这是登录页，不是文章。',
  'page.notArticle.xPage': '这是 X 的页面。X 由信息流过滤逐条读取，不按单篇文章判断。',
  'page.notArticle.model': '模型认为这不是单篇文章（列表、信息流或目录），所以没有套用规则。',

  'page.rule.marketing': '纯营销',
  'page.rule.clickbait': '标题党',

  'page.match': '读起来像{label} · {probability}%（阈值 {threshold}%）',
  'page.clean': '没有命中任何规则。',
  'page.othersMatched': '同时命中：{labels}',
  'page.undetermined': '{label}：未判定，{reason}',
  'page.reason.truncated': '只读了页面开头',
  'page.reason.paywall': '这像是付费墙预览',
  'page.reason.noAnswer': '模型没有给出答案',
  'page.details': '每条规则',
  'page.detail.scored': '{label}：{probability}% · 阈值 {threshold}%',
  'page.detail.unscored': '{label}：没有答案',
  'page.disclaimer': '这是只读文字的模型给出的概率，说的是文字读起来像什么，不是谁写的或为什么写。',

  'page.hint.needsIcon':
    '要读这个标签页，请在它显示时点一下工具栏里的 AnyFilter 图标。chrome:// 之类的浏览器页面完全读不了。',
  'page.hint.unreadable': '这类页面读不了。',
  'page.hint.xPage': '这是 X 的页面，由信息流过滤处理，这里没有可判断的内容。',
  'page.error.noAccess':
    '读不到这个标签页。请在这个标签页显示时点一下工具栏里的 AnyFilter 图标，再回来判断。chrome:// 之类的浏览器页面完全读不了。',
  'page.error.extractFailed': '这个页面没有读出可用的内容。',
  'page.error.noKey': '请先在设置里填入 API 密钥。',
  'page.error.rateLimited': '服务商正在限制这个密钥的请求，请稍后再试。',
  'page.error.auth': '服务商拒绝了 API 密钥（401/403），请在设置里检查。',
  'page.error.network': '连不上服务商：{detail}',
  'page.error.badResponse': '服务商返回了意外的内容：{detail}',
};
