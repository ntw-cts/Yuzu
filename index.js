const express = require('express');
const cors = require('cors');
const axios = require('axios');
const AnimePahe = require('./lib/animepahe');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const pahe = new AnimePahe();

function mapErrorToStatusCode(message) {
  const text = String(message || '').toLowerCase();
  if (text.includes('not found')) return 404;
  if (text.includes('blocked') || text.includes('anti-bot')) return 503;
  if (text.includes('forbidden')) return 403;
  return 500;
}

app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to Animepahe API',
    endpoints: {
      search: '/search?q=naruto',
      episodes: '/episodes?session=anime-session-id',
      latest: '/latest?page=1',
      sources: '/sources?anime_session=xxx&episode_session=yyy',
      ids: '/ids?session=anime-session-id',
      m3u8: '/m3u8?url=kwik-url',
      proxy: '/proxy?url=m3u8-or-ts-url&referer=kwik-referer',
      health: '/health'
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Animepahe API is alive!' });
});

app.get('/watch', (req, res) => {
  res.sendFile('player.html', { root: 'public' });
});

app.get('/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ error: 'Query parameter "q" is required' });
    res.json(await pahe.search(q));
  } catch (error) {
    console.error('Search error:', error);
    res.status(mapErrorToStatusCode(error.message)).json({ error: error.message });
  }
});

app.get('/episodes', async (req, res) => {
  try {
    const { session } = req.query;
    if (!session) return res.status(400).json({ error: 'Query parameter "session" is required' });
    res.json(await pahe.getEpisodes(session));
  } catch (error) {
    console.error('Episodes error:', error);
    res.status(mapErrorToStatusCode(error.message)).json({ error: error.message });
  }
});

app.get('/latest', async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    res.json(await pahe.getLatest(page));
  } catch (error) {
    console.error('Latest error:', error);
    res.status(mapErrorToStatusCode(error.message)).json({ error: error.message });
  }
});

app.get('/sources', async (req, res) => {
  try {
    const { anime_session, episode_session } = req.query;
    if (!anime_session || !episode_session) {
      return res.status(400).json({ error: 'Query parameters "anime_session" and "episode_session" are required' });
    }
    res.json(await pahe.getSources(anime_session, episode_session));
  } catch (error) {
    console.error('Sources error:', error);
    res.status(mapErrorToStatusCode(error.message)).json({ error: error.message });
  }
});

app.get('/ids', async (req, res) => {
  try {
    const { session } = req.query;
    if (!session) return res.status(400).json({ error: 'Query parameter "session" is required' });
    res.json(await pahe.getIds(session));
  } catch (error) {
    console.error('IDs error:', error);
    res.status(mapErrorToStatusCode(error.message)).json({ error: error.message });
  }
});

app.get('/m3u8', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Query parameter "url" is required' });
    const result = await pahe.resolveKwikWithNode(url);
    res.json({
      m3u8: result.m3u8,
      referer: result.referer,
      headers: { 'Referer': result.referer, 'Origin': result.origin },
      proxy_url: `/proxy?url=${encodeURIComponent(result.m3u8)}&referer=${encodeURIComponent(result.referer)}`
    });
  } catch (error) {
    console.error('M3U8 resolution error:', error);
    res.status(mapErrorToStatusCode(error.message)).json({ error: error.message });
  }
});

// ── Helper: build CDN-compatible headers ─────────────────────────────────────
function makeCdnHeaders(referer) {
  // owocdn.top requires Referer pointing to kwik.cx — use what was passed, or default to kwik root
  const ref = referer || 'https://kwik.cx/';
  let origin = 'https://kwik.cx';
  try { origin = new URL(ref).origin; } catch (_) {}
  return {
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer':         ref,
    'Origin':          origin,
    'Accept':          '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Connection':      'keep-alive',
  };
}

app.get('/proxy', async (req, res) => {
  try {
    const { url, referer: customReferer } = req.query;
    if (!url) {
      return res.status(400).json({ error: 'Query parameter "url" is required' });
    }

    // Auto-resolve kwik embed pages
    if (url.includes('kwik.cx/e/') || url.includes('kwik.si/e/') || url.match(/kwik\.[a-z]+\/e\//)) {
      try {
        const result = await pahe.resolveKwikWithNode(url);
        return res.redirect(302, `/proxy?url=${encodeURIComponent(result.m3u8)}&referer=${encodeURIComponent(result.referer)}`);
      } catch (e) {
        console.error('Failed to auto-resolve Kwik URL:', e);
        return res.status(500).json({ error: 'Failed to resolve Kwik URL', details: e.message });
      }
    }

    const headers = makeCdnHeaders(customReferer);

    const response = await axios.get(url, {
      headers,
      responseType: 'stream',
      timeout: 30000,
      maxRedirects: 5,
      // Don't throw on 4xx — let us handle and forward status properly
      validateStatus: () => true,
    });

    console.log(`[proxy] ${response.status} ${url.slice(0, 80)}`);

    // Forward non-200 statuses so the browser sees the real error code
    if (response.status !== 200) {
      // Drain the stream to free the socket
      response.data.resume();
      return res.status(response.status).json({
        error: `CDN returned ${response.status}`,
        url: url.slice(0, 120),
        referer: headers['Referer'],
        origin: headers['Origin'],
      });
    }

    const contentType = response.headers['content-type'] ||
      (url.includes('.m3u8') ? 'application/vnd.apple.mpegurl' :
       url.includes('.ts')   ? 'video/mp2t'                    :
       url.includes('.key')  ? 'application/octet-stream'      : 'application/octet-stream');

    // M3U8 playlists: rewrite all URIs through /proxy with referer baked in
    if (contentType.includes('mpegurl') || url.includes('.m3u8')) {
      let content = '';
      response.data.on('data', chunk => { content += chunk.toString(); });
      response.data.on('end', () => {
        const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
        const refererParam = `&referer=${encodeURIComponent(headers['Referer'])}`;

        const modified = content.split('\n').map(line => {
          const t = line.trim();
          if (!t) return line;

          if (t.startsWith('#')) {
            // Rewrite EXT-X-KEY URI so encryption keys also go through proxy
            if (t.includes('URI="')) {
              return t.replace(/URI="([^"]+)"/, (_, uri) => {
                const fullUrl = uri.startsWith('http') ? uri : baseUrl + uri;
                return `URI="/proxy?url=${encodeURIComponent(fullUrl)}${refererParam}"`;
              });
            }
            return line;
          }

          // Segment / sub-playlist lines
          const fullUrl = t.startsWith('http') ? t : baseUrl + t;
          return `/proxy?url=${encodeURIComponent(fullUrl)}${refererParam}`;
        }).join('\n');

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.send(modified);
      });

    } else {
      // Binary: ts segments, key files, etc. — stream straight through
      res.setHeader('Content-Type', contentType);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Accept-Ranges', 'bytes');
      if (response.headers['content-length']) res.setHeader('Content-Length', response.headers['content-length']);
      if (response.headers['content-range'])  res.setHeader('Content-Range',  response.headers['content-range']);
      response.data.pipe(res);
    }

  } catch (error) {
    console.error('[proxy] exception:', error.message, '| url:', req.query.url?.slice(0, 100));
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

app.options('/proxy', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.sendStatus(200);
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Animepahe API server running on port ${PORT}`);
  });
}
