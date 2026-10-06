// `rangeplay headers <target>`: the response headers the runtime needs, as configuration for common hosts.
//
// Pages and scripts: cross-origin isolation (COOP + COEP) so SharedArrayBuffer works.
// Content-addressed objects (data/xx/<hash>): cached forever, served as raw bytes, never re-encoded (a CDN that
// compresses on the fly breaks byte ranges).

export const TARGETS = ['cloudflare', 'netlify', 'nginx', 'caddy', 'vercel'];

// dataPrefix: the URL path of the directory holding manifest.json (the objects are under <dataPrefix>data/).
export function headersFor(target, { dataPrefix = '/' } = {}) {
  const p = dataPrefix.endsWith('/') ? dataPrefix : dataPrefix + '/';
  switch (target) {
    case 'cloudflare':
    case 'netlify':
      return `# _headers (Cloudflare Pages / Netlify). With Cloudflare in front of another host, use a Response Header
# Transform Rule for the same headers and a Cache Rule "cache everything, edge TTL 1 year" for the objects.
/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  Cross-Origin-Resource-Policy: same-origin

${p}data/*
  Cache-Control: public, max-age=31536000, immutable
  Content-Type: application/octet-stream
`;
    case 'nginx':
      return `# nginx: inside the server block
add_header Cross-Origin-Opener-Policy same-origin always;
add_header Cross-Origin-Embedder-Policy require-corp always;
add_header Cross-Origin-Resource-Policy same-origin always;
# .wasm must be served as application/wasm: recent mime.types files include it. (A "types { }" block here would
# replace the whole MIME table, so add the line to mime.types instead if yours lacks it.)

# content-addressed objects: immutable, raw bytes (nginx serves ranges of static files by itself)
location ~ ^${p}data/[0-9a-f]{2}/[0-9a-f]{32}$ {
  default_type application/octet-stream;
  gzip off;
  add_header Cache-Control "public, max-age=31536000, immutable" always;
  add_header Cross-Origin-Opener-Policy same-origin always;
  add_header Cross-Origin-Embedder-Policy require-corp always;
  add_header Cross-Origin-Resource-Policy same-origin always;
}
`;
    case 'caddy':
      return `# Caddyfile: inside the site block
header {
  Cross-Origin-Opener-Policy same-origin
  Cross-Origin-Embedder-Policy require-corp
  Cross-Origin-Resource-Policy same-origin
}
@objects path_regexp ^${p}data/[0-9a-f]{2}/[0-9a-f]{32}$
header @objects Cache-Control "public, max-age=31536000, immutable"
header @objects Content-Type application/octet-stream
file_server
`;
    case 'vercel':
      return JSON.stringify({
        headers: [
          { source: '/(.*)', headers: [
            { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
            { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
            { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
          ] },
          { source: `${p}data/(.*)`, headers: [
            { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
            { key: 'Content-Type', value: 'application/octet-stream' },
          ] },
        ],
      }, null, 2) + '\n';
    default:
      throw new Error('unknown target "' + target + '" (one of: ' + TARGETS.join(', ') + ')');
  }
}
