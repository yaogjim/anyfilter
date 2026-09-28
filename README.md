# AnyFilter

Chrome extension that uses [Jev](https://typesafe.ai) to hide anything you don't want to see on any site, from ads and spam to whatever you describe in a sentence. X for now, more sites in the works.

https://github.com/user-attachments/assets/4cfa42c1-00e8-46d5-ba18-07cb912e9dbd

## Install

1. Download `anyfilter-<version>-chrome.zip` from [Releases](../../releases) and unzip it.
2. Open `chrome://extensions`, turn on Developer mode, click "Load unpacked" and pick the unzipped folder.
3. Go to x.com and click the toolbar icon. The panel docks on the right.

To build it yourself: `pnpm install && pnpm build`, then load `.output/chrome-mv3`.

## Using it

1. Click **Settings** at the bottom of the panel to open the settings tab, then paste a Jev key from [Vercel AI Gateway](https://vercel.com/ai-gateway/models/jev) or [TypeSafe](https://console.typesafe.ai). It never leaves your browser.
2. Ten rules ship enabled: ads, engagement bait, promo, platitudes, hate and insults, politics, NSFW, porn bots, spam replies, and crypto shilling. All ten are on by default because that is the preference, not because every one has been accuracy-verified. Ads are decided locally from the page; the other nine are asked to Jev.
3. Open "Manage rules" to read what each rule means, edit its condition, add your own examples, or add a custom rule. "Test a text" runs one pasted post through the same rules and the same Jev path and shows each rule's probability against its threshold, without saving anything or touching the page.
4. Scroll. Hidden posts show up in the panel grouped by reason; click "Put back in feed" if Jev got one wrong.

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
```

`pnpm test:unit` runs `scripts/test/*.test.mjs` with Node's built-in test runner and no extra dependencies. It imports the extension's TypeScript sources directly through Node's type stripping, which `scripts/ts-loader.mjs` extends to cover the project's extensionless relative imports. Node 22.6 or newer is required; on an older Node the runner prints a skip notice instead of failing.

`pnpm eval:rules` prints per-rule precision, recall, false-hide, missed-hide and undecided rates with 95% confidence intervals. It is **fully offline** and uses a small hand-labelled fixture set with a deliberately toy keyword scorer. Its numbers say nothing about Jev's quality and are not a promise of accuracy. A real evaluation is only ever run by hand with explicit authorization and a budget — `pnpm eval:rules --remote` refuses to run automatically and prints the manual procedure. Continuous integration never makes a billable call.

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

To support another site, implement `domain/timeline-view.ts` for it and add its URL to the content script.

## License

MIT