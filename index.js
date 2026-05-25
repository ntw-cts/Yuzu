const express = require('express');
const cors = require('cors');
const AnimePahe = require('./lib/animepahe');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files from public directory
app.use(express.static('public'));

// Create AnimePahe instance
const pahe = new AnimePahe();

function mapErrorToStatusCode(message) {
  const text = String(message || '').toLowerCase();
  if (text.includes('not found')) return 404;
  if (text.includes('blocked') || text.includes('anti-bot')) return 503;
  if (text.includes('forbidden')) return 403;
  return 500;
}

// Routes
app.get('/', (req, res) => {
  res.sendFile('index.html', { root: 'public' });
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
    if (!q) {
      return res.status(400).json({ error: 'Query parameter "q" is required' });
    }
    const results = await pahe.search(q);
    res.json(results);
  } catch (error) {
    console.error('Search error:', error);
    res.status(mapErrorToStatusCode(error.message)).json({ error: error.message });
  }
});

app.get('/episodes', async (req, res) => {
  try {
    const { session } = req.query;
    if (!session) {
      return res.status(400).json({ error: 'Query parameter "session" is required' });
    }
    const episodes = await pahe.getEpisodes(session);
    res.json(episodes);
  } catch (error) {
    console.error('Episodes error:', error);
    res.status(mapErrorToStatusCode(error.message)).json({ error: error.message });
  }
});

app.get('/latest', async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const latest = await pahe.getLatest(page);
    res.json(latest);
  } catch (error) {
    console.error('Latest error:', error);
    res.status(mapErrorToStatusCode(error.message)).json({ error: error.message });
  }
});

app.get('/sources', async (req, res) => {
  try {
    const { anime_session, episode_session } = req.query;
    if (!anime_session || !episode_session) {
      return res.status(400).json({
        error: 'Query parameters "anime_session" and "episode_session" are required'
      });
    }
    const sources = await pahe.getSources(anime_session, episode_session);
    res.json(sources);
  } catch (error) {
    console.error('Sources error:', error);
    res.status(mapErrorToStatusCode(error.message)).json({ error: error.message });
  }
});

app.get('/ids', async (req, res) => {
  try {
    const { session } = req.query;
    if (!session) {
      return res.status(400).json({ error: 'Query parameter "session" is required' });
    }
    const ids = await pahe.getIds(session);
    res.json(ids);
  } catch (error) {
    console.error('IDs error:', error);
    res.status(mapErrorToStatusCode(error.message)).json({ error: error.message });
  }
});

app.get('/m3u8', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) {
      return res.status(400).json({ error: 'Query parameter "url" is required' });
    }
    const result = await pahe.resolveKwikWithNode(url);

    // Return m3u8 URL along with required referer for CORS bypass
    res.json({
      m3u8: result.m3u8,
      referer: result.referer,
      headers: {
        'Referer': result.referer,
        'Origin': result.origin
      },
      proxy_url: `https://yellow-bar-9083.ntw-cts.workers.dev/proxy?url=${encodeURIComponent(result.m3u8)}&referer=${encodeURIComponent(result.referer)}`
    });
  } catch (error) {
    console.error('M3U8 resolution error:', error);
    res.status(mapErrorToStatusCode(error.message)).json({ error: error.message });
  }
});

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
        return res.status(500).json({ error: 'Failed to resolve Kwik URL', details: e.message });
      }
    }

    const referer = customReferer || 'https://kwik.cx/';
    let origin = 'https://kwik.cx';
    try { origin = new URL(referer).origin; } catch (_) {}

    // Use undici (Node 18+ built-in) for real HTTP/2 + browser-like TLS fingerprint
    // This is what lets us pass Cloudflare — axios uses HTTP/1.1 which CF flags.
    const { fetch: undiciFetch } = require('undici');

    const response = await undiciFetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': referer,
        'Origin': origin,
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site',
        'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
      },
      redirect: 'follow',
    });

    console.log(`[proxy] ${response.status} ${url.slice(0, 80)}`);

    if (!response.ok) {
      return res.status(response.status).json({
        error: `CDN returned ${response.status}`,
        url: url.slice(0, 120),
        referer,
      });
    }

    const contentType = response.headers.get('content-type') ||
      (url.includes('.m3u8') ? 'application/vnd.apple.mpegurl' :
       url.includes('.ts')   ? 'video/mp2t' : 'application/octet-stream');

    res.setHeader('Access-Control-Allow-Origin', '*');

    if (contentType.includes('mpegurl') || url.includes('.m3u8')) {
      const text = await response.text();
      const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
      const refererParam = `&referer=${encodeURIComponent(referer)}`;

      const modified = text.split('\n').map(line => {
        const t = line.trim();
        if (!t) return line;
        if (t.startsWith('#')) {
          if (t.includes('URI="')) {
            return t.replace(/URI="([^"]+)"/, (_, uri) => {
              const fullUrl = uri.startsWith('http') ? uri : baseUrl + uri;
              return `URI="/proxy?url=${encodeURIComponent(fullUrl)}${refererParam}"`;
            });
          }
          return line;
        }
        const fullUrl = t.startsWith('http') ? t : baseUrl + t;
        return `/proxy?url=${encodeURIComponent(fullUrl)}${refererParam}`;
      }).join('\n');

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.send(modified);
    } else {
      res.setHeader('Content-Type', contentType);
      const cl = response.headers.get('content-length');
      if (cl) res.setHeader('Content-Length', cl);
      // Stream binary content (ts segments, key files)
      const { Readable } = require('stream');
      Readable.fromWeb(response.body).pipe(res);
    }
  } catch (error) {
    console.error('[proxy] exception:', error.message, '| url:', req.query.url?.slice(0, 100));
    if (!res.headersSent) res.status(500).json({ error: error.message });
  }
});

// Handle OPTIONS for CORS preflight
app.options('/proxy', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.sendStatus(200);
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message
  });
});

// Export for Vercel
module.exports = app;

// Start server if not in Vercel environment
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Animepahe API server running on port ${PORT}`);
  });
      }
