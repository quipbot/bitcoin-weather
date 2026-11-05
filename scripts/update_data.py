#!/usr/bin/env python3
"""
Bitcoin Weather - data updater.

Pulls GDELT 2.0 Global Knowledge Graph (GKG) files (one every 15 minutes),
keeps only articles about Bitcoin, and writes a rolling 24-hour summary
to docs/data/weather.json for the map to read.

Two views are kept side by side:
  * "all"   - every article GDELT tags ECON_BITCOIN (or with bitcoin in the URL)
  * "focus" - the subset whose headline or URL is clearly about Bitcoin/crypto

Standard library only. Run:  python scripts/update_data.py
"""
import argparse
import html
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timedelta, timezone

VERSION = 2                # bump to force a fresh 24h backfill when the format changes
BASE = "http://data.gdeltproject.org/gdeltv2/"
LASTUPDATE = BASE + "lastupdate.txt"
SLOTS_KEPT = 96            # 24 hours of 15-minute slots
HEADLINES_KEPT = 800       # enough to cover the full 24h replay
DAYS_KEPT = 30
USER_AGENT = "BitcoinWeather/2.0 (ericrobertson.org)"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "data", "weather.json")

# GKG 2.1 column indexes
C_DATE, C_SRC, C_URL, C_THEMES, C_V2THEMES, C_V2LOC, C_TONE, C_EXTRAS = 1, 3, 4, 7, 8, 10, 15, 26
BTC_URL = re.compile(r"bitcoin|\bbtc\b", re.I)
FOCUS_RE = re.compile(
    r"bitcoin|\bbtc\b|crypto|cripto|kripto|krypto|blockchain|satoshi|stablecoin|ethereum|\bether\b|"
    r"\bcoin(s|base)?\b|\btokens?\b|\bmin(ing|ers?)\b|\betfs?\b|saylor|microstrategy|"
    r"比特币|比特幣|ビットコイン|비트코인|биткоин|بيتكوين|暗号資産|加密", re.I)
TITLE_RE = re.compile(r"<PAGE_TITLE>(.*?)</PAGE_TITLE>", re.S)


def http_get(url, tries=3, timeout=60):
    err = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            err = e
        except Exception as e:  # network hiccup
            err = e
        time.sleep(2 * (attempt + 1))
    print(f"  ! giving up on {url}: {err}", file=sys.stderr)
    return None


def slot_id(dt):
    return dt.strftime("%Y%m%d%H%M%S")


def parse_slot(sid):
    return datetime.strptime(sid, "%Y%m%d%H%M%S").replace(tzinfo=timezone.utc)


def latest_slot():
    raw = http_get(LASTUPDATE)
    if not raw:
        return None
    for line in raw.decode("utf-8", "replace").splitlines():
        if ".gkg.csv.zip" in line:
            name = line.strip().split()[-1].rsplit("/", 1)[-1]
            return name.split(".")[0]
    return None


def is_bitcoin(cols):
    if "ECON_BITCOIN" in cols[C_THEMES] or "ECON_BITCOIN" in cols[C_V2THEMES]:
        return True
    return bool(BTC_URL.search(cols[C_URL]))


def short_name(full):
    """'Austin, Texas, United States' -> 'Austin, United States'."""
    parts = [p.strip() for p in full.split(",") if p.strip()]
    if len(parts) >= 3:
        return f"{parts[0]}, {parts[-1]}"
    return ", ".join(parts)


def parse_locations(field, names):
    """Unique (lat, lon) cells, rounded to 0.5 degree, for one article.
    Records the most specific place name seen for each cell in `names`."""
    cells = set()
    for loc in filter(None, field.split(";")):
        p = loc.split("#")
        if len(p) < 7:
            continue
        try:
            ltype, lat, lon = int(p[0] or 0), float(p[5]), float(p[6])
        except ValueError:
            continue
        c = (round(lat * 2) / 2, round(lon * 2) / 2)
        cells.add(c)
        key = cell_key(*c)
        # prefer city-level names (type 3/4) over country/state centroids
        if p[1] and (key not in names or (ltype in (3, 4) and names[key][1] not in (3, 4))):
            names[key] = (short_name(p[1]), ltype)
    return cells


def num(x):
    """Format like JavaScript does (40.0 -> '40'), so keys match in the browser."""
    return str(int(x)) if x == int(x) else repr(x)


def cell_key(lat, lon):
    return f"{num(lat)},{num(lon)}"


def empty_slot(sid, missing=False):
    s = {"t": sid, "n": 0, "tone": 0, "fn": 0, "ftone": 0, "cells": []}
    if missing:
        s["missing"] = True
    return s


def process_text(text, sid):
    """Turn one GKG file's text into a slot summary, headlines and place names."""
    slot = empty_slot(sid)
    cells, heads, seen, names = {}, [], set(), {}
    for line in text.split("\n"):
        cols = line.split("\t")
        if len(cols) < 27 or not is_bitcoin(cols):
            continue
        url = cols[C_URL].split("?")[0]
        if url in seen:
            continue
        seen.add(url)
        try:
            tone = float(cols[C_TONE].split(",")[0])
        except (ValueError, IndexError):
            continue
        m = TITLE_RE.search(cols[C_EXTRAS])
        title = html.unescape(m.group(1)).strip() if m else ""
        focus = bool(FOCUS_RE.search(title) or FOCUS_RE.search(url))
        slot["n"] += 1
        slot["tone"] += tone
        if focus:
            slot["fn"] += 1
            slot["ftone"] += tone
        locs = parse_locations(cols[C_V2LOC], names)
        for c in locs:
            agg = cells.setdefault(c, [0, 0.0, 0, 0.0])
            agg[0] += 1
            agg[1] += tone
            if focus:
                agg[2] += 1
                agg[3] += tone
        if title:
            h = {"t": sid, "title": title[:160], "src": cols[C_SRC], "url": url, "tone": round(tone, 2)}
            if focus:
                h["f"] = 1
            if locs:
                h["loc"] = [cell_key(a, b) for a, b in list(locs)[:4]]
            heads.append(h)
    slot["tone"] = round(slot["tone"], 3)
    slot["ftone"] = round(slot["ftone"], 3)
    slot["cells"] = [[lat, lon, n, round(t, 2), fn, round(ft, 2)]
                     for (lat, lon), (n, t, fn, ft) in cells.items()]
    return slot, heads, {k: v[0] for k, v in names.items()}


def fetch_slot(sid):
    raw = http_get(f"{BASE}{sid}.gkg.csv.zip")
    if raw is None:
        return empty_slot(sid, True), [], {}
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            text = z.read(z.namelist()[0]).decode("utf-8", "replace")
    except zipfile.BadZipFile:
        return empty_slot(sid, True), [], {}
    return process_text(text, sid)


def load_state():
    try:
        with open(OUT, encoding="utf-8") as f:
            state = json.load(f)
        if state.get("version") != VERSION:
            print("Data format changed; rebuilding the last 24 hours.")
            return {"slots": [], "headlines": [], "daily": {}, "names": {}}
        return state
    except (FileNotFoundError, json.JSONDecodeError):
        return {"slots": [], "headlines": [], "daily": {}, "names": {}}


def merge(state, new_slots, new_heads, new_names, latest):
    by_t = {s["t"]: s for s in state.get("slots", [])}
    daily = state.get("daily", {})
    for s in new_slots:
        old = by_t.get(s["t"])
        d = daily.setdefault(s["t"][:8], [0, 0.0])
        if old and not old.get("missing"):
            d[0] -= old["n"]; d[1] -= old["tone"]  # replace, don't double-count
        d[0] += s["n"]; d[1] = round(d[1] + s["tone"], 3)
        by_t[s["t"]] = s
    window_start = slot_id(parse_slot(latest) - timedelta(minutes=15 * (SLOTS_KEPT - 1)))
    slots = sorted((s for t, s in by_t.items() if window_start <= t <= latest), key=lambda s: s["t"])

    heads = {h["url"]: h for h in state.get("headlines", [])}
    for h in new_heads:
        heads[h["url"]] = h
    heads = sorted(heads.values(), key=lambda h: h["t"], reverse=True)
    heads = [h for h in heads if h["t"] >= window_start][:HEADLINES_KEPT]

    # keep place names only for cells still on the map
    names = dict(state.get("names", {}))
    names.update(new_names)
    live = {cell_key(c[0], c[1]) for s in slots for c in s["cells"]}
    names = {k: v for k, v in names.items() if k in live}

    keep_days = sorted(daily)[-DAYS_KEPT:]
    return {
        "version": VERSION,
        "updated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "latest": latest,
        "slotMinutes": 15,
        "source": "GDELT 2.0 Global Knowledge Graph (gdeltproject.org)",
        "slots": slots,
        "headlines": heads,
        "names": names,
        "daily": {k: daily[k] for k in keep_days},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max-fetch", type=int, default=SLOTS_KEPT,
                    help="most GKG files to download this run (backfill cap)")
    args = ap.parse_args()

    latest = latest_slot()
    if not latest:
        print("Could not read GDELT lastupdate.txt; leaving data unchanged.")
        return 0
    state = load_state()
    have = {s["t"] for s in state.get("slots", []) if not s.get("missing")}
    want = [slot_id(parse_slot(latest) - timedelta(minutes=15 * i)) for i in range(SLOTS_KEPT)]
    todo = [t for t in want if t not in have][: args.max_fetch]
    print(f"Latest GDELT slot {latest}; fetching {len(todo)} file(s)")

    new_slots, new_heads, new_names = [], [], {}
    for sid in todo:
        s, h, nm = fetch_slot(sid)
        print(f"  {sid}: {s['n']} bitcoin articles ({s['fn']} headline stories)"
              f"{' (missing)' if s.get('missing') else ''}")
        new_slots.append(s)
        new_heads.extend(h)
        for k, v in nm.items():
            new_names.setdefault(k, v)

    out = merge(state, new_slots, new_heads, new_names, latest)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, separators=(",", ":"), ensure_ascii=False)
    print(f"Wrote {OUT} ({os.path.getsize(OUT)//1024} KB, {len(out['slots'])} slots)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
