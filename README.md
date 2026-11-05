# Bitcoin Weather

A live, animated world map showing how news coverage around the world feels about Bitcoin. It uses GDELT data and updates every 15 minutes.

**Cost: $0.** Hosting (GitHub Pages), the scheduler (GitHub Actions), and the data (GDELT) are all free. You only pay for the domain you already own.

## How it works

```
GDELT (every 15 min) ──► GitHub Actions runs scripts/update_data.py
                          • downloads the newest GKG file
                          • keeps articles tagged ECON_BITCOIN (or with "bitcoin" in the URL)
                          • averages tone by location, keeps a rolling 24 h
                          • writes docs/data/weather.json and commits it
                        ──► GitHub Pages publishes /docs at ericrobertson.org
Browser ──► reads weather.json, draws the animated map, refreshes every 5 min
        ──► live BTC price from CoinGecko's free API
```

## Files

| Path | What it is |
|---|---|
| `docs/index.html`, `style.css`, `app.js` | The website. No build step is needed. |
| `docs/vendor/` | Map libraries (d3-geo, topojson), stored locally |
| `docs/data/countries-110m.json` | World country shapes (Natural Earth, via world-atlas) |
| `docs/data/weather.json` | Created by the updater. It doesn't exist until the first run. |
| `scripts/update_data.py` | The data pipeline. It needs Python 3.9+ and uses only the standard library. |
| `.github/workflows/update.yml` | Runs the updater every 15 minutes and deploys the site |

## One-time setup (about 20 minutes)

### 1. Put the code on GitHub
1. Sign in at github.com and create a **new public repository** named `bitcoin-weather`. Public repos get free, unlimited Actions minutes.
2. Push this folder to it:
   ```bash
   cd bitcoin-weather
   git init && git add . && git commit -m "Bitcoin Weather"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/bitcoin-weather.git
   git push -u origin main
   ```
   If you'd rather drag and drop files on github.com, make sure the hidden `.github` folder gets uploaded too. Without it, nothing updates.

### 2. Turn on GitHub Pages
1. In the repo, open **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Under **Custom domain**, enter `ericrobertson.org` and click **Save**.

### 3. Run the first update
1. Open the **Actions** tab. If asked, click "I understand… enable workflows."
2. Select **Update Bitcoin Weather → Run workflow**.
3. The first run backfills the last 24 hours (96 GDELT files) and takes about 5–10 minutes. After that, each run takes under a minute.

### 4. Point ericrobertson.org at GitHub (in GoDaddy)
GoDaddy → **My Products → ericrobertson.org → DNS → Manage**:

| Type | Name | Value |
|---|---|---|
| A | @ | 185.199.108.153 |
| A | @ | 185.199.109.153 |
| A | @ | 185.199.110.153 |
| A | @ | 185.199.111.153 |
| CNAME | www | YOUR-USERNAME.github.io |

- **Delete** any other A record for `@`, such as GoDaddy's "Parked" or Website Builder record. Also delete the existing `www` CNAME before adding the new one.
- If GoDaddy says the domain is connected to the free Website Builder site, disconnect it first. The DNS editor will then let you change the records.
- Leave the MX and email records alone.

DNS usually takes effect within an hour, but it can take up to 24 hours. Once GitHub's Pages settings show the domain check passing, tick **Enforce HTTPS**.

## Good to know
- **What "tone" means:** GDELT scores the wording of each article. Most articles fall between −10 and +10, and Bitcoin coverage usually averages slightly negative. The page labels it as news sentiment, not public opinion.
- **Locations** are the places an article mentions. Articles with no location still count in the global forecast but don't appear on the map. Countries need at least 3 articles in the 3-hour window before they're shaded.
- **Timing:** GitHub's scheduler can run a few minutes late, so the map is usually 15–25 minutes behind real time.
- **Keep-alive:** GitHub pauses scheduled workflows in a repo that has no activity for 60 days. The data commits made every 15 minutes should keep it active. If it ever pauses, the Actions tab has a one-click **Enable** button.
- **Run locally:** `python scripts/update_data.py && python -m http.server -d docs 8000`, then open http://localhost:8000.
