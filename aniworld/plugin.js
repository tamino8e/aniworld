import { Voe, Filemoon, DoodExtractor } from 'skystream-extractors/dist/index.js';

(function () {
    const HEADERS = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8'
    };

    const LANG_DUB = '1';
    const LANG_GER_SUB = '3';

    // VOE zuerst
    const HOSTER_ORDER = ['voe', 'vidmoly', 'filemoon', 'doodstream', 'vidoza', 'streamtape'];
    const MAX_HOSTER = 8;

    // ---------------------------------------------------------------
    function abs(url) {
        if (!url) return '';
        if (/^https?:\/\//i.test(url)) return url;
        if (url.startsWith('//')) return 'https:' + url;
        return manifest.baseUrl.replace(/\/+$/, '') + (url.startsWith('/') ? url : '/' + url);
    }

    function clean(str) {
        return (str || '')
            .replace(/<[^>]*>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&auml;/g, 'ä').replace(/&ouml;/g, 'ö').replace(/&uuml;/g, 'ü')
            .replace(/&Auml;/g, 'Ä').replace(/&Ouml;/g, 'Ö').replace(/&Uuml;/g, 'Ü')
            .replace(/&szlig;/g, 'ß')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function slugFrom(url) {
        const m = String(url).match(/\/anime\/stream\/([^/?#]+)/i);
        return m ? m[1] : String(url).replace(/[?#].*$/, '').split('/').filter(Boolean).pop() || '';
    }

    function seriesUrlOf(url) {
        const slug = slugFrom(url);
        return slug ? `${manifest.baseUrl}/anime/stream/${slug}` : abs(url);
    }

    function episodeUrl(slug, season, episode) {
        return `${manifest.baseUrl}/anime/stream/${slug}/staffel-${season}/episode-${episode}`;
    }

    async function fetchHtml(url, referer) {
        const headers = { ...HEADERS };
        if (referer) headers['Referer'] = referer;
        const res = await http_get(url, headers);
        if (res.status >= 400) throw new Error(`HTTP ${res.status} – ${url}`);
        return res.body || '';
    }

    function hosterRank(name) {
        const idx = HOSTER_ORDER.indexOf(String(name || '').toLowerCase());
        return idx === -1 ? HOSTER_ORDER.length : idx;
    }

    // ---------------------------------------------------------------
    // Listing-Parser – arbeitet auf <a title="… als Stream anschauen">
    // ---------------------------------------------------------------
    function cardsFrom(html) {
        const items = [];
        const seen = new Set();

        const anchorRe = /<a\b[^>]*href="([^"]*\/anime\/stream\/[^"]+)"[^>]*>([\s\S]{0,900}?)<\/a>/gi;
        let m;
        while ((m = anchorRe.exec(html)) !== null) {
            const href = m[1];
            const inner = m[2];
            const slug = slugFrom(href);
            if (!slug || seen.has(slug)) continue;

            // Episoden-Links (/staffel-x/episode-y) überspringen
            if (/\/staffel-\d+\/episode-/i.test(href)) continue;

            const titleAttr = (m[0].match(/title="([^"]+)"/i) || [])[1] || '';
            const altAttr = (inner.match(/alt="([^"]+)"/i) || [])[1] || '';
            const img = (inner.match(/<img[^>]+src="([^"]+)"/i) || [])[1] || '';

            const title = clean(titleAttr.replace(/\s+als\s+Stream\s+anschauen$/i, ''))
                || clean(altAttr.replace(/\s+Cover$/i, ''))
                || slug.replace(/-/g, ' ');

            if (!title) continue;
            seen.add(slug);

            // Hero-Bilder (/public/img/home/) sind Banner, keine Cover
            const isHero = /\/public\/img\/home\//i.test(img);
            items.push({
                slug,
                title,
                poster: isHero ? '' : abs(img),
                banner: isHero ? abs(img) : ''
            });
        }

        return items;
    }

    function toItem(card) {
        return new MultimediaItem({
            title: card.title,
            url: `${manifest.baseUrl}/anime/stream/${card.slug}`,
            posterUrl: card.poster || `${manifest.baseUrl}/public/img/cover/${card.slug}-stream-cover-220x330.png`,
            bannerUrl: card.banner || undefined,
            type: 'anime',
            playbackPolicy: 'none',
            syncData: { slug: card.slug }
        });
    }

    // ---------------------------------------------------------------
    // 1. getHome
    // ---------------------------------------------------------------
    async function getHome(cb) {
        try {
            const homeHtml = await fetchHtml(`${manifest.baseUrl}/`);
            console.error(`[AniWorld] Homepage geladen: ${homeHtml.length} Zeichen`);

            const cards = cardsFrom(homeHtml);
            console.error(`[AniWorld] Karten geparst: ${cards.length}`);

            if (!cards.length) {
                return cb({ success: false, errorCode: 'NOT_FOUND', message: 'Keine Karten im Homepage-HTML gefunden.' });
            }

            const data = { 'Trending': cards.slice(0, 20).map(toItem) };
            if (cards.length > 20) data['Neu auf AniWorld'] = cards.slice(20, 50).map(toItem);

            cb({ success: true, data });
        } catch (e) {
            cb({ success: false, errorCode: 'LOAD_ERROR', message: String(e && e.message || e) });
        }
    }

    // ---------------------------------------------------------------
    // 2. search
    // ---------------------------------------------------------------
    async function search(query, cb) {
        try {
            const q = String(query || '').trim();
            if (!q) return cb({ success: true, data: [] });

            const html = await fetchHtml(`${manifest.baseUrl}/search?q=${encodeURIComponent(q)}`);
            cb({ success: true, data: cardsFrom(html).map(toItem) });
        } catch (e) {
            cb({ success: false, errorCode: 'LOAD_ERROR', message: String(e && e.message || e) });
        }
    }

    // ---------------------------------------------------------------
    // 3. load
    // ---------------------------------------------------------------
    async function load(url, cb) {
        try {
            const seriesUrl = seriesUrlOf(url);
            const slug = slugFrom(seriesUrl);
            const html = await fetchHtml(seriesUrl);

            const title = clean(((await parse_html(html, 'h1'))[0] || {}).text) || slug.replace(/-/g, ' ');

            let description = ((await parse_html(html, 'meta[name="description"]', 'content'))[0] || {}).attr || '';
            if (!description) description = ((await parse_html(html, 'div[class*="description"]'))[0] || {}).text || '';
            description = clean(description.replace(/…?\s*mehr anzeigen$/i, '')).slice(0, 800);

            let poster = ((await parse_html(html, 'img[alt*="Cover"]', 'src'))[0] || {}).attr || '';
            poster = abs(poster);

            const genreTags = [...new Set(
                (await parse_html(html, 'a[href*="/genre/"]')).map(g => clean(g.text)).filter(Boolean)
            )].slice(0, 8);

            const seasons = [...new Set(
                (await parse_html(html, 'a[href*="/staffel-"]', 'href'))
                    .map(s => (String(s.attr).match(/staffel-(\d+)/i) || [])[1])
                    .filter(Boolean)
                    .map(Number)
            )].sort((a, b) => a - b);

            const hasFilme = /\/anime\/stream\/[^/"]+\/filme/i.test(html);
            if (!seasons.length && !hasFilme) {
                return cb({ success: false, errorCode: 'NOT_FOUND', message: 'Keine Staffeln gefunden.' });
            }

            const listUrls = seasons.slice(0, 12).map(s => `${seriesUrl}/staffel-${s}`);
            if (hasFilme) listUrls.push(`${seriesUrl}/filme`);

            const responses = listUrls.length === 1
                ? [await http_get(listUrls[0], { ...HEADERS, Referer: seriesUrl })]
                : await http_parallel(listUrls.map(u => ({ url: u, headers: { ...HEADERS, Referer: seriesUrl } })));

            const episodes = [];
            const seenEp = new Set();

            responses.forEach((res, idx) => {
                if (!res || res.status >= 400 || !res.body) return;

                const listUrl = listUrls[idx];
                const seasonMatch = listUrl.match(/staffel-(\d+)/i);
                const season = seasonMatch ? Number(seasonMatch[1]) : 1;

                // Zeilenweise parsen, um die Dub-Flagge pro Folge zu bekommen
                const rows = res.body.split(/<tr[\s>]/i);
                for (const row of rows) {
                    const epMatch = row.match(/\/staffel-\d+\/episode-(\d+)/i) || row.match(/\/filme\/?[^"]*?episode-(\d+)/i);
                    if (!epMatch) continue;

                    const n = Number(epMatch[1]);
                    const key = `${season}-${n}`;
                    if (seenEp.has(key)) continue;
                    seenEp.add(key);

                    // /public/img/german.svg = Dub; japanese-german.svg zählt nicht mit
                    const dubbed = /public\/img\/german\.svg/i.test(row);
                    const epTitle = clean((row.match(/<strong[^>]*>([\s\S]*?)<\/strong>/i) || [])[1]);

                    episodes.push(new Episode({
                        name: epTitle
                            ? `S${String(season).padStart(2, '0')}E${String(n).padStart(2, '0')} – ${epTitle}`
                            : `S${String(season).padStart(2, '0')}E${String(n).padStart(2, '0')}`,
                        url: episodeUrl(slug, season, n),
                        season,
                        episode: n,
                        dubStatus: dubbed ? 'dubbed' : 'subbed',
                        playbackPolicy: 'none'
                    }));
                }
            });

            if (!episodes.length) {
                return cb({ success: false, errorCode: 'NOT_FOUND', message: 'Keine Episoden gefunden.' });
            }

            cb({
                success: true,
                data: new MultimediaItem({
                    title,
                    url: seriesUrl,
                    posterUrl: poster || `${manifest.baseUrl}/public/img/cover/${slug}-stream-cover-220x330.png`,
                    type: 'anime',
                    description,
                    tags: genreTags,
                    episodes,
                    playbackPolicy: 'none',
                    syncData: { slug }
                })
            });
        } catch (e) {
            cb({ success: false, errorCode: 'LOAD_ERROR', message: String(e && e.message || e) });
        }
    }

    // ---------------------------------------------------------------
    // 4. loadStreams
    // ---------------------------------------------------------------
    async function resolveRedirect(redirectUrl, referer) {
        const body = await fetchHtml(redirectUrl, referer);

        const iframe = ((await parse_html(body, 'iframe[src]', 'src'))[0] || {}).attr
            || ((await parse_html(body, 'div[data-original-tag="iframe"]', 'src'))[0] || {}).attr;
        if (iframe) return abs(iframe);

        const jsLoc = body.match(/(?:location\.href|window\.location)\s*=\s*["']([^"']+)["']/i);
        if (jsLoc) return abs(jsLoc[1]);

        const meta = body.match(/<meta[^>]+http-equiv=["']refresh["'][^>]+url=([^"'>]+)/i);
        if (meta) return abs(meta[1]);

        const loose = body.match(/https?:\/\/[^"'\s<>]*\/(?:e|v|d|embed)\/[^"'\s<>]+/i);
        if (loose) return loose[0];

        return '';
    }

    async function extract(hosterUrl, label, referer) {
        const lower = hosterUrl.toLowerCase();
        const isVoe = /voe/i.test(label) || lower.includes('voe.sx') || lower.includes('shannoncoldalready');

        if (isVoe) {
            try {
                const out = await new Voe().getUrl(hosterUrl);
                if (out && out.length) return out;
            } catch (e) {
                console.error(`[AniWorld] Voe-Extractor fehlgeschlagen: ${e}`);
            }
        }
        if (lower.includes('filemoon') || lower.includes('fmoon')) {
            try { return await new Filemoon().getUrl(hosterUrl); } catch (e) { /* weiter */ }
        }
        if (lower.includes('dood') || lower.includes('ds2play')) {
            try { return await new DoodExtractor().getUrl(hosterUrl); } catch (e) { /* weiter */ }
        }
        try {
            return await loadExtractor(hosterUrl, referer);
        } catch (e) {
            console.error(`[AniWorld] loadExtractor fehlgeschlagen (${label}): ${e}`);
            return [];
        }
    }

    async function loadStreams(url, cb) {
        try {
            const epUrl = abs(url);
            const referer = seriesUrlOf(epUrl);
            const html = await fetchHtml(epUrl, referer);

            // Hosterliste: <li data-lang-key data-link-target><a href=/redirect/…><h4>VOE</h4>
            const nodes = await parse_html(html, 'li[data-lang-key]', 'html');

            const hosts = [];
            const seen = new Set();

            for (const node of nodes) {
                const raw = node.html || '';
                const href = (raw.match(/href="([^"]*\/redirect\/[^"]+)"/i) || [])[1];
                if (!href) continue;

                const full = abs(href);
                if (seen.has(full)) continue;
                seen.add(full);

                const lang = (raw.match(/data-lang-key="(\d+)"/i) || [])[1] || '';
                const target = clean((raw.match(/<h4[^>]*>([\s\S]*?)<\/h4>/i) || [])[1])
                    || clean((raw.match(/title="Hoster\s+([^"]+)"/i) || [])[1]);

                hosts.push({ url: full, lang, target });
            }

            console.error(`[AniWorld] Hoster gefunden: ${hosts.length} (Dub: ${hosts.filter(h => h.lang === LANG_DUB).length})`);

            // Inline-Player als Notnagel (Standardsprache = Dub)
            const inlineSrc = ((await parse_html(html, 'div[data-original-tag="iframe"]', 'src'))[0] || {}).attr
                || ((await parse_html(html, 'div.inSiteWebStream iframe[src]', 'src'))[0] || {}).attr;

            let pool = hosts.filter(h => h.lang === LANG_DUB);
            if (!pool.length) pool = hosts.filter(h => h.lang === LANG_GER_SUB);
            if (!pool.length) pool = hosts;

            pool.sort((a, b) => hosterRank(a.target) - hosterRank(b.target));
            pool = pool.slice(0, MAX_HOSTER);

            // Untertitel
            const subtitles = (await parse_html(html, 'a[href*="/subtitle/"]', 'href'))
                .map((s, i) => ({ url: abs(s.attr), label: `Deutsch ${i + 1}`, lang: 'de' }))
                .slice(0, 3);

            const resolved = await Promise.all(
                pool.map(h => resolveRedirect(h.url, epUrl).catch(() => ''))
            );

            const results = [];
            const urlsSeen = new Set();

            for (let i = 0; i < pool.length; i += 3) {
                const batch = pool.slice(i, i + 3);
                const settled = await Promise.all(batch.map((h, j) => {
                    const hosterUrl = resolved[i + j];
                    if (!hosterUrl) return Promise.resolve([]);
                    return extract(hosterUrl, h.target, epUrl);
                }));

                settled.forEach((streams, j) => {
                    const label = pool[i + j].target || 'Hoster';
                    for (const s of streams || []) {
                        if (!s || !s.url || urlsSeen.has(s.url)) continue;
                        urlsSeen.add(s.url);
                        results.push(new StreamResult({
                            url: s.url,
                            source: label,
                            quality: s.quality || 'Auto',
                            headers: { Referer: s.referer || epUrl, ...(s.headers || {}) },
                            subtitles: subtitles.length ? subtitles : undefined
                        }));
                    }
                });
            }

            // Fallback 1: Inline-Player
            if (!results.length && inlineSrc) {
                const out = await extract(abs(inlineSrc), 'VOE', epUrl).catch(() => []);
                for (const s of out || []) {
                    if (!s || !s.url || urlsSeen.has(s.url)) continue;
                    urlsSeen.add(s.url);
                    results.push(new StreamResult({
                        url: s.url,
                        source: 'VOE',
                        quality: s.quality || 'Auto',
                        headers: { Referer: epUrl, ...(s.headers || {}) }
                    }));
                }
            }

            // Fallback 2: rohe Embed-URLs
            if (!results.length) {
                pool.forEach((h, i) => {
                    const hosterUrl = resolved[i];
                    if (!hosterUrl) return;
                    results.push(new StreamResult({
                        url: hosterUrl,
                        source: `${h.target || 'Hoster'} (Embed)`,
                        quality: 'Auto',
                        headers: { Referer: epUrl }
                    }));
                });
            }

            if (!results.length) {
                return cb({ success: false, errorCode: 'NOT_FOUND', message: 'Keine Streams gefunden.' });
            }

            cb({ success: true, data: results });
        } catch (e) {
            cb({ success: false, errorCode: 'LOAD_ERROR', message: String(e && e.message || e) });
        }
    }

    globalThis.getHome = getHome;
    globalThis.search = search;
    globalThis.load = load;
    globalThis.loadStreams = loadStreams;
})();