#!/usr/bin/env python3
"""
Scrape Social Blade top-channels list for a country.

Usage:
  python3 socialblade.py <country-code> [--limit N]

Examples:
  python3 socialblade.py us
  python3 socialblade.py gb --limit 50

Outputs JSON array to stdout:
  [
    {"rank": 1, "channelId": "UC...", "handle": "mrbeast", "name": "MrBeast", "subs": "412M"},
    ...
  ]

Reasoning:
  Social Blade sits behind Cloudflare's bot challenge. Plain `fetch` and `curl`
  get a 403 + JS challenge. curl_cffi with chrome impersonation defeats the
  TLS/JA3 fingerprint check and the page returns 200.

  Each row in the top-list table embeds:
    <tr id="UCxxxxxxxxxxxxxxxxxxxxxx">                           # canonical channel ID
      ...
      <a href="/youtube/handle/<handle>"> ... </a>                # platform handle
      <span class="px-4 h-full">Channel Name</span>               # display name
      <a ...>412M</a>                                              # subs
"""

import argparse
import html as html_lib
import json
import re
import sys

from curl_cffi import requests
from selectolax.lexbor import LexborHTMLParser


def fetch(country: str) -> str:
    url = f"https://socialblade.com/youtube/top/country/{country}/mostsubscribed"
    r = requests.get(url, impersonate="chrome", timeout=30)
    if r.status_code != 200:
        raise RuntimeError(f"HTTP {r.status_code} for {url}")
    return r.text


_RANK_RE = re.compile(r"\d+(st|nd|rd|th)$")


def parse(html: str, limit: int) -> list[dict]:
    tree = LexborHTMLParser(html)
    rows = []
    for tr in tree.css("tr[id^='UC']"):
        channel_id = tr.attributes.get("id")
        if not channel_id:
            continue
        cells = tr.css("td")
        if len(cells) < 3:
            continue

        # Cell 0 = rank (e.g. "1st"), cell 1 = avatar+name, cell 2 = subs
        rank_text = cells[0].text(strip=True)
        rank = int(re.sub(r"\D", "", rank_text)) if rank_text else 0

        # Handle from any anchor href
        handle = None
        for a in tr.css("a[href^='/youtube/handle/']"):
            handle = a.attributes.get("href", "").rsplit("/", 1)[-1] or None
            if handle:
                break

        # Channel name in span.px-4
        name_node = cells[1].css_first("span")
        name = (
            html_lib.unescape(name_node.text(strip=True))
            if name_node
            else cells[1].text(strip=True)
        )

        # Subs text from cell 2
        subs = cells[2].text(strip=True)

        rows.append(
            {
                "rank": rank,
                "channelId": channel_id,
                "handle": handle,
                "name": name,
                "subs": subs,
            }
        )

        if len(rows) >= limit:
            break
    return rows


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("country", help="ISO 3166-1 alpha-2 code, e.g. us, gb, in")
    p.add_argument("--limit", type=int, default=100)
    args = p.parse_args()

    try:
        html = fetch(args.country.lower())
        rows = parse(html, args.limit)
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        return 1

    print(json.dumps(rows, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
