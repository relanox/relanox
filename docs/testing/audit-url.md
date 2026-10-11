# Channel API base URL validation

1. Observable behavior: LINE, WhatsApp, Google Chat, QQ and DingTalk reject API bases with query strings during configuration validation. Google Chat sends to the same message path when its base has a trailing slash. Complete Google Chat OAuth and JWKS endpoint URLs may retain their query parameters.
2. Credible regression: these five configurations currently accept a query-bearing base, then concatenate message/token paths after its query. For example, `https://graph.facebook.com/?x=1` produces pathname `/` and search `?x=1/v25.0/phone/messages`. Google Chat currently produces `//v1/...` from a normal trailing slash. A broad change to the common endpoint validator would also incorrectly reject complete OAuth/JWKS URLs.
3. Existing coverage checks insecure origins and credentials, but no query-bearing API bases. Google Chat's real protocol send only uses a slash-free base. Add a coherent public configuration contract for the five affected channels and extend the existing Google Chat HTTP/core/SQLite protocol case to both base spellings.
4. No new production seam. Tests call public plugin `validateConfig`; the Google Chat case uses its existing real HTTP peer, signed ingress, OAuth and persisted outbound. Expected wire paths are literal protocol paths.

Audit: Telegram, Discord, Slack and Feishu already reject query strings on HTTP bases while permitting query strings on WebSocket URLs. Matrix, Mattermost and Signal reject query strings in `trustedBase`. Teams rejects queries in untrusted activity service bases separately from complete OAuth/JWKS endpoints. IRC and WeCom do not concatenate HTTP API paths. Ordinary single trailing slashes are already stripped on these other API bases; Google Chat was the missing case.

## Empty query and fragment delimiters

1. Protect the same public API base configuration contract for all twelve channels that append HTTP paths, including bare `?` and `#` delimiters. Valid encoded path characters and WebSocket query parameters remain usable.
2. WHATWG URL returns empty `search`/`hash` for bare delimiters but preserves them in `href`. Existing checks therefore accept a base ending in `?` or `#`, and the appended API path becomes a query or fragment rather than a pathname.
3. Existing checks cover populated fragments/queries or insecure origins. Extend the coherent configuration table to literal query and fragment boundaries, including the seven previously protected channels. Add a positive Discord Gateway query case to protect its distinct complete-WebSocket-endpoint semantics.
4. No new production seam. Public configuration validation is itself the observable contract; valid base controls make sure rejection is not caused by unrelated incomplete configuration.

## Teams inbound service base

1. Reject a signed, trusted-origin Teams activity whose service base ends in a bare query/fragment delimiter before persisting work.
2. Teams uses the same string path concatenation for outbound conversation URLs; a bare delimiter passes its existing `search`/`hash` checks and causes the eventual request to miss the intended conversation path.
3. Existing signed service-URL cases cover untrusted origins and JWT mismatch, not a malformed base on an otherwise trusted origin with matching claims.
4. No new seam. Sign actual JWTs with the local peer's key and call the production HTTP handler/core/SQLite path; expect no pending request.
