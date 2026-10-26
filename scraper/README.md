# Bazaar Price Board scraper worker (v1, staging)

## What it is
A Playwright (headless Chromium) worker that visits the five shops' public
pages, extracts prices only from structured data on the page (JSON-LD
product offers, `data-price` attributes, Agora's known `allProduct` markup),
maps them to the board's DEALS variant keys, and writes `data/prices.json`
in the same shape `/api/live` returns.

## Rules
- Public pages only. No login, no cart, no checkout, ever.
- Never guess a price. A shop that yields no structured price data is
  marked `ok:false` and its previous entry from `data/prices.json` is kept,
  with its original `checkedAt`, so the board shows an honest old timestamp.
- Scope v1: the 9 core variants (miniket-loose-kg, miniket-5kg,
  nazirshail-5kg, moshur-dal-kg, soybean-5L/1L/2L, sugar-1kg, salt-1kg) for
  every shop, plus unimart-rice-5kg for Unimart. Atta, tea, milk and other
  cached variants stay on the cached scan until their mapping is added.
- Unimart rows carry tag "Gulshan-2 only". The Unimart area gate is
  attempted (click a Gulshan-2 control if one appears); if it cannot be
  passed, Unimart is marked failed and its previous entry is kept.

## Run locally
```
cd scraper
npm install
npx playwright install chromium
node scrape.js
```
Output: `../data/prices.json`. Exit 0 when a file was written (even if some
shops failed); exit 1 only when the file could not be written.

## Run on GitHub Actions
`.github/workflows/scrape.yml` runs it every 30 minutes and commits
`data/prices.json` when it changed.

## The one remaining manual step
This workflow needs a GitHub repository for the board. The connector cannot
create repositories, so the repo must be created in the user's signed-in
browser and the board files (index.html, api/, data/, scraper/, .github/)
pushed there. Until that exists, the workflow cannot run; run the scraper
locally instead.

## How scraper output reaches the live board
Committing `data/prices.json` does not by itself update the board, because
the Vercel board is deployed through `deploy.py`, not from git. After the
scraper has produced a file, deploy with `data/prices.json` added to the
FILES list in `deploy.py` (see DEPLOY-NOTES.md); `/api/live` then merges
those shops into its response, and the patched board applies them per shop.
