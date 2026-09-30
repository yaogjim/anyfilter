# Privacy policy

AnyFilter has no servers or telemetry. Normal filtering can send post text to your selected model provider; optional verification capture stores additional page text locally only when you turn it on.

**What leaves your browser.** To judge a post, the extension sends the following to
the provider you picked in Settings, Vercel AI Gateway or TypeSafe. This happens on
X's home timeline, search results, a post's conversation, a user's profile (Posts
tab) and a list timeline, and nowhere else:

- the post's text;
- the author's display name and handle;
- for a quoted post, the quoted text;
- for a reply, the post being answered;
- the rules being asked, which are the questions sent to the model. This includes
  the text of any custom rule you wrote, because that text becomes the question;
- your API key, in the request's authorization header.

The same applies to the text preview, except that it only runs when you click the
test button, and it sends the text and optional author, quote, and parent context
you typed in the test box. Manual **Verify one sample** is separate: after you
inspect the full saved snapshot, enable the USD 1 local verification budget, and confirm
one sample and one rule, it sends that sample's saved author, text, optional quote
and parent context, and the compiled question to TypeSafe Jev 1.13 using your
stored TypeSafe key. This local budget uses the published price and request limit;
it is not a provider-enforced hard spending cap if the provider changes pricing. Enabling the budget alone sends nothing. Each click may be
charged; normal filtering and text preview are not covered by this verification
budget. The resulting score is not an accuracy measurement.

**Judging a web page (manual, one page at a time).** On a page that is not X, the
side panel has a *Judge this page* button. It works only after you click the
extension's toolbar icon on that tab, which is what gives Chrome's `activeTab`
permission for that one tab; it is lost when you switch tabs or the tab goes to
another site. The extension has no standing access to other sites and no content
script on them. When you press the button, a reader script is injected into that one
tab, extracts the article from the page (nothing is fetched from third parties), and
sends the provider you picked in Settings:

- the page title, and the author, site name, publication date, description,
  language and headings when the page declares them, and the article text up to the
  first 2000 words (the page's full word count is sent as a number). The page's
  address is not sent;
- whether the page looks truncated or paywalled;
- the two questions being asked (pure marketing, clickbait) and a readability check;
- your API key, in the request's authorization header.

Pages that are obviously not articles (a sign-in page, a bare home page, a block or
error page, a page of fewer than 200 words) are refused by the extension itself and
send nothing. The page text is used for that one request; it is not stored, cached
or added to any counter. The result the panel shows is "reads like…" with a
probability, not a statement of fact. X pages are refused too: X is read by the feed
filter, post by post. Unless you turn on auto judging (next paragraph), nothing runs in
the background and no page is read unless you click. To keep the panel in step with the
toolbar click, a timestamp of the last click is kept in session storage (gone when the
browser closes); it contains nothing about the page.

**Auto judging (off by default).** In the side panel's *Auto judging* section you can
turn on a switch and allow sites one by one. Allowing a site is a Chrome permission
prompt ("read and change your data on <that site>", requested as an optional host
permission; nothing is granted at install), and you can remove it in the panel or in
Chrome's extension settings. While the switch is on, a page on an allowed site that
finishes loading in the tab in front is read and judged exactly as if you had pressed
*Judge this page*: **the same text goes to the provider you picked, but without a
click.** X, the provider hosts and browser pages are never auto-judged. Pages the
extension refuses locally send nothing. Each tab and address is judged once, and the
same page content in another tab is answered from a cache instead of asking again.
There is a local spending cap of USD 10 (counted from Jev's published input price;
this is not a provider-enforced limit), at most 300 requests a day, requests at least
two seconds apart, and it stops after three failed requests in a row until you press
*Resume*. What is kept: in local storage, the switch, the amount counted, today's
request count and the failure count (no address, no page content); in session storage
(gone when the browser closes), for each open tab the latest verdict together with the
page's address without query string or fragment, and a cache of verdicts keyed by a
SHA-256 hash of the address and the text. No page text is stored anywhere. The toolbar
icon shows *MKT* or *BAIT* on a tab whose page matched a rule. Closing a tab deletes
its stored result, and *Clear data* deletes them all.

**Hacker News (off by default).** In the side panel's *Other sites* card you can turn on Hacker News. That is a Chrome permission prompt for `news.ycombinator.com` (an optional host permission; nothing is granted at install); turning it off gives the access back. While it is on, on Hacker News list pages (front page, newest, ask, show and similar; never an item page or comments) each story title is read and judged against your politics, crypto, NSFW and platitude rules and your own rules. **Sent to the provider you picked: the submitter's username, the title, and the host its link points to. Nothing else: no page text, comments, points or time.** Matching titles are hidden on the page. The panel's hidden list keeps the title, username and link to the discussion, like it does for X posts, and *Clear everything* removes it. The score cache (session storage, gone when the browser closes) holds the story's id, a hash of its title and the scores, not the title itself.

**Real evaluation (opt-in, off by default).** The side panel's *Real evaluation*
section can ask three labellers about your saved verification samples: TypeSafe
Jev 1.13, OpenAI `gpt-6-luna` and DeepSeek `deepseek-flash`. It runs only after you
switch on the local budget, store a key for that provider in the extension
settings, tick the authorization box and press start. Each request carries one
saved sample's author, text, optional quote and parent context and the compiled
question, and nothing from the other labellers. Each provider has its own USD 1
local cap, checked before every request; this cap uses published prices and is
not a provider-enforced limit. Requests use the Chat Completions format. The panel lets you choose the model
(GPT-6 Luna or Sol; DeepSeek Flash) and an `https` base URL for OpenAI and
DeepSeek, for example a relay you trust: **that host then receives your key and
the post text**, and it may bill differently from the published prices the local cap
uses. Only hosts listed in the extension's permissions can be reached. The OpenAI and DeepSeek keys stay in the extension
storage of this browser profile, are never shown again and are never exported.
The exported results file **contains the saved post text**; treat it as private
and save it only where you would keep the posts themselves. Nothing runs in the
background on a schedule.

Outside that section nothing is sent to OpenAI or DeepSeek. What the
providers do with requests is covered by their own policies: [Vercel](https://vercel.com/legal/privacy-policy),
[TypeSafe](https://typesafe.ai), [OpenAI](https://openai.com/policies/privacy-policy), [DeepSeek](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html).

**Scores are probabilities, not accuracy.** The percentage the panel and the
preview show is the model's probability that a post matches the question it was
asked, compared against your filter threshold. It is not an accuracy rate, and it
is not a statement that a post is safe or unsafe. Around 70% is a preference you
set, not a measured error rate.

**What stays on your device.** The following is stored in Chrome's extension
storage on your computer and is never uploaded:

- your API key;
- your settings, your threshold, and your rules, including custom rules;
- the list of hidden posts, the counters, and your "put back in feed" choices;
- cached scores, which are kept in session storage and disappear when the browser
  closes;
- if you enable verification capture, the separate local sample library described
  below;
- if you manually verify a sample, a separate local task record with its sample
  identifier, rule and input fingerprints, model response, token usage and cost.
  This task record does not contain the saved post body or your API key.

Text you type into the preview is used for that one request. It is not saved, and
the preview does not add anything to your hidden-post history or counters.

The optional **Verification samples** control is off by default. When enabled, a separate read-only observer copies already-loaded text from X home, search and post pages into Chrome's local extension storage. A sample includes the author's handle and display name, post text, optional quoted or parent text, a post and thread identifier, the page path without query parameters, and a capture time. Your own posts are skipped when your account handle is known; if the handle cannot be determined, observation waits. Posts without text, over the text limits or matching known protected-content placeholders are skipped. These checks cannot establish that every post is public or safe to share. Verification capture itself makes no provider calls, does not change filtering, and stores at most 300 samples, dropping the oldest when full. Samples expire after seven days and are removed the next time the extension background runs or processes a capture change; closing the browser may delay physical deletion until it starts again. This initial local library is a convenience sample, **not** a random or human-labelled evaluation set and cannot establish an accuracy rate. Turning it off or pausing stops new observations; use **Delete samples** in the panel to remove its records. Existing posts may already have been sent to your selected provider by normal filtering while the filter was on.

**What we see.** Nothing. There is no analytics, no telemetry, no account.

**Deleting your data.** Settings → Data → Clear everything removes hidden posts,
counters, your "put back in feed" choices, and cached scores. It does not remove
your rules, your threshold, your filter switch, your API key, or verification samples.
Use **Delete samples** in the side panel to remove the separate verification library;
this does not delete rules, your key or normal filtering history. The separate
verification task ledger still retains non-body identifiers, model results,
recorded spend and any unresolved fee reservations after sample deletion, so
**Delete samples** is not a complete deletion of verification metadata. Already
sent requests cannot be withdrawn from a provider. Uninstalling the extension
removes everything, including the key.

**Changes.** This file is the policy. Its history is in the repository. Rule
behavior is documented separately in [docs/filter-rules.md](docs/filter-rules.md).