"""Shared HTTP fetcher for the ban toolchain.

All external fetches go through curl_cffi with ``impersonate="chrome"`` so the
TLS/JA3/HTTP2 fingerprint matches a real browser. This is what beats the
anti-bot fingerprinting on Instagram and (best-effort) TikTok — plain clients
(Node undici, requests, httpx) are blocked on handshake regardless of headers.

Do NOT set a custom User-Agent / Sec-CH-UA here: curl_cffi's impersonation
sets a coherent header set matching the spoofed fingerprint. Overriding it
re-introduces a bot signal (header/fingerprint mismatch).
"""

from __future__ import annotations

from curl_cffi import requests

# Pin a recent Chrome profile. curl_cffi ships fingerprints for specific
# Chrome builds; "chrome" tracks the latest bundled profile.
IMPERSONATE = "chrome"
DEFAULT_TIMEOUT = 20


def get(url: str, *, headers: dict | None = None, timeout: int = DEFAULT_TIMEOUT):
    """GET with Chrome impersonation. Returns the curl_cffi Response.

    Raises curl_cffi.requests.RequestsError on transport failure (DNS, TLS,
    timeout) — callers decide whether that is fatal or a soft miss.
    """
    return requests.get(url, impersonate=IMPERSONATE, headers=headers, timeout=timeout)


def post_json(url: str, payload, *, headers: dict | None = None, timeout: int = DEFAULT_TIMEOUT):
    """POST a JSON body with Chrome impersonation. Returns the Response."""
    return requests.post(
        url, json=payload, impersonate=IMPERSONATE, headers=headers, timeout=timeout
    )
