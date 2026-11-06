import assert from 'node:assert/strict';
import { Resolver } from 'node:dns/promises';
import { EventEmitter } from 'node:events';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { audit } from '../lib/audit.mjs';
import { fetchPage, isPublicIP, parseAddress } from '../lib/network.mjs';
import { createPublicLimits } from '../lib/public-limits.mjs';

const publicIp = '93.184.216.34';
const host = 'fixture.cadeafalha.net';

// Replace only DNS and the outbound transport. URL validation, redirect handling,
// streaming limits, HTML parsing and report generation run as in the app.
function fixture(t, routes) {
  const calls = [];
  t.mock.method(Resolver.prototype, 'resolve4', async (name) => name === `private.${host}.`
    ? [publicIp, '192.168.1.10'] : [publicIp]);
  t.mock.method(Resolver.prototype, 'resolve6', async () => []);
  const requestMock = t.mock.method(https, 'request', (url, options, receive) => {
    const request = new EventEmitter();
    request.end = () => {
      calls.push(url.href);
      options.lookup(url.hostname, { all: true }, (error, records) => {
        assert.ifError(error);
        assert.deepEqual(records, [{ address: publicIp, family: 4 }]);
      });
      assert.equal(options.agent, false);
      assert.equal(options.rejectUnauthorized, true);
      const [status, headers, body] = routes[url.pathname] ?? [404, {}, ''];
      const response = new PassThrough();
      response.statusCode = status;
      response.headers = headers;
      receive(response);
      if (response.destroyed) return;
      if (typeof body === 'function') body(response, request);
      else response.end(body ?? '');
    };
    return request;
  });
  syncBuiltinESMExports();
  t.after(() => {
    requestMock.mock.restore();
    syncBuiltinESMExports();
  });
  return calls;
}

test('usa HTTPS por padrão, recusa esquemas e bloqueia IPs especiais', () => {
  assert.equal(parseAddress(' exemplo.com.br:8443/noticias#topo ').href, 'https://exemplo.com.br:8443/noticias');
  for (const address of ['', 'não é um endereço', 'https:///example.com', 'ftp://example.com', 'https://user@example.com']) {
    assert.throws(() => parseAddress(address));
  }
  assert.throws(() => parseAddress(`example.com/${'a'.repeat(2048)}`), /longo demais/);
  for (const address of ['localhost', '127.1', '0x7f000001', '192.168.0.1', '[::ffff:127.0.0.1]', '[fd12::1]']) {
    assert.throws(() => parseAddress(address), /privados ou reservados/);
  }
  for (const address of ['100.64.0.1', '169.254.169.254', '198.18.1.1', '203.0.113.1', '224.1.0.1',
    '2001:db8::1', '64:ff9b::a00:1', '3fff::1', 'fe80::1']) assert.equal(isPublicIP(address), false, address);
  assert.equal(isPublicIP(publicIp), true);
  assert.equal(isPublicIP('2606:4700::1'), true);
});

test('bloqueia DNS misto e redirecionamentos privados antes de conectar', async (t) => {
  const calls = fixture(t, {
    '/local': [302, { location: 'http://127.0.0.1:4173/' }],
    '/dns': [302, { location: `https://private.${host}/` }],
    '/esquema': [302, { location: 'ftp://example.com/' }],
  });
  for (const path of ['/local', '/dns']) {
    const report = await audit(parseAddress(`https://${host}${path}`));
    assert.equal(report.httpStatus, 302);
    assert.equal(report.finalAddress, null);
    assert.equal(report.availability, 'unknown');
    assert.equal(report.linksTested, 0);
    assert.equal(report.findings.length, 5);
    assert.ok(report.findings.every(({ group }) => group === 'unknown'));
    assert.match(report.findings[0].observed, /redirecionamento.*foi bloqueado/);
  }
  const direct = await fetchPage(parseAddress(`https://private.${host}/`));
  assert.match(direct.reason, /privados ou reservados/);
  const unsupported = await fetchPage(parseAddress(`https://${host}/esquema`));
  assert.equal(unsupported.status, 302);
  assert.match(unsupported.reason, /redirecionamento.*incompatível/);
  assert.deepEqual(calls, [`https://${host}/local`, `https://${host}/dns`, `https://${host}/esquema`]);
});

test('extrai HTML, limita a amostra e separa 404 de 403', async (t) => {
  const html = `<!doctype html><head><title>Teste &amp; revisão</title>
    <meta name="VIEWPORT" content="width=device-width, initial-scale=1"><base href="/pasta/"></head>
    <body><a href="/#top">Âncora local</a>
    <a href="mailto:teste@example.com">E-mail</a><a href="tel:123">Telefone</a>
    <a href="https://example.com/">Externo</a>
    <a href="quebrado#x"><span>Fale</span> conosco &lt;teste&gt;</a><a href="quebrado#y">Duplicado</a>
    <a href="/restrito">Área privada</a>
    ${Array.from({ length: 12 }, (_, index) => `<a href="/ok/${index}">Link</a>`).join('')}`;
  const routes = {
    '/': [200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' }, gzipSync(html)],
    '/restrito': [403, {}],
    ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`/ok/${index}`, [200, {}]])),
  };
  const calls = fixture(t, routes);
  const report = await audit(parseAddress(host));
  assert.equal(report.linksTested, 10);
  assert.equal(calls.length, 11);
  const broken = report.findings.find(({ group }) => group === 'priority');
  assert.equal(broken.title, 'Link “Fale conosco <teste>”');
  assert.equal(broken.destination, `https://${host}/pasta/quebrado`);
  assert.match(broken.observed, /404/);
  assert.match(report.findings.find(({ group }) => group === 'unknown').observed, /403/);
  assert.match(report.findings.find(({ title }) => title === 'Título da página').observed, /Teste & revisão/);
  assert.ok(report.findings.some(({ title, group }) => title === 'Configuração para celular' && group === 'passed'));
});

test('interrompe redirecionamentos repetidos e HTML descompactado acima de 1 MB', async (t) => {
  const calls = fixture(t, {
    '/loop': [302, { location: '/loop' }],
    '/grande': [200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }, gzipSync('x'.repeat(1_050_000))],
  });
  const redirect = await fetchPage(parseAddress(`https://${host}/loop`));
  assert.match(redirect.reason, /quatro redirecionamentos/);
  assert.equal(calls.length, 5);
  const report = await audit(parseAddress(`https://${host}/grande`));
  assert.equal(report.availability, 'passed');
  assert.equal(report.linksTested, 0);
  assert.equal(report.findings.filter(({ group }) => group === 'unknown').length, 3);
  assert.match(report.findings.find(({ group }) => group === 'unknown').observed, /limite de 1 MB/);
});

test('preserva o HTTP recebido quando o prazo termina durante a leitura do HTML', async (t) => {
  const controller = new AbortController();
  fixture(t, {
    '/lento': [200, { 'content-type': 'text/html' }, (response, request) => {
      response.write('<!doctype html><title>Incompleto');
      queueMicrotask(() => {
        controller.abort(new DOMException('Tempo limite', 'TimeoutError'));
        request.emit('error', Object.assign(new Error('Request aborted'), { code: 'ABORT_ERR' }));
      });
    }],
  });
  const report = await audit(parseAddress(`https://${host}/lento`), controller.signal);
  assert.equal(report.httpStatus, 200);
  assert.equal(report.availability, 'passed');
  assert.ok(report.findings.some(({ title, group }) => title === 'HTTPS' && group === 'passed'));
  const unknown = report.findings.filter(({ group }) => group === 'unknown');
  assert.equal(unknown.length, 3);
  assert.ok(unknown.every(({ observed }) => /tempo limite.*ler o HTML/.test(observed)));
});

test('marca as verificações de HTML como inconclusivas quando a resposta é parcial', async (t) => {
  fixture(t, {
    '/parcial': [206, { 'content-type': 'text/html', 'content-range': 'bytes 0-9/200' }, '<!doctype '],
  });
  const report = await audit(parseAddress(`https://${host}/parcial`));
  assert.equal(report.httpStatus, 206);
  assert.equal(report.availability, 'passed');
  const unknown = report.findings.filter(({ group }) => group === 'unknown');
  assert.equal(unknown.length, 3);
  assert.ok(unknown.every(({ observed }) => /resposta parcial/.test(observed)));
});

test('usa o primeiro título e segue a resolução de links da página', async (t) => {
  const html = { 'content-type': 'text/html' };
  const calls = fixture(t, {
    '/artigo': [200, html, `<!doctype html><title> </title><title>Outro título</title>
      <base href="javascript:void(0)"><a href="#top">Âncora local</a><a href="contato">Contato</a>`],
    '/arquivo': [200, html, `<!doctype html><title>Arquivo</title><base href="/outra-pagina">
      <a href="#secao">Seção em outra página</a><a href="/arquivo#top">Âncora local</a>`],
  });
  const article = await audit(parseAddress(`https://${host}/artigo`));
  assert.ok(article.findings.some(({ title, group }) => title === 'Título da página' && group === 'suggestion'));
  assert.equal(article.linksTested, 1);
  const archive = await audit(parseAddress(`https://${host}/arquivo`));
  assert.equal(archive.linksTested, 1);
  assert.deepEqual(calls.map((url) => new URL(url).pathname), ['/artigo', '/contato', '/arquivo', '/outra-pagina']);
});

test('reconhece separadores de viewport e detecta quando a largura foi sobrescrita', async (t) => {
  const html = { 'content-type': 'text/html' };
  fixture(t, {
    '/espaco': [200, html, '<meta name="viewport" content="initial-scale=1 width=device-width">'],
    '/fixo': [200, html, '<meta name="viewport" content="width=device-width, width=1024">'],
  });
  const groupFor = async (path) => {
    const report = await audit(parseAddress(`https://${host}/${path}`));
    return report.findings.find(({ title }) => title === 'Configuração para celular').group;
  };
  assert.equal(await groupFor('espaco'), 'passed');
  assert.equal(await groupFor('fixo'), 'suggestion');
});

test('orienta a investigar o servidor quando uma página ou link retorna HTTP 500', async (t) => {
  fixture(t, {
    '/': [200, { 'content-type': 'text/html' }, '<a href="/erro">Catálogo</a>'],
    '/erro': [500, {}],
  });
  const links = await audit(parseAddress(host));
  const broken = links.findings.find(({ group }) => group === 'priority');
  assert.match(broken.action, /HTTP 500/);
  assert.match(broken.action, /hospedagem/);
  const page = await audit(parseAddress(`https://${host}/erro`));
  assert.match(page.findings[0].action, /hospedagem/);
});

test('impede portas não padrão e o próprio serviço em endereços e redirecionamentos públicos', async (t) => {
  const publicHostname = 'cade-a-falha.onrender.com';
  const calls = fixture(t, {
    '/porta': [302, { location: `https://${host}:8443/` }],
    '/proprio': [302, { location: `https://${publicHostname}./` }],
  });
  assert.throws(() => parseAddress(`https://${host}:8443/`, publicHostname), /portas padrão/);
  assert.throws(() => parseAddress(publicHostname, publicHostname), /outro site/);
  assert.equal(parseAddress(`https://${host}:443/`, publicHostname).port, '');
  for (const path of ['/porta', '/proprio']) {
    const result = await fetchPage(parseAddress(`https://${host}${path}`), { publicHostname });
    assert.match(result.reason, /redirecionamento foi bloqueado.*portas padrão/i);
  }
  assert.deepEqual(calls, [`https://${host}/porta`, `https://${host}/proprio`]);
});

test('limita análises por visitante, por instância e tentativas de saída por minuto', () => {
  let time = 0;
  const limits = createPublicLimits(() => time);
  for (const ip of ['1.1.1.1', '8.8.8.8', '2606:4700::1111']) {
    for (let count = 0; count < 4; count++) assert.equal(limits.admitAnalysis(ip), 0);
    assert.equal(limits.admitAnalysis(ip), 60);
  }
  assert.equal(limits.admitAnalysis('9.9.9.9'), 60);
  for (let count = 0; count < 80; count++) assert.equal(limits.takeAttempt(), true);
  assert.equal(limits.takeAttempt(), false);
  time = 59_999;
  assert.equal(limits.admitAnalysis('9.9.9.9'), 1);
  time = 60_000;
  assert.equal(limits.admitAnalysis('1.1.1.1'), 0);
  assert.equal(limits.takeAttempt(), true);
});

test('interrompe a amostra ao acabar o orçamento sem contar links que não foram testados', async (t) => {
  const calls = fixture(t, {
    '/': [200, { 'content-type': 'text/html' }, '<a href="/contato">Contato</a>'],
  });
  let budget = 1;
  const report = await audit(parseAddress(host), undefined, {
    publicHostname: 'cade-a-falha.onrender.com',
    takeAttempt: () => budget-- > 0,
  });
  assert.equal(report.linksTested, 0);
  assert.match(report.findings.find(({ destination }) => destination).observed, /limite de consultas externas/);
  assert.deepEqual(calls, [`https://${host}/`]);
});
