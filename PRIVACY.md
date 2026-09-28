# Privacy policy

AnyFilter has no servers and collects nothing.

**What leaves your browser.** To judge a post, the extension sends the following to
the provider you picked in Settings, Vercel AI Gateway or TypeSafe:

- the post's text;
- the author's display name and handle;
- for a quoted post, the quoted text;
- for a reply, the post being answered;
- the rules being asked, which are the questions sent to the model. This includes
  the text of any custom rule you wrote, because that text becomes the question;
- your API key, in the request's authorization header.

The same applies to the text preview, except that it only runs when you click the
test button, and it sends the text and optional author, quote, and parent context
you typed in the test box.

Nothing else is sent anywhere. What the providers do with requests is covered by
their own policies: [Vercel](https://vercel.com/legal/privacy-policy),
[TypeSafe](https://typesafe.ai).

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
  closes.

Text you type into the preview is used for that one request. It is not saved, and
the preview does not add anything to your hidden-post history or counters.

**What we see.** Nothing. There is no analytics, no telemetry, no account.

**Deleting your data.** Settings → Data → Clear everything removes hidden posts,
counters, your "put back in feed" choices, and cached scores. It does not remove
your rules, your threshold, your filter switch, or your API key. Uninstalling the
extension removes everything, including the key.

**Changes.** This file is the policy. Its history is in the repository. Rule
behavior is documented separately in [docs/filter-rules.md](docs/filter-rules.md).