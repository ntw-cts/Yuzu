/**
 * YUZU — Cloudflare Worker proxy
 * Deploy this as a Cloudflare Worker (e.g. yuzu-proxy.your-name.workers.dev)
 *
 * It proxies requests to owocdn.top (and any kwik CDN) with the correct
 * Referer header. Because Workers run on Cloudflare's own edge network,
 * owocdn's Cloudflare protection trusts them.
 *
 * Usage from your player:
 *   https://yuzu-proxy.YOUR_NAME.workers.dev/proxy?url=<encoded-url>&referer=<encoded-referer>
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        },
      });
    }

    if (url.pathname !== '/proxy') {
      return new Response(JSON.stringify({ error: 'Use /proxy?url=...&referer=...' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const targetUrl = url.searchParams.get('url');
    const referer   = url.searchParams.get('referer') || 'https://kwik.cx/';

    if (!targetUrl) {
      return new Response(JSON.stringify({ error: 'Missing url param' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    let origin = 'https://kwik.cx';
    try { origin = new URL(referer).origin; } catch (_) {}

    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer':         referer,
        'Origin':          origin,
        'Accept':          '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Fetch-Dest':  'empty',
        'Sec-Fetch-Mode':  'cors',
        'Sec-Fetch-Site':  'cross-site',
      },
    });

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const isM3u8 = contentType.includes('mpegurl') || targetUrl.includes('.m3u8');

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    };

    if (!response.ok) {
      return new Response(JSON.stringify({ error: `CDN returned ${response.status}` }), {
        status: response.status,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    if (isM3u8) {
      const text = await response.text();
      const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
      const workerBase = `${url.origin}/proxy`;
      const refParam = `&referer=${encodeURIComponent(referer)}`;

      const modified = text.split('\n').map(line => {
        const t = line.trim();
        if (!t) return line;
        if (t.startsWith('#')) {
          if (t.includes('URI="')) {
            return t.replace(/URI="([^"]+)"/, (_, uri) => {
              const full = uri.startsWith('http') ? uri : baseUrl + uri;
              return `URI="${workerBase}?url=${encodeURIComponent(full)}${refParam}"`;
            });
          }
          return line;
        }
        const full = t.startsWith('http') ? t : baseUrl + t;
        return `${workerBase}?url=${encodeURIComponent(full)}${refParam}`;
      }).join('\n');

      return new Response(modified, {
        headers: { 'Content-Type': 'application/vnd.apple.mpegurl', ...corsHeaders },
      });
    }

    // Binary passthrough (ts segments, key files)
    return new Response(response.body, {
      headers: { 'Content-Type': contentType, ...corsHeaders },
    });
  },
};
