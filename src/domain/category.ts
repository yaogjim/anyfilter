export interface Category {
  id: string;
  label: string;
  question?: string;
  /** Default "answer no if" guidance shipped with a built-in rule. Appended to
   * the compiled instruction after the condition. */
  exclude?: string;
  /** Short positive examples shipped with a built-in rule (at most 5). */
  examplesYes?: readonly string[];
  /** Short negative examples shipped with a built-in rule (at most 5). */
  examplesNo?: readonly string[];
  rule?: 'promoted';
  custom?: boolean;
}

export const BUILT_IN_CATEGORIES: readonly Category[] = [
  { id: 'ads', label: 'Ads', rule: 'promoted' },
  {
    id: 'bait',
    label: 'Engagement bait',
    question:
      'Is this post engagement bait — primarily asking people to reply, follow, like, comment a keyword, or introduce themselves in order to farm interactions, rather than because the answer matters?',
    exclude:
      'the post asks a genuine question to solve a real problem, wants practical help, or surveys people on a substantive topic, and does not push a follow, a keyword reply, or a follow-for-follow exchange',
    examplesYes: [
      'Comment "GUIDE" and I will DM you the checklist',
      "Drop a 🙋 if you read this far — let's grow together",
      'Introduce yourself in the replies so we can all connect',
    ],
    examplesNo: [
      'How do I fix a broken Docker build on Apple Silicon?',
      'Which text editor do you actually use day to day, and why?',
      'Anyone else seeing 500s from the API since this morning?',
    ],
  },
  {
    id: 'promo',
    label: 'Promo / selling',
    question:
      "Is this post a promotion — selling or advertising a product, course, template, service, or newsletter, or funneling people to the author's own paid offer?",
    exclude:
      "the post is an independent review, a build log, a bug report, or troubleshooting, and does not sell or link to the author's own paid offer",
    examplesYes: [
      'My course is 40% off this week — link in bio',
      'I built a template for this; grab it for $19',
      'Our newsletter just launched, subscribe for free',
    ],
    examplesNo: [
      'I used this library for a month; here is what broke and what worked',
      'The checkout button is misaligned on iOS 17 — filed a bug',
      'Full teardown of the new laptop, including the parts they cheaped out on',
    ],
  },
  {
    id: 'platitude',
    label: 'Platitudes',
    question:
      'Is this post a platitude — a generic motivational or self-evident statement that carries no specific information, experience, or claim?',
    exclude:
      'the post gives concrete details such as numbers, names, a specific event, or a real question, even if it is short or encouraging',
    examplesYes: [
      'Discipline beats motivation. Keep going.',
      'Success is a journey, not a destination.',
      'Be kind. You never know what someone is going through.',
    ],
    examplesNo: [
      'We shipped 12 releases this quarter and cut build time from 9m to 90s',
      'Sorry your migration failed — send me the error and I will take a look',
      'Learned the hard way why you never run migrations on Friday',
    ],
  },
  {
    id: 'hate',
    label: 'Hate & insults',
    question:
      'Is this post hateful, abusive, or insulting toward people — hate speech, slurs, dehumanizing language, personal attacks, name-calling, profanity aimed at a person, or crude sexual harassment, in any language?',
    exclude:
      'the post criticizes an idea, policy, company, or belief rather than a person or group, or quotes abusive language in order to report, condemn, or mock it',
    examplesYes: [
      'These people are vermin and should be deported',
      'You are a pathetic loser and everyone here knows it',
      'Nobody wants your kind here — go back where you came from',
    ],
    examplesNo: [
      'This bill is a disaster and the minister should resign',
      'The article quotes the slur to argue that the ban should be enforced',
      'The API design is genuinely hostile to new contributors',
    ],
  },
  {
    id: 'politics',
    label: 'Politics',
    question:
      'Is this post mainly about politics — governments, parties, politicians, elections, political ideology, nationalism, geopolitics, or political outrage and culture-war arguments, in any language?',
    exclude:
      "politics is only an incidental mention and the post's actual subject is something else, such as sports, a product, or a personal story",
    examplesYes: [
      'Parliament votes on the budget tonight — here is what the bill changes',
      'Turnout hit a 20-year low, the electoral commission said',
      'City council approved the new zoning rules 6-3',
    ],
    examplesNo: [
      'My new laptop arrived; customs held it for a week',
      'Trail running clears my head better than any debate',
      'The team lost the final but the city still had a great weekend',
    ],
  },
  {
    id: 'nsfw',
    label: 'NSFW',
    question:
      'Is this post NSFW — sexually explicit or pornographic text, nudity, sexual acts described in text, links to adult content, or graphic gore, in any language?',
    exclude:
      'the text is medical, scientific, educational, or journalistic and mentions anatomy, sex, or violence clinically, without graphic or arousing detail',
    examplesYes: [
      'Full nude set is up, link in the comments 🔞',
      'Step-by-step recap of what we did in bed last night',
      'This clip shows the crash — you can see the injuries in detail',
    ],
    examplesNo: [
      'Anatomy exam study guide: how to remember the cranial nerves',
      'Police report: two people were hospitalized after the collision',
      'Sex education for teens should cover consent, not just biology',
    ],
  },
  {
    id: 'porn',
    label: 'Porn bots',
    question:
      'Does this text solicit sexual or adult-content engagement, using explicit offers, suggestive invitations, or an adult-content profile/link? Judge the visible wording and context, not whether the account is really a bot. Generic greetings, an ordinary DM request, and a profile link alone are insufficient. Multilingual slang and emoji can provide context when paired with a sexual solicitation: English "my OF is free", "I\'m 19 dm me"; Chinese 比我好看的没我骚, 比我骚的没我好看, 我福不黑不信你看, 有人想锐评一下我的福嘛; Japanese 裏垢, 裏アカ女子, セフレ, オフパコ, 見せ合い, P活; Korean 조건만남, #조건 #ㅈㄱ; Spanish "mira mi perfil"; Portuguese "conteúdo +18"; French "coucou 🥵"; German "schreib mir direkt ❤️"; Russian интим, хочешь в лс?; Arabic خاص, للتواصل; Thai แอดไลน์, เจอจ่าย; Vietnamese kết bạn zalo, tìm gái xinh hẹn hò.',
    exclude:
      'the post quotes or discusses these lines to warn about, mock, or complain about bots rather than soliciting, or it is an ordinary profile or link share with no sexual or adult-content framing',
    examplesYes: [
      'New 🔞 set on my page, DM me for the link',
      'New 🔞 set on my page, check bio',
      '23F selling adult photos tonight, no strings attached',
    ],
    examplesNo: [
      'Reminder: those "check my profile 🔞" replies are bots — block and report',
      'Hi, can I DM you the error log about the bug?',
      'My portfolio is live — link in bio, all backend work',
    ],
  },
  {
    id: 'spam',
    label: 'Spam / bot replies',
    question:
      'Is this reply visibly spammy — an unsolicited promotion, repeated canned solicitation, or unrelated link/follow-me bait? Judge the visible text and, when present, the parent post; do not claim the author is a bot. A legitimate DM request, disagreement, or brief relevant answer is insufficient. Off-topic can only be judged when the parent post is available. Typical lines: "follow me back", "let\'s grow together", "DM me", "join my telegram"; 繋がりましょう, フォロバ, DMください; 맞팔해요, 디엠 확인, 디엠 보내줘; "mándame dm", "te sigo", "sígueme"; "segue de volta", "me chama na dm"; ممكن خاص, راسلني, تابعني; напиши в лс, глянь лс, подпишись; takipleşelim, dm at, yaz bana; follback dong, dm aku; "DM karo", "follow back karo"; ทักมา, ทักไลน์, ฟอลแบค; inbox em, follow mình; "je peux te dm?", "mp moi", "suis-moi"; "schreib mir", "folge mir zurück".',
    exclude:
      'the reply engages with the post it answers and says something of its own, even briefly, without only pushing a follow, a DM, a link, or unrelated copy-pasted text',
    examplesYes: [
      "Great post! Follow me back and let's grow together 🚀",
      'DM me for a free audit of your account',
      'Check my profile for the real answer',
    ],
    examplesNo: [
      'I hit the same bug; upgrading to 2.1.3 fixed it for me',
      'Sources? The latency claim contradicts the benchmark in the parent post',
      'I disagree — the parent post misreads what the RFC says',
      'Can I DM you the stack trace so we can debug this together?',
    ],
  },
  {
    id: 'crypto',
    label: 'Crypto shilling',
    question:
      'Is this post shilling a cryptocurrency, token, presale, airdrop, NFT, or trading signal — hyping an entry, a price target, or a referral — rather than analyzing it?',
    exclude:
      'the post analyzes a market or technology neutrally, warns about risk, or reports that a project is a scam, and does not push a buy, a referral, or a specific unsolicited call',
    examplesYes: [
      '$MOON is about to 100x, get in before the listing 🚀',
      'Airdrop is live — connect your wallet with my referral link',
      'My signals group called the last three pumps, join free',
    ],
    examplesNo: [
      "Risk review: this token's liquidity sits in one unverified wallet — treat it as high risk",
      'How zk-rollups actually work, with no price talk',
      'This presale looks like a scam; here is the on-chain evidence',
    ],
  },
];

export function customCategory(label: string, index: number): Category {
  return {
    id: `custom:${index}`,
    label,
    question: `Should this post be filtered out under the user's rule "${label}"? Answer yes if the post matches what the rule describes.`,
    custom: true,
  };
}

export function allCategories(custom: readonly string[]): Category[] {
  return [...BUILT_IN_CATEGORIES, ...custom.map(customCategory)];
}

export function isEnabled(category: Category, enabled: ReadonlySet<string>): boolean {
  return category.custom === true || enabled.has(category.id);
}

export function questionsFor(
  categories: readonly Category[],
  enabled: ReadonlySet<string>,
): Record<string, string> {
  const questions: Record<string, string> = {};
  for (const category of categories) {
    if (category.question && isEnabled(category, enabled)) {
      questions[category.id] = category.question;
    }
  }
  return questions;
}

export function questionsKey(questions: Record<string, string>): string {
  const canonical = JSON.stringify(
    Object.entries(questions).sort(([a], [b]) => a.localeCompare(b)),
  );
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}