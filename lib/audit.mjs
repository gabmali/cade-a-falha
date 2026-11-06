import sniffEncoding from 'html-encoding-sniffer';
import { parse } from 'parse5';
import { fetchPage } from './network.mjs';

const HTML = 'http://www.w3.org/1999/xhtml';
const LINK_LIMIT = 10;
const LINK_WORKERS = 3;
const TOTAL_TIMEOUT = 16_000;

function* walk(root) {
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    yield node;
    for (let index = (node.childNodes?.length ?? 0) - 1; index >= 0; index--) {
      stack.push(node.childNodes[index]);
    }
  }
}

function attr(node, name) {
  return node.attrs?.find((item) => item.name === name)?.value;
}

function label(node) {
  const stack = [node];
  const parts = [];
  let size = 0;
  while (stack.length && size < 300) {
    const child = stack.pop();
    if (['script', 'style', 'template'].includes(child.tagName)) continue;
    const value = child.nodeName === '#text' ? child.value : child.tagName === 'img' ? attr(child, 'alt') : '';
    if (value) {
      parts.push(child.tagName === 'img' ? ` ${value} ` : value);
      size += value.length;
    }
    for (let index = (child.childNodes?.length ?? 0) - 1; index >= 0; index--) stack.push(child.childNodes[index]);
  }
  return parts.join('').replace(/\s+/gu, ' ').trim().slice(0, 150);
}

function resolvedURL(value, base) {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

function inspectHTML(body, contentType, page) {
  const charset = contentType?.match(/;\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i);
  const encoding = sniffEncoding(body, {
    defaultEncoding: 'UTF-8',
    transportLayerEncodingLabel: charset?.[1] || charset?.[2] || charset?.[3],
  });
  const text = encoding === 'x-user-defined'
    ? body.toString('latin1').replace(/[\x80-\xff]/g, (char) => String.fromCharCode(0xf700 + char.charCodeAt(0)))
    : new TextDecoder(encoding).decode(body);
  const doc = parse(text);
  let title;
  let viewportWidth;
  let baseHref;
  for (const node of walk(doc)) {
    if (node.namespaceURI !== HTML) continue;
    if (node.tagName === 'title' && title === undefined) title = label(node);
    if (node.tagName === 'base' && baseHref === undefined) baseHref = attr(node, 'href');
    if (node.tagName === 'meta' && attr(node, 'name')?.trim().toLowerCase() === 'viewport') {
      const content = attr(node, 'content');
      if (content === undefined) continue;
      viewportWidth = undefined;
      for (const [, width] of content.matchAll(/(?:^|[,;\t\n\r ])width[\t\n\r ]*=[\t\n\r ]*([^,;=\t\n\r ]+)/gi)) {
        viewportWidth = width.toLowerCase();
      }
    }
  }

  const declaredBase = baseHref === undefined ? null : resolvedURL(baseHref, page);
  const base = declaredBase && !['data:', 'javascript:'].includes(declaredBase.protocol) ? declaredBase : page;
  const visited = new Set([page.href]);
  const links = [];
  for (const node of walk(doc)) {
    if (node.tagName !== 'a' && node.tagName !== 'area') continue;
    const href = attr(node, 'href')?.trim();
    if (!href || href.length > 2048) continue;
    const url = resolvedURL(href, base);
    if (!url || url.hostname !== page.hostname || !['http:', 'https:'].includes(url.protocol)
      || url.username || url.password) continue;
    url.hash = '';
    if (url.href.length > 2048 || visited.has(url.href)) continue;
    visited.add(url.href);
    links.push({ url, name: label(node) || attr(node, 'aria-label')?.trim().slice(0, 150)
      || attr(node, 'alt')?.trim().slice(0, 150) || '' });
    if (links.length === LINK_LIMIT) break;
  }
  return { title, viewport: viewportWidth === 'device-width', links };
}

function outcome(response) {
  if (response.reason) {
    const observed = response.status ? `HTTP ${response.status} em ${response.url}. ${response.reason}` : response.reason;
    return { group: 'unknown', observed };
  }
  const { status, headers } = response;
  const code = `HTTP ${status}`;
  if (headers['cf-mitigated'] === 'challenge') {
    return { group: 'unknown', observed: `A página exigiu uma verificação de segurança (${code}).` };
  }
  if (status >= 200 && status < 300) return { group: 'passed', observed: `O servidor respondeu com ${code}.` };
  if ([404, 410].includes(status)) {
    return { group: 'priority', observed: `O servidor informou que a página não está disponível nesse endereço (${code}).` };
  }
  if (status >= 500 && status < 600 && ![503, 504].includes(status)) {
    return { group: 'priority', observed: `O servidor respondeu com um erro durante o teste (${code}).` };
  }
  if ([401, 403, 407, 429, 451].includes(status)) {
    return { group: 'unknown', observed: `O acesso foi bloqueado, restrito ou exigiu autenticação (${code}).` };
  }
  if ([408, 504].includes(status)) return { group: 'unknown', observed: `A requisição excedeu o tempo limite (${code}).` };
  if (status === 503) return { group: 'unknown', observed: `O servidor informou indisponibilidade temporária (${code}).` };
  return { group: 'unknown', observed: `A resposta não confirmou se a página abre para os visitantes (${code}).` };
}

function result(group, title, where, observed, impact, action, destination) {
  return { group, title, where, observed, impact, action, destination };
}

function htmlChecks(address, inspected, reason) {
  const titles = ['Título da página', 'Configuração para celular', 'Links internos'];
  if (!inspected) {
    return titles.map((title) => result('unknown', title, address, reason,
      'Sem ler o HTML, não dá para confirmar o que o visitante recebe.',
      'Abra a página em uma janela anônima. Confira se ela é pública e rode a análise novamente.'));
  }
  return [
    inspected.title
      ? result('passed', titles[0], address, `Título encontrado: “${inspected.title}”.`)
      : result('suggestion', titles[0], address, 'O HTML veio sem um título preenchido.',
        'A aba do navegador fica sem um nome claro para a página.',
        'Nas configurações da página no editor, preencha o campo Título da página ou Título SEO e publique.'),
    inspected.viewport
      ? result('passed', titles[1], address, 'O HTML declara a largura da tela do dispositivo na configuração de visualização.')
      : result('suggestion', titles[1], address, 'A largura na configuração de visualização do HTML não está definida como width=device-width.',
        'No celular, o navegador pode mostrar a página em escala reduzida.',
        'Ative a opção de layout para celular no editor. Se você edita o HTML, adicione <meta name="viewport" content="width=device-width, initial-scale=1"> no <head>.'),
  ];
}

async function testLinks(links, page, options) {
  const findings = [];
  let next = 0;
  let tested = 0;
  async function worker() {
    while (next < links.length) {
      const index = next++;
      const link = links[index];
      const name = link.name ? `Link “${link.name}”` : 'Link sem texto identificado';
      const started = !options.signal.aborted;
      const response = started ? await fetchPage(link.url, options)
        : { reason: 'O tempo total da análise terminou antes de este link ser testado.' };
      if (response.attempted) tested++;
      const check = outcome(response);
      if (check.group === 'passed') {
        findings[index] = null;
        continue;
      }
      const confirmed = check.group === 'priority';
      let action = 'Abra o destino em uma janela anônima e confira se ele é público. Depois, rode a análise novamente.';
      if (confirmed) {
        action = response.status >= 500
          ? `Abra o destino em uma janela anônima. Se o erro continuar, envie a URL e o código HTTP ${response.status} ao suporte da hospedagem ou a quem cuida do site.`
          : 'No editor do site, encontre esse link, confira o endereço de destino e troque-o pelo endereço correto ou restaure a página.';
      }
      findings[index] = result(check.group, name, page, check.observed,
        confirmed ? 'Quem clica no link pode não conseguir abrir a página de destino.'
          : 'O teste não confirmou se o destino abre para o visitante.',
        action, link.url.href);
    }
  }
  await Promise.all(Array.from({ length: Math.min(LINK_WORKERS, links.length) }, worker));
  const passed = findings.filter((item) => item === null).length;
  return { tested, passed, findings: findings.filter(Boolean) };
}

export async function audit(initial, clientSignal, publicPolicy) {
  const signal = AbortSignal.any([AbortSignal.timeout(TOTAL_TIMEOUT), clientSignal].filter(Boolean));
  const options = { ...publicPolicy, signal };
  const page = await fetchPage(initial, { ...options, includeHTML: true });
  const address = page.url || initial.href;
  const availability = outcome(page);
  let availabilityAction = 'Confira o endereço e tente novamente. Se a página exigir login, use uma URL pública.';
  if (availability.group === 'priority') {
    availabilityAction = page.status >= 500
      ? `Se o erro continuar, envie a URL e o código HTTP ${page.status} ao suporte da hospedagem ou a quem cuida do site.`
      : 'Confira se a página foi publicada nesse endereço. Se a URL estiver correta, encaminhe o código HTTP a quem cuida do site.';
  }
  const findings = [result(availability.group, 'Disponibilidade da página', address, availability.observed,
    availability.group === 'priority' ? 'Quem visita este endereço pode não conseguir abrir a página.'
      : 'O teste não confirmou se a página abre para o visitante.',
    availabilityAction)];

  if (page.reason || !page.status) {
    findings.push(result('unknown', 'HTTPS', address, 'Não foi possível confirmar o endereço final.',
      'A proteção da conexão ficou sem confirmação.', 'Abra o site e confira se o endereço final começa com https://.'));
  } else if (new URL(address).protocol === 'https:') {
    findings.push(result('passed', 'HTTPS', address, 'O endereço final usa HTTPS.'));
  } else {
    findings.push(result('priority', 'HTTPS', address, 'O endereço final usa HTTP sem criptografia.',
      'O navegador pode indicar uma conexão insegura e os dados trafegam sem criptografia.',
      'Ative o certificado SSL na hospedagem ou no editor e configure o redirecionamento de HTTP para HTTPS.'));
  }

  const inspected = availability.group === 'passed' && page.body?.length
    ? inspectHTML(page.body, page.headers['content-type'], new URL(address)) : null;
  findings.push(...htmlChecks(address, inspected, page.bodyError || 'A página não forneceu HTML que pudesse ser analisado.'));
  const links = inspected ? await testLinks(inspected.links, address, options) : { tested: 0, passed: 0, findings: [] };
  findings.push(...links.findings);
  if (links.passed) {
    const observed = links.passed === 1 ? '1 destino respondeu com sucesso.'
      : `${links.passed} destinos responderam com sucesso.`;
    findings.push(result('passed', 'Links internos', address, observed));
  }

  return {
    requestedAddress: initial.href,
    address,
    finalAddress: page.reason ? null : page.url,
    httpStatus: page.status ?? null,
    availability: availability.group,
    linksTested: links.tested,
    linksFound: inspected?.links.length ?? null,
    findings,
  };
}
