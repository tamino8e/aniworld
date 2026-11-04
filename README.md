# AniWorld – SkyStream Plugin

Scraper für aniworld.to. German Dub wird bevorzugt, VOE hat Hosting-Priorität.

- Sprachen: de
- Kategorie: anime
- Mirror-Domains über die Plugin-Einstellungen wählbar

## Logik
`loadStreams` liest die Hoster-Liste der Episode, filtert `data-lang-key="1"` (Dub),
fällt auf `3` (GerSub) zurück und sortiert VOE nach vorn. Die `/redirect/{id}`-Seite
wird aufgelöst, danach greift der passende Extractor aus `skystream-extractors`.