const form = document.querySelector('#audit-form');
const input = document.querySelector('#address');
const submit = document.querySelector('#submit');
const errorMessage = document.querySelector('#form-error');
const loading = document.querySelector('#loading');
const status = document.querySelector('#audit-status');
const report = document.querySelector('#report');
const checks = document.querySelector('#checks');
let busy = false;

const groups = [
  { id: 'priority', title: 'Corrigir primeiro', tag: 'Falha prioritária', icon: 'alert' },
  { id: 'suggestion', title: 'Melhorias sugeridas', tag: 'Melhoria', icon: 'info' },
  { id: 'passed', title: 'Tudo certo', tag: 'Aprovado', icon: 'check' },
  { id: 'unknown', title: 'Não foi possível verificar', tag: 'Inconclusivo', icon: 'info' },
];

function element(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

function field(list, title, value) {
  if (value) list.append(element('dt', '', title), element('dd', '', value));
}

function findingCard(item, group) {
  const card = element('li', 'finding');
  const heading = element('div', 'finding-heading');
  heading.append(element('h4', '', item.title), element('span', 'finding-tag', group.tag));
  card.append(heading);
  if (item.group === 'passed') {
    card.append(element('p', 'finding-observed', item.observed));
    return card;
  }
  const detail = element('dl', 'finding-detail');
  field(detail, 'Onde aconteceu', item.where);
  field(detail, 'Destino do link', item.destination);
  field(detail, 'O que foi observado', item.observed);
  field(detail, 'Como afeta o visitante', item.impact);
  field(detail, 'O que fazer', item.action);
  card.append(detail);
  return card;
}

function clearError() {
  errorMessage.hidden = true;
  errorMessage.textContent = '';
  input.removeAttribute('aria-invalid');
  input.setAttribute('aria-describedby', 'form-hint');
}

function showError(message, invalid) {
  errorMessage.hidden = false;
  errorMessage.replaceChildren(icon('alert'), element('span', '', message));
  input.setAttribute('aria-describedby', 'form-hint form-error');
  if (invalid) input.setAttribute('aria-invalid', 'true');
  input.focus();
}

function setBusy(state) {
  busy = state;
  submit.disabled = state;
  input.readOnly = state;
  form.setAttribute('aria-busy', String(state));
  loading.hidden = !state;
  status.textContent = state ? 'Analisando seu site…' : '';
}

function focusHeading(heading) {
  heading.tabIndex = -1;
  heading.focus({ preventScroll: true });
  heading.scrollIntoView({ block: 'start' });
}

function renderReport(data, raw) {
  const header = element('header', 'report-header');
  const eyebrow = element('p', 'eyebrow');
  eyebrow.append(icon('search'), ' RELATÓRIO DE ANÁLISE');
  const title = element('h2', '', 'Resultado da investigação');
  title.id = 'report-title';
  header.append(eyebrow, title);

  const summary = element('dl', 'summary');
  field(summary, 'Endereço analisado', data.requestedAddress);
  if (data.finalAddress && data.finalAddress !== data.requestedAddress) field(summary, 'Endereço final', data.finalAddress);
  if (data.httpStatus) {
    field(summary, data.finalAddress ? 'Resposta da página' : 'Última resposta recebida', `HTTP ${data.httpStatus}`);
  }
  field(summary, 'Links internos testados', String(data.linksTested));
  header.append(summary);

  const parts = [header];
  if (data.availability !== 'passed') {
    const banner = element('div', `report-note ${data.availability}`);
    const copy = element('div');
    const check = data.findings.find((item) => item.title === 'Disponibilidade da página');
    copy.append(element('strong', '', 'Não foi possível analisar o conteúdo da página.'),
      element('p', '', check.observed));
    banner.append(icon('alert'), copy);
    parts.push(banner);
  } else if (!data.findings.some((item) => ['priority', 'suggestion'].includes(item.group))) {
    const hasUnknown = data.findings.some((item) => item.group === 'unknown');
    const banner = element('div', `report-note ${hasUnknown ? 'unknown' : 'passed'}`);
    const copy = element('div');
    copy.append(element('strong', '', 'Nenhuma falha encontrada nas verificações realizadas.'));
    if (hasUnknown) copy.append(element('p', '', 'Algumas verificações ficaram inconclusivas. Veja os motivos no relatório.'));
    banner.append(icon(hasUnknown ? 'info' : 'check'), copy);
    parts.push(banner);
  }
  if (data.linksFound === 0) {
    parts.push(element('p', 'sample-note', 'Nenhum destino interno elegível foi encontrado no HTML.'));
  }

  for (const group of groups) {
    const matches = data.findings.filter((item) => item.group === group.id);
    if (!matches.length) continue;
    const section = element('section', `report-group ${group.id}`);
    const heading = element('h3', 'group-title');
    heading.append(icon(group.icon), group.title, element('span', 'group-count', String(matches.length)));
    const list = element('ul', 'finding-list');
    list.append(...matches.map((item) => findingCard(item, group)));
    section.append(heading, list);
    parts.push(section);
  }

  const scope = element('aside', 'scope');
  const scopeText = element('div');
  scopeText.append(element('h3', '', 'Escopo da análise'),
    element('p', '', 'A análise cobre o HTML recebido e uma amostra de até 10 destinos internos. Envio de formulários, compras, interações que dependem de JavaScript e alterações automáticas ficam fora desta versão.'));
  scope.append(icon('info'), scopeText);
  parts.push(scope);

  const actions = element('div', 'report-actions');
  const again = element('button', 'button button-primary');
  again.type = 'button';
  again.append(icon('refresh'), 'Analisar novamente');
  again.addEventListener('click', () => {
    if (busy) return;
    input.value = raw;
    runAudit();
  });
  const other = element('button', 'button button-secondary', 'Testar outro endereço');
  other.type = 'button';
  other.addEventListener('click', () => {
    if (busy) return;
    input.value = '';
    clearError();
    report.hidden = true;
    report.replaceChildren();
    checks.hidden = false;
    input.focus();
  });
  actions.append(again, other);
  parts.push(actions);

  report.replaceChildren(...parts);
  report.hidden = false;
  focusHeading(title);
}

async function runAudit() {
  if (busy) return;
  clearError();
  const raw = input.value;
  const address = raw.trim();
  if (!address) {
    showError('Digite o endereço do seu site para iniciar a análise.', true);
    return;
  }
  if (address.length > 2048) {
    showError('O endereço informado é longo demais. Use até 2.048 caracteres.', true);
    return;
  }
  const fromReport = report.contains(document.activeElement);
  if (fromReport) input.focus({ preventScroll: true });
  report.hidden = true;
  checks.hidden = true;
  setBusy(true);
  if (fromReport) loading.scrollIntoView({ block: 'center' });
  try {
    const response = await fetch('/api/analisar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address }),
      signal: AbortSignal.timeout(20_000),
    });
    const data = await response.json();
    if (!response.ok) {
      showError(data.error, response.status === 400);
      checks.hidden = false;
      return;
    }
    renderReport(data, raw);
  } catch {
    showError('A análise não foi concluída. Confira a conexão com a prévia e tente novamente.', false);
    checks.hidden = false;
  } finally {
    setBusy(false);
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  runAudit();
});
input.addEventListener('input', clearError);
