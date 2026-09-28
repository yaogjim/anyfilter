# Filter rules

This document is the specification for the ten built-in filters: what each one
means, when it matches, when it must not, which inputs it may read, and where it
stops. It describes the rules as they currently behave. Where a rule is known to
be imprecise, that is stated instead of being presented as finished work.

The code is the source of truth for the exact wording. This file explains intent
and boundaries so the wording can be reviewed without reverse-engineering it.

- Rule definitions and validation: `src/domain/rule.ts`
- The ten built-in definitions: `src/domain/category.ts`
- Instruction compiler: `src/domain/rule-compiler.ts`
- Matching and reasons: `src/domain/verdict.ts`
- Editor UI: `src/ui/sidepanel/RuleEditor.tsx`, `RuleManager.tsx`
- Preview UI: `src/ui/sidepanel/RulePreview.tsx`

## 1. What a rule is

Each rule is one object:

| Field | Meaning |
| --- | --- |
| `id` | Stable identifier. Built-in ids are fixed; custom ids are generated once at creation. |
| `label` | The name shown in the panel and used to group hidden posts. |
| `source` | `builtin` or `custom`. Both use the same editor. |
| `kind` | `local` (decided from page signals) or `semantic` (asked to the provider). |
| `enabled` | Turned on or off. All ten built-ins ship enabled. |
| `include` | The condition. For semantic rules this is the first line of the instruction sent to Jev. |
| `exclude` | Optional "answer no if" condition, appended to the instruction. |
| `examplesYes` / `examplesNo` | Up to 5 short examples each, appended to the instruction. |
| `scope` | `all` posts, or `replies` only (requires parent-post context). |
| `threshold` | Optional per-rule override of the global threshold. |

There is **one current set of rules**. Editing produces a draft; clicking
"Save and apply" writes it. There is deliberately no rule history, no version
comparison, no rollback, and no import/export. Cancel discards the draft.

The panel shows the **exact instruction** sent to the provider, built by the same
compiler the feed uses, so the visible text and the sent text cannot drift apart.

### Semantic vs local

- **Semantic rules** (9 of 10) are compiled into one question per rule and sent
  to the provider together with the post text.
- **Local rules** (`ads`) are decided entirely in the browser from a promoted
  marker in the page. They are never sent anywhere, never need a key, and have no
  prompt, examples or threshold to edit. Only on/off is editable.

### Model probability is not accuracy

Scores returned by the provider are a probability between 0 and 1 that the post
matches the question that was asked. The panel shows them as percentages labeled
"probability" next to the "threshold", for example `82% vs 70%`. They are **not**
an accuracy or correctness rate, and they are not model reasoning. Explanations
come from the matched rule and its score.

### What triggers re-scoring

A compiled fingerprint covers the exact question map. Renaming a rule or changing
only its threshold does **not** change the fingerprint, so cached scores are
reused and no new request is sent. Changing `include`, `exclude`, examples,
enabling/disabling, or the rule set does change it, and affected posts are scored
again.

Only fully answered responses are cached. A response missing any answer is retried
rather than stored, and a missing or out-of-range answer is reported as
"not judged", never as a confident zero.

## 2. Shared capability boundaries

These apply to every semantic rule:

- **Text only.** Only text that is already available is judged: the post text,
  the author's display name and handle, quoted text, and, for replies, the parent
  post. Images and video are not analyzed. A rule that says "adult text" does not
  see a picture.
- **No identity inference.** The extension does not decide whether an account is
  really a bot, does not read account history, follower counts, or verification
  state, and does not fetch anything outside the post.
- **No silent safety claim.** A rule not matching means "this question was not
  answered above the threshold", not "this content is safe". Short text, missing
  parent context, and truncation are treated as insufficient input, not as a pass.
- **Overlap is expected.** A post can match several rules. Each rule is judged
  independently, and an exception in one rule only affects that rule. One hidden
  post is counted once, no matter how many rules matched it.
- **Not all rules are verified.** All ten are on by default because that is the
  user's stated preference, not because accuracy has been established. Only the
  offline evaluation harness exists today; see section 4. Until a real evaluation
  is run with authorization, every rule is reported as **evidence missing**.

### Global behavior around the rules

- The master filter switch is separate from the individual rules. Turning the
  filter off shows every hidden post without changing which rules are enabled.
- The signed-in user's own posts and replies are never hidden.
- "Put back in feed" restores a single post and persists across page loads. It is
  a user choice, separate from whether a rule matched.
- Posts in the same thread module are hidden and shown together.
- Hidden posts are grouped by reason, capped, and counted per post.

## 3. The ten rules

Status for every rule below is **evidence missing**: no authorized evaluation
against the live model has been run. The "matches / does not match" text describes
intended behavior, not measured accuracy.

### 1. Ads — `ads` (local)

- **Definition.** A post the page itself marks as a promoted advertisement.
- **Matches.** The post carries the platform's promoted marker.
- **Does not match.** Anything without that marker, including organic posts that
  merely praise a product.
- **Inputs.** Page signals only.
- **Limits.** It cannot confirm an ad from text, so it is not part of the text
  preview and the preview reports it as not applicable. Detection depends on the
  site's marker remaining readable; if the marker disappears, this rule stops
  matching. There is no CSS or script customization.

### 2. Engagement bait — `bait` (semantic)

- **Definition.** A post whose primary purpose is to farm replies, follows, likes,
  comments, a keyword, or self-introductions.
- **Matches.** Explicit calls to reply with a word or emoji, "comment X and I will
  follow", introduction threads, follow-for-follow framing.
- **Does not match.** A genuine request for help, a relevant survey, or an
  on-topic discussion question with substance.
- **Inputs.** Post text; parent text for replies.
- **Limits.** Short posts that ask a real question and posts that ask a question
  as part of a substantive argument are the hard cases.

### 3. Promo / selling — `promo` (semantic)

- **Definition.** Selling or advertising a product, course, template, service, or
  newsletter.
- **Matches.** Direct offers, discount codes, launch announcements, "link in bio"
  pointing at something for sale, free lead-generation funnels.
- **Does not match.** Independent reviews, bug reports and troubleshooting, and
  posts that quote an ad in order to criticize it.
- **Inputs.** Post text; quoted text; parent text for replies.
- **Limits.** The line between a genuine recommendation and undisclosed promotion
  is not always visible in the text.

### 4. Platitudes — `platitude` (semantic)

- **Definition.** A generic motivational or self-evident statement that carries no
  specific information.
- **Matches.** Vague encouragement, universal truths, slogan-like advice.
- **Does not match.** Concrete experience or numbers, and ordinary consolation in
  a real conversation.
- **Inputs.** Post text.
- **Limits.** Length is deliberately not a criterion. A short post can be
  specific, and a long post can be empty. Distinguishing a platitude from a
  sincere but unremarkable reply is the main failure mode.

### 5. Hate & insults — `hate` (semantic)

- **Definition.** Hateful, abusive, or insulting content aimed at people: hate
  speech, slurs, dehumanizing language, personal attacks, name-calling, profanity
  aimed at a person, and crude sexual harassment.
- **Matches.** Attacks on a person or group, slurs, dehumanizing comparisons,
  harassment.
- **Does not match.** Criticism of an idea, reporting that quotes abusive language,
  and posts that quote a slur in order to condemn it.
- **Inputs.** Post text; quoted text; parent text for replies.
- **Limits.** Quotation and condemnation versus use is a genuine ambiguity, and
  the rule works in any language, where slurs are hard to enumerate completely.

### 6. Politics — `politics` (semantic)

- **Definition.** A post whose main subject is politics: governments, parties,
  politicians, elections, political ideology, nationalism, geopolitics, or
  political outrage and culture-war argument.
- **Matches.** Political news and commentary, including neutral reporting and
  reasoned discussion, when politics is the topic.
- **Does not match.** A passing or incidental mention, or a post whose subject is
  something else.
- **Inputs.** Post text; quoted text; parent text for replies.
- **Limits.** This is intentionally broad: filtering politics hides political
  discussion you might agree with, including neutral news. The rule targets the
  topic, not the viewpoint, and it does not attempt to judge whether a claim is
  true or whether the tone is extreme.

### 7. NSFW — `nsfw` (semantic)

- **Definition.** Sexually explicit or pornographic writing, sexual acts described
  in text, links to adult content, and gore, in any language.
- **Matches.** Explicit sexual description, nudity described in text, adult-content
  links, graphic gore.
- **Does not match.** Medical, educational, and journalistic text that mentions
  anatomy or reports an event without graphic description.
- **Inputs.** Post text; quoted text; parent text for replies.
- **Limits.** Text only. A post with an explicit image and a bland caption will not
  match, because no media is examined. The medical/educational/news boundary is a
  known hard case.

### 8. Porn bots — `porn` (semantic)

- **Definition.** Sexual or pornographic spam and adult-content lures: solicitation,
  adult bait, emoji-obfuscated innuendo, and slang inviting people to view adult
  content.
- **Matches.** Solicitation lines and their obfuscated variants, including the
  multilingual patterns listed in the rule text (English, Chinese, Japanese,
  Korean, Spanish, Portuguese, French, German, Russian, Arabic, Thai, Vietnamese).
- **Does not match.** A post that quotes the same lines to warn about, mock, or
  complain about bots.
- **Inputs.** Post text; quoted text; parent text for replies.
- **Limits.** It does **not** assert that the account is a bot — only that the text
  reads like this spam. A single "DM me" or "check my profile" is not enough on its
  own; adult solicitation context is required. Quotation versus use is a real
  ambiguity, and no language list is complete.

### 9. Spam / bot replies — `spam` (semantic)

- **Definition.** Automated or off-topic spam replies: link pushing, follow-me or
  DM-me bait, canned or copy-pasted text, and replies unrelated to what they answer.
- **Matches.** Follow-back and DM bait, canned promotional replies, replies with no
  relation to the post they answer.
- **Does not match.** A genuine request to verify a number or a claim, and an
  ordinary disagreeing reply with substance.
- **Inputs.** Post text; parent text for replies. Off-topic judgement depends on the
  parent, so when the parent is missing those replies are treated as insufficient
  input rather than as spam.
- **Limits.** A short reply that only asks for a DM or a follow-back does count.
  The current prompt still lists "asking an AI to verify" as an example of an
  automated pattern. That is a rough condition, is recognized as a false positive
  risk against genuine verification requests, and is scheduled for revision; the
  text here will be updated when the wording is changed.

### 10. Crypto shilling — `crypto` (semantic)

- **Definition.** Promoting a cryptocurrency, token, presale, airdrop, or trading
  signal.
- **Matches.** Hype, presale and airdrop promotion, unsolicited trading calls.
- **Does not match.** Neutral technical or market analysis, risk warnings, and
  posts warning that a project is a scam.
- **Inputs.** Post text; quoted text; parent text for replies.
- **Limits.** Hype and analysis share vocabulary. A warning and a promotion can
  look similar to a keyword-level reading.

## 4. Previewing and evaluating

### Text preview

The preview in Settings runs the **same compiler** and the **same provider path**
as the feed. Only clicking the test button sends anything. A preview:

- sends the post text, plus the author name and handle, quoted text, and parent
  text when you fill them in — nothing else;
- shows each rule's probability, threshold, and one of match / below threshold /
  no score / not applicable;
- gives the local `ads` rule and any `replies`-scope rule without a parent as
  "not applicable";
- reports the provider, the model identifier the API returned, elapsed usage, and
  an estimated token cost;
- **writes nothing**: no panel state, no hidden-post history, no "put back"
  choice, no score cache, and no DOM change. Preview usage is not added to the
  timeline counters;
- marks an existing result as stale as soon as the draft changes, so a late
  response cannot label new rules.

The post text you test is not saved.

### Offline evaluation report

```
node scripts/eval-rules.mjs          # offline, deterministic, no network
node scripts/eval-rules.mjs --json   # same numbers as JSON
```

This is a **development report, not a claim about model quality**. It scores a few
dozen hand-labelled fixtures with an explicitly illustrative keyword scorer. Its
only purpose is to keep the metric plumbing (per-rule precision, recall,
false-hide, missed-hide, undecided rate, Wilson 95% intervals, micro-average)
working and reviewable. The fixture count is far too small for the intervals to
mean anything, and the scorer is not the model.

### Real evaluation is manual and gated

There is no automated path to a live provider. `--remote` refuses to run and
prints the manual procedure instead:

```
node scripts/eval-rules.mjs --remote     # exits 2, sends nothing
```

A real evaluation is only ever run by a person, with explicit authorization,
a named provider, a licensed sample set, a hard request and token budget, and the
actual model alias recorded. Until that has happened, no rule may be described as
verified. Continuous integration never makes a billable call.

The candidate targets of at least 95% precision and 90% recall per rule are goals
to be measured, not promised results.

## 5. Compatibility with existing settings

- A new install keeps all ten rules enabled.
- Existing settings are migrated once, preserving the filter switch, the
  threshold, the provider, both API keys, which built-ins were disabled, and every
  custom rule.
- A migrated custom rule keeps its **exact original instruction text**, so its
  behavior does not silently change on upgrade. Legacy custom rules had only a
  name; that name still produces the same question it did before.
- Built-in rule text is preserved verbatim on migration, including the deliberately
  broad politics wording and the multilingual bot examples.
- User edits win over built-in defaults. Nothing the user changed is overwritten by
  an upgrade without an explicit save.
- Clearing filter data removes hidden posts, counters, and cached scores. It does
  **not** remove the rules, the switch, the threshold, or the keys.

### Known limitations

- Label reuse when deriving a custom rule id matches exactly, so a case-only
  rename of a legacy custom rule produces a new id rather than reusing the old one.
- Custom rule ids are hashed from the label. Two labels that differ only by case
  share a base id and the second gets a `-2` suffix.
- The `spam` prompt's "asking an AI to verify" condition is still present and is
  pending revision, as noted above.