# VetrinaDM

Unofficial, mobile-first browser for Duel Masters cards (fan project, non-commercial).
Vanilla HTML/CSS/JS with no build step, in the spirit of VetrinaMTG. Installable as a PWA.

## Features
- ~12,000 cards from every set on the Duel Masters wiki (TCG and OCG), Twinpact cards with both halves.
- Search by name (EN / JP / IT) and rules text; filters for civilization (multi-select), cost range,
  type, set, rarity and TCG/OCG; sorting by name, cost, power or number in set.
- Full-screen card view with tilt / glare (mouse, finger, phone gyroscope), swipe to move
  between cards, and a strip with every other printing (variants).
- A page per set (`?set=DM-01`), and shareable links: all filters, the open card and the
  variant live in the URL.
- PWA: manifest, icons and a service worker (offline shell, cached data and images).

## Run locally
```powershell
python -m http.server 8765
# open http://localhost:8765
```

## Data pipeline
```powershell
python scripts/fetch_cards.py            # whole wiki (~25 min the first time; responses are cached)
python scripts/fetch_cards.py --limit-pages 300   # quick test run
python scripts/make_icons.py             # regenerate the PWA icons (needs Pillow)
```
Only the Python standard library is needed for `fetch_cards.py`. It talks to the wiki's
`api.php` politely (descriptive User-Agent, batches of 50, 1 s pause, `maxlag`, local cache in
`scripts/.cache/`).

Output in `data/`: `index.json` (slim list for the grid), `cards/<id>.json` (one full record per card),
`sets.json`.

### Images
Card images currently load from the wiki CDN. `scripts/fetch_images.py` can download one copy per
card and convert it to WebP (thumbnail + large) served from `images/`; the site prefers those
files when `data/images.json` lists them. At the moment the CDN answers 403 to non-browser clients,
and the script deliberately stops there instead of working around it.

## Deploy
`.github/workflows/pages.yml` deploys to GitHub Pages on every push to `main`, and every Monday it
re-reads the wiki, commits changed data and redeploys (new sets appear automatically).
In the repository settings, set **Pages → Source** to **GitHub Actions**.

## Licenses
- Code: free to reuse.
- Data (`data/`): derived from the Duel Masters Wiki on Fandom, CC BY-SA 3.0 — see `LICENSE-DATA`.
- Card images and trademarks: © Takara Tomy / Wizards of the Coast. Not covered by any license here.
