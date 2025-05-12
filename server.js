/**
 * server.js – WebSocket-to-TCP proxy for browser / JS miners
 *
 *  • Each client connects to:   wss://host/<base64(host:port)>
 *  • Proxy decodes host:port, opens a raw TCP socket, and pipes data.
 *  • Incoming TCP data is split on '\n' so every WebSocket TEXT frame
 *    contains exactly one Stratum JSON message.
 *
 * Tested on Node 18+ (CommonJS).  Works on Render, Heroku, Koyeb, Fly.io,
 * or local Windows/Linux.
 */

/* ────────────────── imports ────────────────── */
const http      = require('http');
const net       = require('net');
const WebSocket = require('ws');
const { Buffer } = require('buffer');

/* ────────────────── config ─────────────────── */
const PORT         = process.env.PORT || 8080;   // Render injects PORT
const KEEPALIVE_MS = 15_000;                     // ping interval
/* ───────────────────────────────────────────── */

/* Tiny HTTP endpoint so platform health-checks pass */
const httpServer = http.createServer((_, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Mining proxy online\n');
});
httpServer.listen(PORT, '0.0.0.0', () =>
  console.log(`[proxy] listening on ${PORT}`)
);

/* WebSocket server (compression off) */
const wss = new WebSocket.Server({
  server: httpServer,
  perMessageDeflate: false
});

wss.on('connection', (ws, req) => {
  /* ────────── decode target pool ────────── */
  const path   = req.url?.replace('/', '') || '';
  let decoded;
  try { decoded = Buffer.from(path, 'base64').toString('utf8'); }
  catch { ws.close(1008, 'bad base64'); return; }

  const [host, portStr] = decoded.split(':');
  const port = Number(portStr);
  if (!host || !port) { ws.close(1008, 'need host:port'); return; }

  console.log(`[proxy] ${req.socket.remoteAddress} → ${host}:${port}`);

  /* ────────── open TCP to pool ────────── */
  const tcp = net.connect({ host, port }, () =>
    console.log(`[proxy] TCP connected ${host}:${port}`)
  );

  /* ────────── POOL ➜ WS  (newline-framed) ────────── */
  let rest = '';
  tcp.on('data', chunk => {
    const str   = rest + chunk.toString('utf8');
    const msgs  = str.split('\n');
    rest        = msgs.pop();          // save last (maybe incomplete) part
    msgs.forEach(m => {
      if (!m) return;
      console.log('[POOL ]', m.trim());
      if (ws.readyState === WebSocket.OPEN) ws.send(m);   // TEXT frame
    });
  });
  tcp.on('end', () => { if (rest && ws.readyState === WebSocket.OPEN) ws.send(rest); });

  /* ────────── WS ➜ TCP  (ensure newline) ────────── */
  ws.on('message', data => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    console.log('[MINER]', buf.toString().trim());
    tcp.write(buf.slice(-1)[0] === 0x0a ? buf
                                        : Buffer.concat([buf, Buffer.from('\n')]));
  });

  /* ────────── tidy-up on either side close/error ────────── */
  const closeAll = why => {
    console.log('[proxy] closing –', why);
    tcp.destroy();
    if (ws.readyState === WebSocket.OPEN) ws.close();
  };
  ws .on('close', ()  => closeAll('ws closed'));
  ws .on('error', e   => closeAll('ws error '  + e.code));
  tcp.on('close', ()  => closeAll('tcp closed'));
  tcp.on('error', e   => closeAll('tcp error ' + e.code));

  /* keep-alive pings so the provider doesn’t idle WebSocket */
  const ka = setInterval(() => ws.ping(), KEEPALIVE_MS);
  ws.on('close', () => clearInterval(ka));
});
