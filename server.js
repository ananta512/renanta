/**
 * server.js – WebSocket-to-TCP proxy for browser-based miners
 * CommonJS version (uses require) so it runs without `"type":"module"`.
 * listens on process.env.PORT (Render/Heroku) or 8080 locally.
 *
 * Usage from a miner:
 *   const target   = 'power2b.na.mine.zpool.ca:6242';
 *   const b64      = btoa(target);  // "cG93ZXIyYi5uYS5t..."
 *   const wsUrl    = `wss://proxy.example.com/${b64}`;
 *   connect(wsUrl);
 */

const http      = require('http');
const net       = require('net');
const WebSocket = require('ws');
const { Buffer } = require('buffer');

// ----------------- configuration -----------------
const LISTEN_PORT = process.env.PORT || 8080;   // Render/Heroku inject PORT
const KEEPALIVE_MS = 15_000;                    // WebSocket ping interval
// -------------------------------------------------

// Tiny HTTP surface so browser GET / returns 200 (helps Render health-check)
const httpServer = http.createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Mining proxy online\n');
});
httpServer.listen(LISTEN_PORT, '0.0.0.0', () =>
  console.log(`[proxy] listening on ${LISTEN_PORT}`)
);

// WebSocket server – disable compression (no benefit for small stratum JSON)
const wss = new WebSocket.Server({
  server: httpServer,
  perMessageDeflate: false
});

wss.on('connection', (ws, req) => {
  const urlPath = req.url?.replace('/', '') || '';
  let decoded;
  try {
    decoded = Buffer.from(urlPath, 'base64').toString('utf8'); // host:port
  } catch (_e) {
    ws.close(1008, 'Bad base64 in URL');
    return;
  }
  const [host, portStr] = decoded.split(':');
  const port = Number(portStr);
  if (!host || !port) {
    ws.close(1008, 'URL must encode host:port');
    return;
  }
  console.log(`[proxy] ${req.socket.remoteAddress} → ${host}:${port}`);

  // Open TCP to mining pool
  const tcp = net.connect({ host, port }, () =>
    console.log(`[proxy] TCP connected ${host}:${port}`)
  );

  // Relay WebSocket → TCP (ensure newline)
  ws.on('message', (data) => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    tcp.write(buf.slice(-1)[0] === 0x0a ? buf : Buffer.concat([buf, Buffer.from('\n')]));
  });

  // Relay TCP → WebSocket (as binary) –  trust upstream to send JSON lines
  tcp.on('data', (chunk) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
  });

  // Shared close handler
  const shutdown = (why) => {
    console.log('[proxy] closing –', why);
    tcp.destroy();
    if (ws.readyState === WebSocket.OPEN) ws.close();
  };
  ws .on('close', ()       => shutdown('ws closed'));
  ws .on('error', (e)      => shutdown('ws error '   + e.code));
  tcp.on('close', ()       => shutdown('tcp closed'));
  tcp.on('error', (e)      => shutdown('tcp error '  + e.code));

  // Keep-alive pings so Render/Heroku/Koyeb won’t idle the socket
  const ka = setInterval(() => ws.ping(), KEEPALIVE_MS);
  ws.on('close', () => clearInterval(ka));
});
// after tcp connects
tcp.on('data', (chunk) => {
  console.log('[POOL]', chunk.toString().trim());   // ① pool → proxy
  if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
});

ws.on('message', (data) => {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  console.log('[MINER]', buf.toString().trim());    // ② miner → proxy
  // …
});
