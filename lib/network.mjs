import { Resolver } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, SocketAddress } from 'node:net';
import { networkInterfaces } from 'node:os';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

const BODY_LIMIT = 1024 * 1024;
const MAX_REDIRECTS = 4;
const REQUEST_TIMEOUT = 5_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const RESERVED_NAME = /(?:^|\.)(?:localhost|local|localdomain|internal|home|lan|corp|test|invalid|example|onion|alt|home\.arpa)$/i;
const reserved = new BlockList();
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

// IANA special-purpose registries, plus multicast and deprecated 6bone space.
for (const [address, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.31.196.0', 24], ['192.52.193.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['192.175.48.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
]) reserved.addSubnet(address, bits, 'ipv4');

for (const [address, bits] of [
  ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['2620:4f:8000::', 48],
  ['3ffe::', 16], ['3fff::', 20],
]) reserved.addSubnet(address, bits, 'ipv6');

export class AddressError extends Error {}
class BlockedAddress extends AddressError {}

const blockedMessage = 'Endereços locais, privados ou reservados são bloqueados. Use o endereço público do site.';
const invalidMessage = 'Digite um endereço válido, como https://seusite.com.br.';

function hostname(url) {
  return url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

export function isPublicIP(address) {
  const family = isIP(address);
  const type = family === 6 ? 'ipv6' : 'ipv4';
  if (!family || (family === 6 && !globalV6.check(address, type)) || reserved.check(address, type)) {
    return false;
  }
  const canonical = new SocketAddress({ address, family: type }).address;
  return !Object.values(networkInterfaces()).flat().some((entry) => entry.address === canonical);
}

function validateDestination(url) {
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new AddressError('Use um endereço que comece com http:// ou https://.');
  }
  if (url.username || url.password) throw new AddressError('Use um endereço sem usuário ou senha.');

  const host = hostname(url);
  if (RESERVED_NAME.test(host) || (isIP(host) && !isPublicIP(host))) {
    throw new BlockedAddress(blockedMessage);
  }
  if (!isIP(host) && !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host)) {
    throw new AddressError(invalidMessage);
  }
  url.hash = '';
  return url;
}

export function parseAddress(input) {
  if (typeof input !== 'string') throw new AddressError(invalidMessage);
  const address = input.trim();
  if (address.length > 2048) throw new AddressError('O endereço informado é longo demais. Use até 2.048 caracteres.');
  if (!address || /[\s\\\x00-\x1f\x7f]/u.test(address) || address.startsWith('/')) {
    throw new AddressError(invalidMessage);
  }
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(address);
  const looksLikePort = /^(?:[^:/?#]+):\d+(?:[/?#]|$)/.test(address);
  const candidate = hasScheme && !looksLikePort ? address : `https://${address}`;
  if (/^https?:/i.test(candidate) && !/^https?:\/\/[^/]/i.test(candidate)) {
    throw new AddressError(invalidMessage);
  }
  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new AddressError(invalidMessage);
  }
  return validateDestination(url);
}

async function resolvePublic(host, signal) {
  signal.throwIfAborted();
  const family = isIP(host);
  if (family) return [{ address: host, family }];

  const resolver = new Resolver({ timeout: 1400, tries: 2 });
  const cancel = () => resolver.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    // The trailing dot keeps the resolver from applying a local search suffix.
    const name = `${host}.`;
    const answers = await Promise.allSettled([resolver.resolve4(name), resolver.resolve6(name)]);
    signal.throwIfAborted();
    const records = answers.flatMap((result, index) => result.status === 'fulfilled'
      ? result.value.map((address) => ({ address, family: index ? 6 : 4 }))
      : []);
    if (records.some(({ address }) => !isPublicIP(address))) throw new BlockedAddress(blockedMessage);
    if (!records.length) throw new Error('Não foi possível encontrar o domínio no DNS.');
    return records;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

function sizeGuard() {
  let size = 0;
  return new Transform({
    transform(chunk, _, done) {
      size += chunk.length;
      if (size > BODY_LIMIT) done(new Error('O HTML ultrapassou o limite de 1 MB da análise.'));
      else done(null, chunk);
    },
  });
}

async function readHTML(response, signal) {
  const encoding = (response.headers['content-encoding'] || 'identity').trim().toLowerCase();
  const decoders = { gzip: createGunzip, 'x-gzip': createGunzip, deflate: createInflate, br: createBrotliDecompress };
  const decoder = Object.hasOwn(decoders, encoding) ? decoders[encoding] : null;
  if (encoding !== 'identity' && !decoder) {
    throw new Error('A página usou um formato de compactação incompatível.');
  }
  if (Number(response.headers['content-length']) > BODY_LIMIT) {
    throw new Error('O HTML ultrapassou o limite de 1 MB da análise.');
  }
  const chunks = [];
  const streams = [response, sizeGuard()];
  if (decoder) streams.push(decoder(), sizeGuard());
  streams.push(new Writable({
    write(chunk, _, done) {
      chunks.push(chunk);
      done();
    },
  }));
  await pipeline(streams, { signal });
  return Buffer.concat(chunks);
}

function requestPage(url, addresses, includeHTML, signal) {
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    let receivedHeaders = false;
    const outgoing = request(url, {
      agent: false,
      signal,
      maxHeaderSize: 16 * 1024,
      autoSelectFamily: true,
      // The socket can only use these validated records. The URL still sets Host and TLS identity.
      lookup: (_host, options, callback) => {
        if (options.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      },
      headers: {
        'User-Agent': 'CadeAFalha/0.1 (verificacao de pagina)',
        Accept: 'text/html, application/xhtml+xml, */*;q=0.1',
        'Accept-Encoding': 'gzip, deflate, br',
        Connection: 'close',
      },
    }, async (response) => {
      receivedHeaders = true;
      const { statusCode: status, headers } = response;
      const result = { url: url.href, status, headers };
      // A header is enough for links, redirects and HTTP errors. Close without reading their bodies.
      if (includeHTML && status === 206) {
        result.bodyError = 'O servidor enviou uma resposta parcial (HTTP 206).';
      } else if (includeHTML && status >= 200 && status < 300 && status !== 204 && status !== 205) {
        const mime = (headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
        if (!mime || mime === 'text/html' || mime === 'application/xhtml+xml') {
          try {
            result.body = await readHTML(response, signal);
          } catch (error) {
            result.bodyError = signal.aborted ? 'O tempo limite para ler o HTML foi atingido.'
              : error.code ? 'A leitura do HTML foi interrompida ou a compactação é inválida.' : error.message;
          }
        } else {
          result.bodyError = 'A resposta não foi identificada como uma página HTML.';
        }
      }
      resolve(result);
      response.destroy();
    });
    outgoing.once('error', (error) => {
      // After headers arrive, the response stream handles failures while reading the body.
      if (!receivedHeaders) reject(error);
    });
    outgoing.end();
  });
}

export async function fetchPage(initial, { includeHTML = false, signal } = {}) {
  let url = initial;
  let lastResponse;
  try {
    for (let hops = 0; ; hops++) {
      validateDestination(url);
      const hopSignal = AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT)].filter(Boolean));
      try {
        const records = await resolvePublic(hostname(url), hopSignal);
        lastResponse = await requestPage(url, records, includeHTML, hopSignal);
      } catch (error) {
        if (hopSignal.aborted) throw new Error('O tempo limite da verificação foi atingido.');
        throw error;
      }
      if (!REDIRECTS.has(lastResponse.status)) return lastResponse;
      if (!lastResponse.headers.location) throw new Error('O redirecionamento veio sem um destino.');
      if (hops === MAX_REDIRECTS) throw new Error('A página ultrapassou o limite de quatro redirecionamentos.');
      try {
        url = new URL(lastResponse.headers.location, url);
      } catch {
        throw new Error('O redirecionamento veio com um destino inválido.');
      }
    }
  } catch (error) {
    if (error instanceof BlockedAddress) {
      return {
        ...lastResponse,
        reason: lastResponse ? 'O redirecionamento apontou para um endereço local, privado ou reservado e foi bloqueado.'
          : blockedMessage,
      };
    }
    if (error instanceof AddressError && lastResponse) {
      return { ...lastResponse, reason: 'O redirecionamento apontou para um destino incompatível com a análise.' };
    }
    const code = error.code || error.errors?.[0]?.code;
    const reason = code || error instanceof AggregateError
      ? 'Não foi possível estabelecer uma conexão HTTP com a página.' : error.message;
    return { ...lastResponse, reason };
  }
}
