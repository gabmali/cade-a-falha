import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { audit } from './lib/audit.mjs';
import { AddressError, parseAddress } from './lib/network.mjs';

const port = Number(process.env.PORT ?? 4173);
const host = '127.0.0.1';
const assets = new Map(await Promise.all([
  ['/', 'index.html', 'text/html'],
  ['/app.js', 'app.js', 'text/javascript'],
  ['/styles.css', 'styles.css', 'text/css'],
  ['/favicon.svg', 'favicon.svg', 'image/svg+xml'],
  ['/detetive.svg', 'detetive.svg', 'image/svg+xml'],
].map(async ([path, filename, mime]) => [
  path, { content: await readFile(new URL(`./public/${filename}`, import.meta.url)), mime },
])));

let active = 0;
const MAX_ACTIVE = 2;
const MAX_INPUT = 12_288;

function json(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(data));
}

async function readInput(request) {
  const buffers = [];
  let size = 0;
  // Keep the connection open long enough to return the validation message.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_INPUT) throw new AddressError('O endereço informado é longo demais.');
    buffers.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(buffers).toString('utf8'))?.address;
  } catch {
    throw new AddressError('Digite um endereço válido e tente novamente.');
  }
}

const server = createServer({
  requestTimeout: 10_000,
  headersTimeout: 8_000,
  connectionsCheckingInterval: 1_000,
}, async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'");
  const localPort = server.address().port;
  const allowedHosts = [`${host}:${localPort}`, `localhost:${localPort}`];
  if (!allowedHosts.includes(request.headers.host)) {
    json(response, 403, { error: 'Abra a prévia pelo endereço local indicado no terminal.' });
    return;
  }
  const path = request.url.split('?', 1)[0];
  if (path === '/api/analisar' && request.method === 'POST') {
    if (request.headers['sec-fetch-site'] === 'cross-site' || (request.headers.origin
      && request.headers.origin !== `http://${request.headers.host}`)) {
      json(response, 403, { error: 'Inicie a análise pela página do Cadê a Falha?' });
      return;
    }
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
      json(response, 415, { error: 'A análise espera um endereço no formato JSON.' });
      return;
    }
    if (active >= MAX_ACTIVE) {
      json(response, 429, { error: 'Já há duas análises em andamento. Tente novamente em alguns segundos.' });
      return;
    }
    active++;
    const controller = new AbortController();
    response.once('close', () => controller.abort());
    try {
      const url = parseAddress(await readInput(request));
      json(response, 200, await audit(url, controller.signal));
    } catch (error) {
      if (!response.destroyed) {
        if (error instanceof AddressError) json(response, 400, { error: error.message });
        else {
          console.error(error);
          json(response, 500, { error: 'A análise foi interrompida. Tente novamente em alguns instantes.' });
        }
      }
    } finally {
      active--;
    }
    return;
  }

  const asset = assets.get(path);
  if (asset && ['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(200, { 'Content-Type': `${asset.mime}; charset=utf-8`, 'Content-Length': asset.content.length });
    response.end(request.method === 'HEAD' ? undefined : asset.content);
    return;
  }
  if (path === '/api/analisar') response.setHeader('Allow', 'POST');
  json(response, path === '/api/analisar' ? 405 : 404, { error: 'Rota indisponível.' });
});

server.listen(port, host, () => console.log(`Cadê a Falha? · http://${host}:${server.address().port}`));
