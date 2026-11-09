# AniWorld for SkyStream

A [SkyStream](https://github.com/akashdh11/skystream) plugin repository that adds
[AniWorld.to](https://aniworld.to) as a provider: German dub, German sub and English sub anime,
with episode lists, search and playable HLS/MP4 streams.

## Install

1. Open SkyStream → **Settings → Extensions → Add Repository**.
2. Paste the raw URL of this repository's `repo.json`:

   ```
   https://raw.githubusercontent.com/tamino8e/aniworld/main/repo.json
   ```

3. Install **AniWorld** from the list, then pick it as your provider.

The plugin is plain JavaScript, so installing needs no build step, API key or dependency install —
`dist/` already holds the built bundle that the repository catalogue points at.

## Repository layout

```
repo.json                    # repository manifest (entry point for SkyStream)
dist/
  plugins.json               # plugin catalogue the app reads (built)
  dev.skystream.aniworld.sky # built plugin bundle: plugin.json + plugin.js
aniworld/
  plugin.json                # plugin manifest: name, baseUrl, domain selector
  plugin.js                  # the provider (getHome, search, load, loadStreams)
```

## Distribution

SkyStream installs a single `.sky` file, and `dist/` ships it prebuilt:

- `dist/dev.skystream.aniworld.sky` — a zip holding `plugin.json` and `plugin.js` at its root.
- `dist/plugins.json` — the catalogue the app reads: one entry per plugin, carrying its manifest and
  the absolute URL of its `.sky`.

`repo.json` points at `dist/plugins.json`, so the app only ever needs the `repo.json` URL. The
absolute URLs in both files are pinned to `https://raw.githubusercontent.com/tamino8e/aniworld/main`.
If you fork or rename the repository, either update them by hand or let the official CLI rebuild
everything with your real URLs:

```bash
npm install -g skystream-cli
skystream deploy -u https://raw.githubusercontent.com/tamino8e/aniworld/main
```

That command re-zips each plugin into `dist/<packageName>.sky`, rewrites `dist/plugins.json` and
points `repo.json` at it. Re-run it after changing `plugin.js` — the bundle is not rebuilt automatically.

The bundle is just a plain zip of the two files, so it can also be rebuilt by hand:

```bash
cd aniworld && zip -9 ../dist/dev.skystream.aniworld.sky plugin.json plugin.js
```

## What it provides

| Handler | Behaviour |
| --- | --- |
| `getHome` | Hero row from *Beliebt bei AniWorld*, plus rows for **Neue Animes**, **Deutsch (Dub)**, **GerSub** and **EngSub** |
| `search` | AniWorld's own search API (`POST /ajax/search`), de-duplicated to series and enriched with cover, year and synopsis; falls back to the A–Z catalogue |
| `load` | Title, cover, year, FSK rating, IMDb id, genres and synopsis, plus every season and the film list as episodes |
| `loadStreams` | Resolves the episode's hosters per language, honours the language preference and returns playable stream URLs |

Episodes carry their AniWorld title (e.g. *Grausamkeit*), season and episode numbers, and whether
the episode is dubbed or subbed. Films are listed as season `0`, after the numbered seasons.

## Sources

AniWorld links each episode to four hosters. The plugin resolves them itself:

| Hoster | Status | How |
| --- | --- | --- |
| **VOE** | Works | Reads the obfuscated JSON payload and reverses it (ROT13 → marker strip → base64 → shift → reverse → base64 → JSON) to get the HLS master and the MP4 download |
| **Vidmoly** | Works | Reads the HLS master playlist out of the embed page |
| **Filemoon** | Best effort | Queries `/api/videos/<code>`; playback is key-part based, so it may return nothing |
| **Doodstream** | Implemented, often blocked | Replays the player handshake: `pass_md5` path, token from its last segment, 10 random characters, `?token=…&expiry=…`, then verifies the CDN link with a ranged request. Mirrors answering with a Cloudflare challenge are detected and skipped, so it resolves whenever the challenge is not served (typically mobile connections) |

Streams are labelled with the hoster and language (`VOE · Ger Dub`, `Vidmoly · Eng Sub`) and
carry the `Referer` their CDN expects. Up to four hosters per language are tried, within a time
budget, so one slow hoster cannot block the rest. A hoster that only returns a Cloudflare
challenge is skipped instead of producing an unplayable link.

## Language preference

`plugin.json` declares a `language` setting, so the plugin's gear icon in the Extensions screen
shows a **Preferred language** dropdown:

| Value | Result |
| --- | --- |
| Auto (all languages) | Every language stays in the source list — the default |
| German Dub | Only `… · Ger Dub` sources are returned |
| English Sub | Only `… · Eng Sub` sources are returned |
| German Sub | Only `… · Ger Sub` sources are returned |

If the preferred language has no source for an episode — common for shows that are subbed but not
dubbed — all languages are returned instead of an empty list, so the setting can never leave you with
nothing to play. SkyStream stores the choice per plugin, and it applies to every episode until you
change it.

## Domain changes

AniWorld moves domains regularly. `plugin.json` declares a `domains` list, which SkyStream exposes
as a domain selector in the plugin's settings — the selected URL is injected as `manifest.baseUrl`,
so no code changes are needed. The plugin ships four entries:

| Domain | Status |
| --- | --- |
| `aniworld.to` | Primary |
| `aniworld.cc` | Official alternative, verified to serve the same markup |
| `aniworld.cx` | Mirror, verified to serve the same markup |
| `aniworld.io` | Redirects to `aniworld.to` |

If the site moves again, take the current address from the operator's own list at
[aniworld.domains](https://aniworld.domains) and add it here:

```json
"domains": [
  { "name": "aniworld.to", "url": "https://aniworld.to" },
  { "name": "mirror.example", "url": "https://mirror.example" }
]
```

## Local development

The official CLI runs a plugin against a mock runtime:

```bash
npm install -g skystream-cli
skystream validate
skystream test -f getHome
skystream test -f search -q "demon slayer"
skystream test -f load -q "https://aniworld.to/anime/stream/demon-slayer-kimetsu-no-yaiba"
skystream test -f loadStreams -q "https://aniworld.to/anime/stream/demon-slayer-kimetsu-no-yaiba/staffel-1/episode-1"
```

## Notes

- The plugin scrapes the public site. If AniWorld changes its markup, parsing selectors may need
  updating.
- Stream availability depends entirely on AniWorld and its hosters, and links expire; a source that
  fails once usually works after reopening the episode.
- A VPN may be required depending on your region.

## Disclaimer

This project is not affiliated with AniWorld.to and does not host any media. It only resolves links
the site itself publishes. You are responsible for how you use it and for following the laws that
apply where you live.
