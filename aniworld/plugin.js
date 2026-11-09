(function () {
  "use strict";

  /**
   * AniWorld.to provider for SkyStream (Gen 2 plugin format).
   *
   * Exports the four required handlers via globalThis:
   *   getHome(cb), search(query, cb), load(url, cb), loadStreams(url, cb)
   *
   * Streams are resolved from the hosters AniWorld links to:
   *   VOE        - obfuscated JSON payload, decoded locally
   *   Vidmoly    - HLS master embedded in the embed page
   *   Filemoon   - JSON API (/api/videos/<code>)
   *   Doodstream - best effort, often behind a Cloudflare challenge
   */

  var FALLBACK_BASE = "https://aniworld.to";
  var DESKTOP_UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  var MOBILE_UA =
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

  var MAX_SEASONS = 20;
  var MAX_STREAM_LINKS = 12;
  var LINK_BUDGET_MS = 45000;

  function base() {
    var raw =
      (typeof manifest !== "undefined" && manifest && manifest.baseUrl) ||
      FALLBACK_BASE;
    return String(raw).replace(/\/+$/, "");
  }

  function abs(path) {
    if (!path) return "";
    var p = String(path);
    if (/^https?:\/\//i.test(p)) return p;
    return base() + (p.charAt(0) === "/" ? p : "/" + p);
  }

  function headersFor(referer) {
    var h = {
      "User-Agent": DESKTOP_UA,
      "Accept": "text/html,application/xhtml+xml,application/json,*/*",
      "Accept-Language": "de-DE,de;q=0.9,en;q=0.8"
    };
    if (referer) h["Referer"] = referer;
    return h;
  }

  // ---------------------------------------------------------------- HTTP ---

  var httpCache = {};

  async function httpGet(url, headers, options) {
    var noCache = !!(options && options.nocache);
    var key = url;
    if (!noCache && httpCache[key] && Date.now() - httpCache[key].at < 30000) {
      return httpCache[key].value;
    }
    var result = { status: 0, body: "", url: url };
    try {
      if (typeof http_get === "function") {
        var res = await http_get(url, { headers: headers || headersFor("") });
        result = {
          status: (res && res.status) || 0,
          body: (res && res.body) || "",
          url: (res && (res.finalUrl || res.url)) || url
        };
      } else if (typeof fetch === "function") {
        var r = await fetch(url, { headers: headers || headersFor(""), redirect: "follow" });
        result = { status: r.status, body: await r.text(), url: r.url || url };
      }
    } catch (e) {
      console.log("aniworld: GET failed " + url + " " + e);
    }
    if (result.status === 0 && !result.body) {
      // One retry with a mobile UA: the site sometimes rate-limits the desktop UA.
      try {
        if (typeof http_get === "function") {
          var res2 = await http_get(url, {
            headers: Object.assign(headersFor(""), { "User-Agent": MOBILE_UA })
          });
          result = {
            status: (res2 && res2.status) || 0,
            body: (res2 && res2.body) || "",
            url: (res2 && (res2.finalUrl || res2.url)) || url
          };
        }
      } catch (e) {}
    }
    if (!noCache) httpCache[key] = { at: Date.now(), value: result };
    return result;
  }

  async function postForm(url, fields, headers) {
    var body = Object.keys(fields)
      .map(function (k) {
        return encodeURIComponent(k) + "=" + encodeURIComponent(fields[k]);
      })
      .join("&");
    var h = Object.assign(headersFor(base() + "/"), headers || {}, {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest"
    });
    try {
      if (typeof fetch === "function") {
        var r = await fetch(url, { method: "POST", headers: h, body: body });
        return { status: r.status, body: await r.text() };
      }
      if (typeof http_post === "function") {
        var res = await http_post(url, { headers: h, body: body });
        return { status: res.status || 0, body: res.body || "" };
      }
    } catch (e) {
      console.log("aniworld: POST failed " + url + " " + e);
    }
    return { status: 0, body: "" };
  }

  // ------------------------------------------------------------- helpers ---

  function decodeEntities(value) {
    if (!value) return "";
    return String(value)
      .replace(/&#(\d+);/g, function (_, code) {
        return String.fromCharCode(parseInt(code, 10));
      })
      .replace(/&#x([0-9a-f]+);/gi, function (_, code) {
        return String.fromCharCode(parseInt(code, 16));
      })
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  }

  function stripTags(value) {
    return decodeEntities(String(value || "").replace(/<[^>]*>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
  }

  function firstMatch(text, regex) {
    var m = regex.exec(text);
    return m ? m[1] : "";
  }

  function titleFromSlug(slug) {
    return String(slug || "")
      .split("-")
      .map(function (word) {
        return word ? word.charAt(0).toUpperCase() + word.slice(1) : word;
      })
      .join(" ");
  }

  function normalizeLanguage(name) {
    var lower = String(name || "").toLowerCase();
    if (!lower) return "";
    var isSub = lower.indexOf("untertitel") !== -1 || lower.indexOf("sub") !== -1;
    var isEnglish = lower.indexOf("englisch") !== -1 || lower.indexOf("english") !== -1;
    var isGerman = lower.indexOf("deutsch") !== -1 || lower.indexOf("german") !== -1;
    if (isSub) {
      if (isEnglish) return "Eng Sub";
      if (isGerman) return "Ger Sub";
    }
    if (isGerman) return "Ger Dub";
    if (isEnglish) return "Eng";
    return name;
  }

  function qualityFrom(text) {
    var m = /(1080|720|576|480|360)p/i.exec(String(text || ""));
    return m ? m[1] + "p" : "";
  }

  function hostOrigin(url) {
    var m = /^(https?:\/\/[^\/]+)/i.exec(String(url || ""));
    return m ? m[1] : "";
  }

  function timeout(promise, ms) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (!done) {
          done = true;
          resolve(null);
        }
      }, ms);
      promise.then(
        function (value) {
          if (!done) {
            done = true;
            clearTimeout(timer);
            resolve(value);
        }
        },
        function () {
          if (!done) {
            done = true;
            clearTimeout(timer);
            resolve(null);
          }
        }
      );
    });
  }

  async function mapLimit(items, limit, worker) {
    var results = [];
    var index = 0;
    async function run() {
      while (index < items.length) {
        var current = index++;
        try {
          results[current] = await worker(items[current], current);
        } catch (e) {
          results[current] = null;
        }
      }
    }
    var runners = [];
    for (var i = 0; i < Math.min(limit, items.length); i++) runners.push(run());
    await Promise.all(runners);
    return results;
  }

  // -------------------------------------------------------------- parsing ---

  function parseCards(html, limit) {
    var items = [];
    var re = /<a href="(\/anime\/stream\/[^"\/]+)"[^>]*>([\s\S]*?)<\/a>/g;
    var seen = {};
    var m;
    while ((m = re.exec(html)) !== null) {
      var url = m[1];
      var chunk = m[2];
      if (seen[url]) continue;
      var title = stripTags(firstMatch(chunk, /<h3[^>]*>([\s\S]*?)<\/h3>/));
      if (!title) continue;
      var poster =
        firstMatch(chunk, /data-src="([^"]+\.(?:png|jpe?g|webp))"/i) ||
        firstMatch(chunk, /src="(https?:\/\/[^"]+\.(?:png|jpe?g|webp))"/i);
      var genre = stripTags(firstMatch(chunk, /<small[^>]*>([\s\S]*?)<\/small>/));
      seen[url] = true;
      items.push(
        new MultimediaItem({
          title: title,
          url: abs(url),
          posterUrl: abs(poster),
          type: "anime",
          description: genre ? "Genre: " + genre : ""
        })
      );
      if (limit && items.length >= limit) break;
    }
    return items;
  }

  function parseSeriesMeta(html, url) {
    var title = stripTags(
      firstMatch(html, /<div class="series-title">[\s\S]*?<h1[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/)
    );
    if (!title) title = stripTags(firstMatch(html, /<h1[^>]*itemprop="name"[^>]*>([\s\S]*?)<\/h1>/));
    if (!title) title = stripTags(firstMatch(html, /<title>([^<]*)/)).replace(/\s*\|[^|]*$/, "");

    var poster =
      firstMatch(html, /class="seriesCoverBox"[\s\S]*?data-src="([^"]+)"/) ||
      firstMatch(html, /data-src="(\/public\/img\/cover\/[^"]+)"/);

    var description = decodeEntities(firstMatch(html, /data-full-description="([^"]*)"/));
    if (!description) description = stripTags(firstMatch(html, /class="seri_des"[^>]*>([\s\S]*?)<\/p>/));

    var year = parseInt(firstMatch(html, /itemprop="startDate">[\s\S]*?>(\d{4})</) || "0", 10);
    var fsk = firstMatch(html, /data-fsk="(\d+)"/);
    var imdb = firstMatch(html, /data-imdb="(tt\d+)"/);
    var score = parseFloat(firstMatch(html, /itemprop="ratingValue"[^>]*content="([\d.]+)"/) || "0");

    var genres = [];
    var genreRe = /class="genreButton[^"]*"[^>]*>([^<]+)</g;
    var g;
    while ((g = genreRe.exec(html)) !== null) {
      var name = stripTags(g[1]);
      if (name && genres.indexOf(name) === -1) genres.push(name);
    }

    var item = new MultimediaItem({
      title: title,
      url: url,
      posterUrl: abs(poster),
      type: "anime",
      year: year || undefined,
      score: score || undefined,
      description: description,
      contentRating: fsk ? "FSK " + fsk : undefined,
      syncData: imdb ? { imdb: imdb } : undefined
    });

    var seasons = {};
    var seasonRe = /\/staffel-(\d+)/g;
    var s;
    while ((s = seasonRe.exec(html)) !== null) seasons[parseInt(s[1], 10)] = true;

    return {
      item: item,
      genres: genres,
      seasons: Object.keys(seasons)
        .map(function (n) {
          return parseInt(n, 10);
        })
        .sort(function (a, b) {
          return a - b;
        }),
      hasFilms: /\/filme"/.test(html)
    };
  }

  function parseEpisodeRows(html, seasonNumber) {
    var episodes = [];
    var rowRe = /<tr([^>]*itemprop="episode"[^>]*)>([\s\S]*?)<\/tr>/g;
    var seen = {};
    var row;
    while ((row = rowRe.exec(html)) !== null) {
      var attrs = row[1];
      var chunk = row[2];
      var href =
        firstMatch(chunk, /<a itemprop="url" href="([^"]+)"/) ||
        firstMatch(chunk, /href="([^"]+(?:episode|film)-\d+)"/);
      if (!href || seen[href]) continue;
      seen[href] = true;

      var number = parseInt(
        firstMatch(chunk, /itemprop="episodeNumber" content="(\d+)"/) ||
          firstMatch(attrs, /data-episode-season-id="(\d+)"/) ||
          firstMatch(href, /(?:episode|film)-(\d+)$/) ||
          "0",
        10
      );
      var germanTitle = stripTags(firstMatch(chunk, /class="seasonEpisodeTitle"[\s\S]*?<strong>([\s\S]*?)<\/strong>/));
      var englishTitle = stripTags(firstMatch(chunk, /class="seasonEpisodeTitle"[\s\S]*?<span>([\s\S]*?)<\/span>/));

      var dubStatus = "none";
      if (/german\.svg/.test(chunk)) dubStatus = "dubbed";
      else if (/japanese-(german|english)\.svg/.test(chunk)) dubStatus = "subbed";

      var label = germanTitle || englishTitle;
      episodes.push(
        new Episode({
          name: label ? label : (seasonNumber === 0 ? "Film " : "Folge ") + number,
          url: abs(href),
          season: seasonNumber,
          episode: number,
          dubStatus: dubStatus
        })
      );
    }
    return episodes;
  }

  // ---------------------------------------------------------- stream hosts ---

  function rot13(text) {
    return String(text).replace(/[a-zA-Z]/g, function (c) {
      var lower = c <= "Z";
      var zero = lower ? 65 : 97;
      return String.fromCharCode(((c.charCodeAt(0) - zero + 13) % 26) + zero);
    });
  }

  function b64decode(text) {
    var input = String(text).replace(/-/g, "+").replace(/_/g, "/");
    while (input.length % 4 !== 0) input += "=";
    try {
      return atob(input);
    } catch (e) {
      return "";
    }
  }

  /** VOE's payload: ROT13 -> strip markers -> base64 -> shift -3 -> reverse -> base64 -> JSON. */
  function decodeVoePayload(raw) {
    var text = rot13(raw);
    var markers = ["@$", "^^", "~@", "%?", "*~", "!!", "#&"];
    for (var i = 0; i < markers.length; i++) text = text.split(markers[i]).join("");
    text = text.split("_").join("");

    var stage1 = b64decode(text);
    if (!stage1) return null;

    var shifted = "";
    for (var j = 0; j < stage1.length; j++) {
      shifted += String.fromCharCode(stage1.charCodeAt(j) - 3);
    }
    var reversed = shifted.split("").reverse().join("");
    var json = b64decode(reversed);
    if (!json) return null;
    try {
      return JSON.parse(json);
    } catch (e) {
      return null;
    }
  }

  function buildStream(url, source, quality, referer) {
    if (!url || !/^https?:\/\//i.test(url)) return null;
    var headers = { "User-Agent": DESKTOP_UA };
    if (referer) headers["Referer"] = referer;
    return new StreamResult({
      url: url.replace(/&amp;/g, "&"),
      source: source,
      quality: quality || qualityFrom(url) || "Auto",
      headers: headers
    });
  }

  async function extractVoe(page, label) {
    var body = page.body;
    var url = page.url;

    // voe.sx first serves a tiny JS bootstrap that bounces to a rotating mirror.
    if (body.length < 3000) {
      var hop = firstMatch(body, /window\.location\.href\s*=\s*'([^']+)'/);
      if (hop && hop.indexOf("permanentToken") === -1) {
        var next = await httpGet(hop, headersFor(url));
        if (next.body) {
          body = next.body;
          url = next.url;
        }
      }
    }

    var payloadMatch = /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/.exec(body);
    if (!payloadMatch) return [];

    var raw = "";
    try {
      var parsed = JSON.parse(payloadMatch[1]);
      raw = Array.isArray(parsed) ? parsed.join("") : String(parsed);
    } catch (e) {
      raw = payloadMatch[1].replace(/^\s*\["/, "").replace(/"\]\s*$/, "");
    }

    var data = decodeVoePayload(raw);
    if (!data) return [];

    var streams = [];
    var title = data.title || "";
    var referer = hostOrigin(url) + "/";
    if (data.source) {
      streams.push(buildStream(data.source, label, qualityFrom(title) || "Auto", referer));
    }
    if (data.direct_access_url) {
      streams.push(buildStream(data.direct_access_url, label + " (Download)", qualityFrom(title) || "Auto", referer));
    }
    return streams.filter(Boolean);
  }

  async function extractVidmoly(page, label) {
    var body = page.body || "";
    var m3u8 = /https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*/i.exec(body);
    if (!m3u8) {
      // Some mirrors keep the playlist inside packed JS.
      if (typeof getAndUnpack === "function" && /eval\(function\(p,a,c,k,e,d\)/.test(body)) {
        try {
          var unpacked = getAndUnpack(body);
          if (unpacked) m3u8 = /https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*/i.exec(unpacked);
        } catch (e) {}
      }
    }
    if (!m3u8) return [];
    var title = stripTags(firstMatch(body, /<title>([^<]*)/));
    return [buildStream(m3u8[0], label, qualityFrom(title) || "Auto", hostOrigin(page.url) + "/")].filter(Boolean);
  }

  async function extractFilemoon(page, label) {
    var code = firstMatch(page.url, /\/(?:d|e|v)\/([A-Za-z0-9]+)/);
    if (!code) return [];
    var origin = hostOrigin(page.url);
    var api = await httpGet(origin + "/api/videos/" + code, {
      "User-Agent": DESKTOP_UA,
      "Accept": "application/json",
      "Referer": page.url
    });
    if (!api.body) return [];

    var streams = [];
    var direct = /https?:\/\/[^\s"'<>\\]+\.(?:m3u8|mp4)[^\s"'<>\\]*/i.exec(api.body);
    if (direct) {
      streams.push(buildStream(direct[0], label, qualityFrom(api.body) || "Auto", origin + "/"));
    }

    if (!streams.length) {
      // Playback keys are delivered in parts; try the common join/decode shapes.
      try {
        var json = JSON.parse(api.body);
        var parts = (json.playback && json.playback.key_parts) || [];
        if (Array.isArray(parts) && parts.length) {
          var joined = parts.join("");
          for (var attempt = 0; attempt < 3 && !streams.length; attempt++) {
            joined = b64decode(joined);
            var found = /https?:\/\/[^\s"'<>\\]+\.(?:m3u8|mp4)[^\s"'<>\\]*/i.exec(joined);
            if (found) {
              streams.push(buildStream(found[0], label, qualityFrom(json.title || api.body) || "Auto", origin + "/"));
            }
          }
        }
      } catch (e) {}
    }
    return streams.filter(Boolean);
  }

  // Doodstream rotates mirrors; these entry domains redirect to whichever
  // mirror currently serves the file.
  var DOOD_ENTRY_DOMAINS = ["doodstream.com", "dood.la", "dood.wf", "ds2play.com"];

  function isCloudflareChallenge(res) {
    var body = (res && res.body) || "";
    if (!body) return true; // nothing usable came back
    return /Just a moment|challenge-platform|cf_chl_|Attention Required! \| Cloudflare/i.test(body);
  }

  function randomString(length) {
    var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    var out = "";
    for (var i = 0; i < length; i++) {
      out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return out;
  }

  function doodFileCode(url) {
    return firstMatch(String(url || ""), /\/(?:e|d|f)\/([A-Za-z0-9]+)/);
  }

  /** Picks a mirror that serves the real embed page instead of a challenge. */
  async function resolveDoodEmbed(code) {
    var blocked = {};
    var candidates = DOOD_ENTRY_DOMAINS.map(function (domain) {
      return "https://" + domain + "/e/" + code;
    });

    for (var i = 0; i < candidates.length; i++) {
      var res = await httpGet(candidates[i], headersFor(base() + "/"));
      var origin = hostOrigin(res.url);
      if (origin && blocked[origin]) continue; // already known unusable
      if (isCloudflareChallenge(res)) {
        if (origin) blocked[origin] = true;
        console.log("aniworld: Doodstream mirror blocked by Cloudflare: " + (origin || candidates[i]));
        continue;
      }
      if (!/pass_md5/.test(res.body || "")) continue;
      return res;
    }
    return null;
  }

  /** Replays the player handshake: pass_md5 -> 10 random chars + token + expiry. */
  async function doodHandshake(embed, label) {
    var html = embed.body || "";
    var origin = hostOrigin(embed.url);
    var passPath =
      firstMatch(html, /["'](\/pass_md5\/[^"']+)["']/) || firstMatch(html, /(\/pass_md5\/[^\s"'<>]+)/);
    if (!passPath) return null;

    // The token is the last segment of the pass_md5 path (occasionally in the page).
    var token = firstMatch(html, /[?&]token=([A-Za-z0-9]+)/) || passPath.split("/").filter(Boolean).pop();
    if (!token) return null;

    var pass = await httpGet(
      origin + passPath,
      {
        "User-Agent": DESKTOP_UA,
        "Accept": "*/*",
        "Referer": embed.url,
        "X-Requested-With": "XMLHttpRequest"
      },
      { nocache: true }
    );

    var prefix = String(pass.body || "").trim();
    if (!/^https?:\/\//i.test(prefix)) {
      console.log("aniworld: Doodstream pass_md5 refused: " + prefix.slice(0, 40));
      return null;
    }

    var link = prefix + randomString(10) + "?token=" + token + "&expiry=" + Date.now();
    var check = await httpGet(
      link,
      { "User-Agent": DESKTOP_UA, "Accept": "*/*", "Referer": origin + "/", "Range": "bytes=0-15" },
      { nocache: true }
    );
    if (check.status !== 200 && check.status !== 206) {
      console.log("aniworld: Doodstream CDN link rejected (status " + check.status + ")");
      return null;
    }

    var title = stripTags(firstMatch(html, /<title>([^<]*)/));
    return buildStream(link, label, qualityFrom(title) || "Auto", origin + "/");
  }

  async function extractDoodstream(page, label) {
    var code = doodFileCode(page.url);
    if (!code) return [];

    var usable = !isCloudflareChallenge(page) && /pass_md5/.test(page.body || "");
    var embed = usable ? page : await resolveDoodEmbed(code);
    if (!embed) return [];

    var stream = await doodHandshake(embed, label);
    if (stream) return [stream];

    // Tokens are single use; one retry with a freshly fetched embed page.
    var fresh = await httpGet(embed.url, headersFor(base() + "/"), { nocache: true });
    if (!fresh.body || isCloudflareChallenge(fresh)) return [];
    stream = await doodHandshake(fresh, label);
    return stream ? [stream] : [];
  }

  async function extractFromHoster(hosterName, page, streamLabel) {
    var name = String(hosterName || "").toLowerCase();
    if (name.indexOf("voe") !== -1) return extractVoe(page, streamLabel);
    if (name.indexOf("vidmoly") !== -1) return extractVidmoly(page, streamLabel);
    if (name.indexOf("filemoon") !== -1) return extractFilemoon(page, streamLabel);
    if (name.indexOf("dood") !== -1) return extractDoodstream(page, streamLabel);
    return [];
  }

  // --------------------------------------------------------------- handlers ---

  async function getHome(cb) {
    try {
      var root = base();
      var sections = [
        { title: "Trending", path: "/beliebte-animes", limit: 24 },
        { title: "Neue Animes", path: "/neu", limit: 24 },
        { title: "Deutsch (Dub)", path: "/genre/ger", limit: 20 },
        { title: "GerSub", path: "/genre/gersub", limit: 20 },
        { title: "EngSub", path: "/genre/engsub", limit: 20 }
      ];

      var results = await mapLimit(sections, 3, async function (section) {
        var page = await httpGet(root + section.path, headersFor(root + "/"));
        if (!page.body) return null;
        var items = parseCards(page.body, section.limit);
        return items.length ? { title: section.title, items: items } : null;
      });

      var home = {};
      for (var i = 0; i < results.length; i++) {
        if (results[i]) home[results[i].title] = results[i].items;
      }
      if (!Object.keys(home).length) {
        return cb({
          success: false,
          errorCode: "SITE_OFFLINE",
          message: "AniWorld did not return any content. The site may be blocking requests or the domain changed."
        });
      }
      cb({ success: true, data: home });
    } catch (e) {
      cb({ success: false, errorCode: "PARSE_ERROR", message: String(e) });
    }
  }

  var catalogCache = null;

  async function loadCatalog() {
    if (catalogCache && Date.now() - catalogCache.at < 600000) return catalogCache.items;
    var page = await httpGet(base() + "/animes", headersFor(base() + "/"));
    var items = [];
    if (page.body) {
      var liRe = /<a[^>]*data-alternative-title="([^"]*)"[^>]*href="(\/anime\/stream\/[^"\/]+)"[^>]*>([\s\S]*?)<\/a>/g;
      var m;
      while ((m = liRe.exec(page.body)) !== null) {
        items.push({
          title: stripTags(m[3]),
          alt: decodeEntities(m[1]),
          url: abs(m[2])
        });
      }
    }
    catalogCache = { at: Date.now(), items: items };
    return items;
  }

  async function search(query, cb) {
    try {
      var q = String(query || "").trim();
      if (!q) return cb({ success: true, data: [] });

      var hits = [];
      var res = await postForm(base() + "/ajax/search", { keyword: q });
      if (res.body) {
        try {
          var parsed = JSON.parse(res.body);
          if (Array.isArray(parsed)) {
            var bySlug = {};
            var order = [];
            for (var i = 0; i < parsed.length; i++) {
              var entry = parsed[i];
              if (!entry || !entry.link) continue;

              var link = String(entry.link);
              var slugMatch = /\/anime\/stream\/([^\/?#]+)/.exec(link);
              if (!slugMatch) continue;
              var slug = slugMatch[1];
              var isEpisode = /\/(?:staffel-\d+|filme)\//.test(link);
              var title = isEpisode ? titleFromSlug(slug) : stripTags(entry.title);

              if (bySlug[slug]) {
                // Prefer the series entry over episode hits for the same show.
                if (bySlug[slug].isEpisode && !isEpisode) {
                  bySlug[slug].isEpisode = false;
                  bySlug[slug].title = title;
                }
                continue;
              }
              bySlug[slug] = {
                title: title,
                url: base() + "/anime/stream/" + slug,
                description: stripTags(entry.description),
                isEpisode: isEpisode
              };
              order.push(slug);
              if (order.length >= 12) break;
            }
            hits = order.map(function (key) {
              return bySlug[key];
            });
          }
        } catch (e) {
          console.log("aniworld: search JSON parse failed");
        }
      }

      // Fallback: filter the A-Z catalog by title or alternative titles.
      if (!hits.length) {
        var catalog = await loadCatalog();
        var needle = q.toLowerCase();
        for (var c = 0; c < catalog.length && hits.length < 30; c++) {
          var entry2 = catalog[c];
          if (
            entry2.title.toLowerCase().indexOf(needle) !== -1 ||
            (entry2.alt && entry2.alt.toLowerCase().indexOf(needle) !== -1)
          ) {
            hits.push({ title: entry2.title, url: entry2.url, description: "" });
          }
        }
      }

      // Search hits carry no artwork, so pull it from the series pages (small cap).
      var enrich = hits.slice(0, 6);
      await mapLimit(enrich, 3, async function (hit) {
        var page = await timeout(httpGet(hit.url, headersFor(base() + "/")), 9000);
        if (!page || !page.body) return;
        var meta = parseSeriesMeta(page.body, hit.url);
        hit.posterUrl = meta.item.posterUrl || "";
        hit.year = meta.item.year;
        if (meta.item.title) hit.title = meta.item.title;
        if (!hit.description) hit.description = meta.item.description;
      });

      var items = hits.map(function (hit) {
        return new MultimediaItem({
          title: hit.title,
          url: hit.url,
          posterUrl: hit.posterUrl || "",
          type: "anime",
          year: hit.year || undefined,
          description: hit.description || ""
        });
      });

      cb({ success: true, data: items });
    } catch (e) {
      cb({ success: false, errorCode: "PARSE_ERROR", message: String(e) });
    }
  }

  async function load(url, cb) {
    try {
      if (!url) return cb({ success: false, errorCode: "NOT_FOUND", message: "No URL given" });

      var seriesUrl = String(url).replace(/\/+$/, "");
      // If an episode or film URL was passed, work with its series page instead.
      seriesUrl = seriesUrl.replace(/\/(?:staffel-\d+|filme)(?:\/(?:episode|film)-\d+)?$/, "");

      var page = await httpGet(seriesUrl, headersFor(base() + "/"));
      if (!page.body) {
        return cb({
          success: false,
          errorCode: "SITE_OFFLINE",
          message: "Could not load " + seriesUrl
        });
      }

      var meta = parseSeriesMeta(page.body, seriesUrl);
      var item = meta.item;
      if (meta.genres.length) {
        item.description = (item.description ? item.description + "\n\n" : "") + "Genres: " + meta.genres.join(", ");
      }

      var seasons = meta.seasons.slice(0, MAX_SEASONS);
      var targets = seasons.map(function (n) {
        return { season: n, url: seriesUrl + "/staffel-" + n };
      });
      if (meta.hasFilms) targets.push({ season: 0, url: seriesUrl + "/filme" });
      if (!targets.length) targets.push({ season: 1, url: seriesUrl });

      var pages = await mapLimit(targets, 4, async function (target) {
        var p = await timeout(httpGet(target.url, headersFor(seriesUrl + "/")), 20000);
        if (!p || !p.body) return null;
        return { season: target.season, episodes: parseEpisodeRows(p.body, target.season) };
      });

      var episodes = [];
      for (var i = 0; i < pages.length; i++) {
        if (pages[i] && pages[i].episodes.length) episodes = episodes.concat(pages[i].episodes);
      }

      // Films use season 0; keep them after the numbered seasons.
      episodes.sort(function (a, b) {
        var seasonA = a.season === 0 ? 9999 : a.season;
        var seasonB = b.season === 0 ? 9999 : b.season;
        if (seasonA !== seasonB) return seasonA - seasonB;
        return a.episode - b.episode;
      });

      item.episodes = episodes;
      cb({ success: true, data: item });
    } catch (e) {
      cb({ success: false, errorCode: "PARSE_ERROR", message: String(e) });
    }
  }

  var LANG_FALLBACK = { "1": "Ger Dub", "2": "Eng Sub", "3": "Ger Sub" };

  function parseLanguages(html) {
    var map = {};
    var re = /data-lang-key="(\d+)"[^>]*title="([^"]+)"/g;
    var m;
    while ((m = re.exec(html)) !== null) {
      var name = stripTags(m[2]);
      if (name && !map[m[1]]) map[m[1]] = name;
    }
    var re2 = /title="([^"]+)"[^>]*data-lang-key="(\d+)"/g;
    while ((m = re2.exec(html)) !== null) {
      var name2 = stripTags(m[1]);
      if (name2 && !map[m[2]]) map[m[2]] = name2;
    }
    return map;
  }

  function parseHosterLinks(html) {
    var links = [];
    var liRe = /<li class="[^"]*episodeLink\d+[^"]*"([^>]*)>([\s\S]*?)<\/li>/g;
    var m;
    while ((m = liRe.exec(html)) !== null) {
      var attrs = m[1];
      var body = m[2];
      var target = firstMatch(attrs, /data-link-target="([^"]+)"/);
      if (!target) continue;
      var langKey = firstMatch(attrs, /data-lang-key="(\d+)"/) || "1";
      var hoster =
        stripTags(firstMatch(body, /<h4[^>]*>([\s\S]*?)<\/h4>/)) ||
        firstMatch(body, /<i class="icon ([^"]+)"/);
      if (!hoster) continue;
      links.push({ langKey: langKey, target: target, hoster: hoster });
    }
    return links;
  }

  var HOSTER_RANK = { voe: 0, vidmoly: 1, filemoon: 2, dood: 3 };

  function hosterRank(name) {
    var lower = String(name || "").toLowerCase();
    var keys = Object.keys(HOSTER_RANK);
    for (var i = 0; i < keys.length; i++) {
      if (lower.indexOf(keys[i]) !== -1) return HOSTER_RANK[keys[i]];
    }
    return 9;
  }

  async function loadStreams(url, cb) {
    var started = Date.now();
    try {
      if (!url) return cb({ success: false, errorCode: "NOT_FOUND", message: "No URL given" });

      var episodeUrl = String(url);
      var page = await httpGet(episodeUrl, headersFor(base() + "/"));
      if (!page.body) {
        return cb({
          success: false,
          errorCode: "SITE_OFFLINE",
          message: "Could not load the episode page. The site may be blocking requests."
        });
      }

      var parsedLanguages = parseLanguages(page.body);
      var langMap = Object.assign({}, LANG_FALLBACK);
      Object.keys(parsedLanguages).forEach(function (key) {
        langMap[key] = normalizeLanguage(parsedLanguages[key]) || LANG_FALLBACK[key] || "Ger Dub";
      });
      var links = parseHosterLinks(page.body);
      if (!links.length) {
        return cb({
          success: false,
          errorCode: "NO_STREAMS",
          message: "AniWorld lists no hosters for this episode yet."
        });
      }

      // Keep every language represented, preferring hosters that resolve reliably.
      var sorted = links
        .map(function (link, index) {
          return Object.assign({}, link, { index: index });
        })
        .sort(function (a, b) {
          var langDelta = parseInt(a.langKey, 10) - parseInt(b.langKey, 10);
          if (langDelta !== 0) return langDelta;
          var rankDelta = hosterRank(a.hoster) - hosterRank(b.hoster);
          if (rankDelta !== 0) return rankDelta;
          return a.index - b.index;
        });

      // Cap per language so a fourth hoster never pushes a language out entirely.
      var perLanguage = {};
      var ordered = [];
      for (var i = 0; i < sorted.length && ordered.length < MAX_STREAM_LINKS; i++) {
        var used = perLanguage[sorted[i].langKey] || 0;
        if (used >= 4) continue;
        perLanguage[sorted[i].langKey] = used + 1;
        ordered.push(sorted[i]);
      }

      var seen = {};
      var streams = [];

      await mapLimit(ordered, 3, async function (link) {
        if (Date.now() - started > LINK_BUDGET_MS) return;
        var langLabel = langMap[link.langKey] || LANG_FALLBACK[link.langKey] || "Deutsch";
        var streamLabel = link.hoster + " · " + langLabel;
        try {
          var resolved = await timeout(
            httpGet(abs(link.target), headersFor(episodeUrl)),
            15000
          );
          if (!resolved || !resolved.body) return;

          // Each extractor decides what a challenge page means for it.
          var found = await timeout(
            extractFromHoster(link.hoster, resolved, streamLabel),
            15000
          );
          if (!found || !found.length) return;
          for (var i = 0; i < found.length; i++) {
            var stream = found[i];
            if (!stream || !stream.url || seen[stream.url]) continue;
            seen[stream.url] = true;
            streams.push(stream);
          }
          console.log("aniworld: " + streamLabel + " -> " + found.length + " stream(s)");
        } catch (e) {
          console.log("aniworld: " + streamLabel + " failed: " + e);
        }
      });

      if (!streams.length) {
        return cb({
          success: false,
          errorCode: "NO_STREAMS",
          message:
            "No playable source found. Tried " +
            ordered
              .map(function (l) {
                return l.hoster;
              })
              .filter(function (v, i, arr) {
                return arr.indexOf(v) === i;
              })
              .join(", ") +
            ". VOE and Vidmoly are usually available; the others may be behind a bot check."
        });
      }

      cb({ success: true, data: streams });
    } catch (e) {
      cb({ success: false, errorCode: "PARSE_ERROR", message: String(e) });
    }
  }

  globalThis.getHome = getHome;
  globalThis.search = search;
  globalThis.load = load;
  globalThis.loadStreams = loadStreams;
})();
