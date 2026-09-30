# AnyFilter

Chrome extension that uses [Jev](https://typesafe.ai) to hide anything you don't want to see on any site, from ads and spam to whatever you describe in a sentence. X for now, more sites in the works.

https://github.com/user-attachments/assets/4cfa42c1-00e8-46d5-ba18-07cb912e9dbd

## Install

1. Download `anyfilter-<version>-chrome.zip` from [Releases](../../releases) and unzip it.
2. Open `chrome://extensions`, turn on Developer mode, click "Load unpacked" and pick the unzipped folder.
3. Go to x.com and click the toolbar icon. The panel docks on the right.

To build it yourself: `pnpm install && pnpm build`, then load `.output/chrome-mv3`.

## Using it

1. Click **Settings** at the bottom of the panel to open the settings tab, then paste a Jev key from [Vercel AI Gateway](https://vercel.com/ai-gateway/models/jev) or [TypeSafe](https://console.typesafe.ai). It is stored locally and sent only to your selected provider as an authorization header when filtering or testing text.
2. Ten rules ship enabled: ads, engagement bait, promo, platitudes, hate and insults, politics, NSFW, porn bots, spam replies, and crypto shilling. All ten are on by default because that is the preference, not because every one has been accuracy-verified. Ads are decided locally from the page; the other nine are asked to Jev.
3. Open "Manage rules" to read what each rule means, edit its condition, add your own examples, or add a custom rule. "Test a text" runs one pasted post through the same rules and the same Jev path and shows each rule's probability against its threshold, without saving anything or touching the page.
4. Scroll. Hidden posts show up in the panel grouped by reason; click "Put back in feed" if Jev got one wrong.
5. Optional: the side panel's **Verification samples** section can locally copy already-loaded X post text for later review. It is off by default, capped at 300 samples, and can be paused or deleted separately from filtering history. This preliminary collection does not call a model and cannot measure accuracy. See [PRIVACY.md](PRIVACY.md) before enabling it.

Where it works: the X home timeline, search results, a post's conversation, a user's profile (the Posts tab, `x.com/<handle>`) and a list (`x.com/i/lists/<id>`). Replies, Media and Likes tabs are left alone. Verification samples are still only collected on home, search and post pages, never on profiles or lists.

Any other web page: click the toolbar icon on the page, then press **Judge this page** in the panel. It reads that one page once, on demand, and shows whether it reads like pure marketing or clickbait, with the probability and the threshold each rule uses. The page text is not stored. Optionally, turn on **Auto judging** in the same panel and allow sites one by one: pages on allowed sites are then judged when they finish loading in the front tab, and a match shows MKT or BAIT on the toolbar icon. It is off by default, has a USD 10 spending cap and a daily limit, and sends the same text as the button ([docs/auto-mode.md](docs/auto-mode.md)). The two rules are new and their thresholds (marketing 40%, clickbait 50%) were fitted on a small set of pages labelled by us; treat a result as a hint. What is sent is listed in [PRIVACY.md](PRIVACY.md); the rules and the evidence behind them are in [docs/article-rules.md](docs/article-rules.md).

Text only: rules read the post text, the author's name and handle, and quoted or parent text. Images and video are not analyzed. The percentage shown is a model probability compared with your threshold, not an accuracy rate. The full per-rule specification, including what each rule must not match and where it stops, is in [docs/filter-rules.md](docs/filter-rules.md).

<p>
  <img src="screenshots/panel.png" width="360" alt="Side panel: stats and hidden posts grouped by reason">
  <img src="screenshots/settings.png" width="360" alt="Settings tab: provider, threshold, rules and data">
</p>

## Development

```bash
pnpm dev          # dev server with the extension loaded
pnpm typecheck
pnpm test:unit    # offline unit tests
pnpm eval:rules   # offline rule-evaluation report
pnpm e2e          # offline end-to-end run against static fixtures
pnpm e2e:page     # real headed Chrome: toolbar click, side panel, "Judge this page"
```

`pnpm test:unit` runs `scripts/test/*.test.mjs` with Node's built-in test runner and no extra dependencies. It imports the extension's TypeScript sources directly through Node's type stripping, which `scripts/ts-loader.mjs` extends to cover the project's extensionless relative imports. Node 22.6 or newer is required; on an older Node the runner prints a skip notice instead of failing.

`pnpm eval:rules` prints per-rule precision, recall, false-hide, missed-hide and undecided rates with 95% confidence intervals. It is **fully offline** and uses a small hand-labelled fixture set with a deliberately toy keyword scorer. Its numbers say nothing about Jev's quality and are not a promise of accuracy. A real evaluation is only ever run by hand with explicit authorization and a budget — `pnpm eval:rules --remote` refuses to run automatically and prints the manual procedure. Continuous integration never makes a billable call.

### Real quality evaluation (by hand, opt-in)

The side panel's **Real evaluation** section runs Jev, OpenAI `gpt-6-luna` and DeepSeek `deepseek-flash` over your saved verification samples. Each provider has its own USD 1 local cap, checked before every request; keys are typed into the panel and never shown or exported. Nothing runs on a schedule, and CI never makes a billable call.

1. Turn the budget on, add keys, authorize a run per labeller, then **Export results** (the file contains post text: keep it private).
2. `pnpm eval:import <export.json>` writes the blind-review inputs under `tmp/`: a random holdout batch first, then the disputed batch (samples the labellers disagree on). No machine answer reaches the review page.
3. `pnpm review:blind prepare`, label in the browser, then `pnpm review:blind apply <submission.json>`. Labels made in the on-page review mode are only hints.
4. `pnpm eval:report <export.json>` scores each labeller against the human labels only, per rule, source and split, and lists rule-change suggestions from the dev split. Suggestions are never applied automatically.
5. Labels made in the timeline (review mode) can be saved from the side panel with "Export review labels". `pnpm review:report <file.json>` compares them with what the live filter decided, per post and per rule. They were made with the model's verdict on screen, so they point at posts worth a second look; they are not an answer key.
6. `pnpm rule:replay --labels <file.json> --pack <rule-pack.json>` replays a candidate rule pack against those labels and reports pass, fail or not enough data; `pnpm rule:apply --pack <rule-pack.json> --yes` puts it into the running extension (and `--rollback` puts the old rules back). See `docs/improvement-loop.md`.

`pnpm e2e` loads the built extension into Chromium, serves fake X pages from `scripts/fixtures/` and mocks Jev. It intercepts every request, so it too never contacts a provider or spends tokens. It needs a Chromium build that can load an unpacked MV3 extension with its service worker; where that is unavailable it prints an explicit `SKIP` and exits 0 rather than hanging. If playwright-core can't find a browser, point it at one with `ANYFILTER_CHROMIUM=/path/to/chrome`.

Layout:

```
src/domain/          types, categories, rules, compiler, verdicts, settings, ports
src/features/        feed-filter: scan, classify, hide
src/infrastructure/  Chrome storage, Jev adapters, X DOM reading and hiding
src/ui/sidepanel/    React side panel, rule manager and text preview
src/entrypoints/     content, background, sidepanel, options
scripts/             offline tests, evaluation report, e2e harness
```

To support another site, implement `domain/timeline-view.ts` for it and add its URL to the content script. Manual "Judge this page" on general web pages is implemented (stage 2, v1); automatic judging and more sites are still plans, in [docs/multi-site-design.md](docs/multi-site-design.md).

## License

MIT