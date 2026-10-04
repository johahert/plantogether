import { CATEGORIES, itemCost, totals } from './shared.js';

const app = document.getElementById('app');
const sheet = document.getElementById('sheet');
const toastEl = document.getElementById('toast');

const KEYS = 'plantogether:keys';
const RECENT = 'plantogether:recent';
const HIDE_DONE = 'plantogether:hideDone';
const CURRENCIES = ['SEK', 'EUR', 'USD', 'GBP', 'NOK', 'DKK', 'CHF', 'PLN', 'CAD', 'AUD'];

const local = {
  get(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // private mode etc. – the app still works, it just won't remember
    }
  },
};

const state = {
  list: null,
  canEdit: false,
  key: '',
  filter: 'all',
  hideDone: local.get(HIDE_DONE, false),
  events: null,
};

// ---- helpers --------------------------------------------------------------

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const pad = (n) => String(n).padStart(2, '0');

function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseIso(date) {
  const [y, m, d = 1] = date.split('-').map(Number);
  return new Date(y, m - 1, d);
}

const monthName = (ym) => parseIso(ym).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
const dayName = (ymd) => parseIso(ymd).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

function whenLabel(date) {
  if (!date) return '';
  return date.length === 7 ? `During ${monthName(date)}` : dayName(date);
}

function money(n) {
  const currency = state.list?.currency || 'EUR';
  const digits = Number.isInteger(n) ? 0 : 2;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(n);
  } catch {
    return `${n} ${currency}`;
  }
}

function guessCurrency() {
  const lang = navigator.language || 'en-US';
  const region = (lang.split('-')[1] || '').toUpperCase();
  const byRegion = { SE: 'SEK', NO: 'NOK', DK: 'DKK', GB: 'GBP', US: 'USD', CH: 'CHF', PL: 'PLN', CA: 'CAD', AU: 'AUD' };
  if (byRegion[region]) return byRegion[region];
  const byLang = { sv: 'SEK', nb: 'NOK', nn: 'NOK', no: 'NOK', da: 'DKK', pl: 'PLN' };
  return byLang[lang.split('-')[0]] || 'EUR';
}

let toastTimer;
function toast(message, isError = false) {
  toastEl.textContent = message;
  toastEl.className = `show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.className = ''), isError ? 4500 : 2200);
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (state.key) headers['x-edit-key'] = state.key;
  const res = await fetch(`/api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

function applyList(data) {
  if (state.list && data.list.version < state.list.version) return;
  state.list = data.list;
  state.canEdit = data.canEdit;
  remember();
  renderList();
}

async function mutate(path, method, body) {
  try {
    applyList(await api(`/lists/${state.list.id}${path}`, { method, body }));
    return true;
  } catch (err) {
    toast(err.message, true);
    return false;
  }
}

const findItem = (id) => state.list.items.find((i) => i.id === id);

function remember() {
  const { id, title } = state.list;
  const recent = local.get(RECENT, []).filter((r) => r.id !== id);
  recent.unshift({ id, title, edit: state.canEdit, at: Date.now() });
  local.set(RECENT, recent.slice(0, 20));
}

const editUrl = () => `${location.origin}/l/${state.list.id}#key=${state.key}`;
const viewUrl = () => `${location.origin}/l/${state.list.id}`;

// ---- home -----------------------------------------------------------------

function renderHome() {
  document.title = 'PlanTogether';
  const recent = local.get(RECENT, []);
  const keys = local.get(KEYS, {});
  const currency = guessCurrency();
  app.innerHTML = `
    <div class="wrap">
      <section class="hero">
        <h1>PlanTogether</h1>
        <p>Plan a move together: what to sell, throw away and buy, when to do it, and what it all costs.</p>
      </section>
      <form class="card" id="create-form">
        <h2>Start a new plan</h2>
        <label class="field"><span>Name</span>
          <input name="title" required maxlength="120" placeholder="Our move to …"></label>
        <label class="field"><span>Currency</span>
          <select name="currency">${CURRENCIES.map((c) => `<option ${c === currency ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
        <button class="btn primary">Create plan</button>
      </form>
      ${
        recent.length
          ? `<section class="card"><h2>Your plans on this device</h2><ul class="recent">${recent
              .map(
                (r) => `<li>
                  <a href="/l/${esc(r.id)}${keys[r.id] ? `#key=${esc(keys[r.id])}` : ''}">${esc(r.title)}
                    ${r.edit ? '' : '<small>· view only</small>'}</a>
                  <button class="icon-btn" data-action="forget" data-id="${esc(r.id)}" aria-label="Remove from this list">✕</button>
                </li>`,
              )
              .join('')}</ul></section>`
          : ''
      }
    </div>`;

  document.getElementById('create-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    form.querySelector('button').disabled = true;
    try {
      const data = await api('/lists', { method: 'POST', body: Object.fromEntries(new FormData(form)) });
      local.set(KEYS, { ...local.get(KEYS, {}), [data.list.id]: data.editKey });
      location.href = `/l/${data.list.id}#key=${data.editKey}`;
    } catch (err) {
      toast(err.message, true);
      form.querySelector('button').disabled = false;
    }
  });
}

// ---- plan page ------------------------------------------------------------

async function openList(id) {
  const keys = local.get(KEYS, {});
  const hashKey = new URLSearchParams(location.hash.slice(1)).get('key');
  if (hashKey && keys[id] !== hashKey) local.set(KEYS, { ...keys, [id]: hashKey });
  state.key = hashKey || keys[id] || '';
  if (state.key && !hashKey) history.replaceState(null, '', `#key=${state.key}`);

  try {
    applyList(await api(`/lists/${id}`));
  } catch (err) {
    if (err.status === 404) {
      local.set(RECENT, local.get(RECENT, []).filter((r) => r.id !== id));
    }
    app.innerHTML = `<div class="wrap"><p class="empty">${esc(err.message)}<br><br><a href="/">Go to start</a></p></div>`;
    return;
  }
  connectLive(id);
}

function connectLive(id) {
  state.events?.close();
  const events = new EventSource(`/api/lists/${id}/events`);
  events.onmessage = (e) => {
    const { version } = JSON.parse(e.data);
    if (state.list && version !== state.list.version) refresh();
  };
  state.events = events;
}

let refreshing = null;
function refresh() {
  refreshing ??= api(`/lists/${state.list.id}`)
    .then(applyList)
    .catch(() => {})
    .finally(() => (refreshing = null));
  return refreshing;
}

const FILTERS = [
  ['all', 'All'],
  ...Object.entries(CATEGORIES),
  ['decide', 'To decide'],
];

function matchesFilter(item) {
  if (state.hideDone && item.done) return false;
  if (state.filter === 'all') return true;
  if (state.filter === 'decide') return item.options.length > 1 && !item.chosenId;
  return item.category === state.filter;
}

function renderList() {
  const { list, canEdit } = state;
  document.title = `${list.title} · PlanTogether`;
  const t = totals(list.items);
  const doneCount = list.items.filter((i) => i.done).length;
  const pct = list.items.length ? Math.round((doneCount / list.items.length) * 100) : 0;

  app.innerHTML = `
    <header class="top"><div class="wrap">
      <a class="home" href="/" aria-label="All plans">‹</a>
      <h1>${esc(list.title)}</h1>
      <button class="btn" data-action="share">Share</button>
      ${canEdit ? '<button class="icon-btn" data-action="settings" aria-label="Plan settings">⚙︎</button>' : ''}
    </div></header>
    ${canEdit ? '' : '<div class="readonly-banner">View only. Ask for the edit link to make changes.</div>'}
    <main class="wrap">
      <section class="summary">
        <div><small>To spend</small><strong>${money(t.spend)}</strong></div>
        <div><small>From sales</small><strong>${money(t.income)}</strong></div>
        <div><small>Net cost</small><strong>${money(t.spend - t.income)}</strong></div>
        ${
          t.undecided
            ? `<div class="note">+ ${t.undecided} undecided choice${t.undecided > 1 ? 's' : ''}: ${money(t.minExtra)} – ${money(t.maxExtra)} more</div>`
            : ''
        }
        <div class="note">${doneCount} of ${list.items.length} done</div>
        <div class="progress"><span style="width:${pct}%"></span></div>
      </section>
      <nav class="filters">
        ${FILTERS.map(
          ([value, label]) =>
            `<button class="chip" data-action="filter" data-value="${value}" aria-pressed="${state.filter === value}">${label}</button>`,
        ).join('')}
        <button class="chip" data-action="hide-done" aria-pressed="${state.hideDone}">Hide done</button>
      </nav>
      ${timeline(list.items.filter(matchesFilter))}
    </main>
    ${canEdit ? '<button class="fab" data-action="add-item">+ Add</button>' : ''}`;
}

function timeline(items) {
  if (!state.list.items.length) {
    return `<p class="empty">Nothing here yet.<br>${
      state.canEdit
        ? 'Tap <b>+ Add</b> to add things to sell, throw away or buy. Give them a day or just a month.'
        : ''
    }</p>`;
  }
  if (!items.length) return '<p class="empty">Nothing matches this filter.</p>';

  const today = isoToday();
  const thisMonth = today.slice(0, 7);
  const months = new Map();
  const undated = [];
  for (const item of items) {
    if (!item.date) {
      undated.push(item);
      continue;
    }
    const key = item.date.slice(0, 7);
    if (!months.has(key)) months.set(key, { whole: [], days: new Map() });
    const group = months.get(key);
    if (item.date.length === 7) group.whole.push(item);
    else {
      if (!group.days.has(item.date)) group.days.set(item.date, []);
      group.days.get(item.date).push(item);
    }
  }

  const cards = (list) =>
    [...list.filter((i) => !i.done), ...list.filter((i) => i.done)].map((i) => itemCard(i, today)).join('');
  const count = (n) => `${n} item${n === 1 ? '' : 's'}`;

  let html = '';
  for (const key of [...months.keys()].sort()) {
    const { whole, days } = months.get(key);
    const total = whole.length + [...days.values()].reduce((n, d) => n + d.length, 0);
    html += `<section class="month"><h2>${esc(monthName(key))}${key === thisMonth ? ' <small>this month</small>' : ''}<small>${count(total)}</small></h2>`;
    if (whole.length) html += `<div class="day-label">Any time this month</div>${cards(whole)}`;
    for (const day of [...days.keys()].sort()) {
      const cls = day === today ? 'today' : day < today ? 'past' : '';
      html += `<div class="day-label ${cls}">${day === today ? 'Today · ' : ''}${esc(dayName(day))}</div>${cards(days.get(day))}`;
    }
    html += '</section>';
  }
  if (undated.length) {
    html += `<section class="month"><h2>No date yet <small>${count(undated.length)}</small></h2>${cards(undated)}</section>`;
  }
  return html;
}

function itemCard(item, today) {
  const { canEdit } = state;
  const cost = itemCost(item);
  const overdue =
    !item.done && item.date && (item.date.length === 7 ? item.date < today.slice(0, 7) : item.date < today);

  let costHtml = '';
  if (!cost.decided) {
    costHtml = `<span class="cost undecided">Not decided · ${money(cost.min)} – ${money(cost.max)}</span>`;
  } else if (cost.amount) {
    costHtml = `<span class="cost ${item.category === 'sell' ? 'income' : ''}">${item.category === 'sell' ? '+' : ''}${money(cost.amount)}</span>`;
  }

  const addLabel = item.options.length
    ? '+ Add alternative'
    : item.category === 'sell'
      ? '+ Add listing / price'
      : '+ Add link / price';

  return `
    <article class="item cat-${item.category} ${item.done ? 'done' : ''}">
      <div class="item-head">
        <button class="check" data-action="toggle-done" data-item="${item.id}" aria-pressed="${item.done}"
          aria-label="Mark done" ${canEdit ? '' : 'disabled'}>✓</button>
        <div class="item-main">
          <h3>${esc(item.title)}</h3>
          <div class="meta">
            <span class="badge">${CATEGORIES[item.category]}</span>
            ${item.date ? `<span class="${overdue ? 'overdue' : ''}">📅 ${esc(whenLabel(item.date))}</span>` : ''}
            ${item.assignee ? `<span>👤 ${esc(item.assignee)}</span>` : ''}
          </div>
          ${item.notes ? `<p class="notes">${esc(item.notes)}</p>` : ''}
        </div>
        ${canEdit ? `<button class="icon-btn" data-action="edit-item" data-item="${item.id}" aria-label="Edit">⋯</button>` : ''}
      </div>
      ${optionsHtml(item)}
      ${
        costHtml || canEdit
          ? `<div class="item-foot">${costHtml || '<span></span>'}
              ${canEdit ? `<button class="btn small ghost" data-action="add-option" data-item="${item.id}">${addLabel}</button>` : ''}
            </div>`
          : ''
      }
    </article>`;
}

function optionsHtml(item) {
  const options = item.options;
  if (!options.length) return '';
  const choice = options.length > 1;
  const cards = options.map((o) => optionCard(item, o, choice)).join('');
  if (!choice) return `<div class="options single">${cards}</div>`;
  const hint = item.chosenId
    ? 'Chosen. Only this one counts toward the total.'
    : `Pick one of ${options.length}. It will be added to the total.`;
  return `<div class="options choice"><p class="choose-hint">${hint}</p><div class="grid">${cards}</div></div>`;
}

function optionCard(item, o, choice) {
  const chosen = choice && item.chosenId === o.id;
  const dimmed = choice && item.chosenId && !chosen;
  const link = o.url ? `href="${esc(o.url)}" target="_blank" rel="noopener noreferrer"` : '';
  const thumb = o.image
    ? `<a class="thumb" ${link}><img src="${esc(o.image)}" alt="" loading="lazy" referrerpolicy="no-referrer"></a>`
    : `<a class="thumb blank" ${link}>🔗</a>`;
  return `
    <div class="option ${chosen ? 'chosen' : ''} ${dimmed ? 'dimmed' : ''}">
      ${thumb}
      ${chosen ? '<span class="chosen-tag">✓ Chosen</span>' : ''}
      <div class="opt-body">
        <a class="opt-title" ${link}>${esc(o.title || o.url)}</a>
        ${o.siteName ? `<span class="opt-site">${esc(o.siteName)}</span>` : ''}
        ${o.note ? `<span class="opt-note">${esc(o.note)}</span>` : ''}
        <span class="opt-price">${o.price != null ? money(o.price) : '<small>No price</small>'}</span>
        ${
          choice && state.canEdit
            ? `<div class="opt-actions"><button class="btn small ${chosen ? 'primary' : ''}" data-action="choose"
                data-item="${item.id}" data-opt="${o.id}">${chosen ? '✓ Chosen' : 'Choose'}</button></div>`
            : ''
        }
      </div>
      ${
        state.canEdit
          ? `<button class="icon-btn opt-edit" data-action="edit-option" data-item="${item.id}" data-opt="${o.id}" aria-label="Edit option">✎</button>`
          : ''
      }
    </div>`;
}

// ---- bottom sheet forms ---------------------------------------------------

function openSheet(html, onSubmit) {
  sheet.innerHTML = `<form class="sheet-body" novalidate>${html}</form>`;
  const form = sheet.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!form.reportValidity()) return;
    const button = form.querySelector('button.primary');
    if (button) button.disabled = true;
    const ok = await onSubmit(Object.fromEntries(new FormData(form)), form);
    if (ok) sheet.close();
    else if (button) button.disabled = false;
  });
  sheet.showModal();
  return form;
}

sheet.addEventListener('click', (e) => {
  if (e.target === sheet) sheet.close();
});

const sheetActions = (deleteAction, attrs = '') => `
  <div class="actions">
    ${deleteAction ? `<button type="button" class="btn danger" data-action="${deleteAction}" ${attrs}>Delete</button>` : ''}
    <span class="spacer"></span>
    <button type="button" class="btn ghost" data-action="close-sheet">Cancel</button>
    <button class="btn primary">Save</button>
  </div>`;

function openItemForm(item) {
  const isNew = !item;
  const v = item || {
    title: '',
    category: state.filter in CATEGORIES ? state.filter : 'task',
    date: '',
    assignee: '',
    notes: '',
  };
  const mode = !v.date ? 'none' : v.date.length === 7 ? 'month' : 'day';
  const people = [...new Set(state.list.items.map((i) => i.assignee).filter(Boolean))];
  const radio = (name, value, label, checked) =>
    `<label><input type="radio" name="${name}" value="${value}" ${checked ? 'checked' : ''}><span>${label}</span></label>`;

  const form = openSheet(
    `
    <h2>${isNew ? 'New item' : 'Edit item'}</h2>
    <label class="field"><span>What</span>
      <input name="title" required maxlength="200" value="${esc(v.title)}" placeholder="e.g. Sell the old bookcase"></label>
    <div class="field"><span>Type</span><div class="seg">
      ${Object.entries(CATEGORIES).map(([k, label]) => radio('category', k, label, k === v.category)).join('')}
    </div></div>
    <div class="field"><span>When</span><div class="seg">
      ${radio('when', 'none', 'No date', mode === 'none')}
      ${radio('when', 'day', 'A day', mode === 'day')}
      ${radio('when', 'month', 'Sometime in a month', mode === 'month')}
    </div></div>
    <label class="field" data-when="day"><span>Day</span>
      <input type="date" name="day" value="${mode === 'day' ? v.date : ''}"></label>
    <label class="field" data-when="month"><span>Month</span>
      <input type="month" name="month" value="${mode === 'month' ? v.date : ''}" placeholder="YYYY-MM" pattern="\\d{4}-\\d{2}"></label>
    <label class="field"><span>Who</span>
      <input name="assignee" maxlength="60" list="people" value="${esc(v.assignee)}" placeholder="Optional">
      <datalist id="people">${people.map((p) => `<option value="${esc(p)}">`).join('')}</datalist></label>
    <label class="field"><span>Notes</span>
      <textarea name="notes" maxlength="2000" placeholder="Optional">${esc(v.notes)}</textarea></label>
    ${sheetActions(isNew ? '' : 'delete-item', `data-item="${item?.id}"`)}`,
    async (data) => {
      const date = data.when === 'day' ? data.day : data.when === 'month' ? data.month : '';
      if (data.when !== 'none' && !date) {
        toast(data.when === 'day' ? 'Pick a day' : 'Pick a month', true);
        return false;
      }
      const body = { title: data.title, category: data.category, date, assignee: data.assignee, notes: data.notes };
      return isNew ? mutate('/items', 'POST', body) : mutate(`/items/${item.id}`, 'PATCH', body);
    },
  );

  const syncWhen = () => {
    const when = form.elements.when.value;
    for (const el of form.querySelectorAll('[data-when]')) el.hidden = el.dataset.when !== when;
  };
  form.addEventListener('change', (e) => e.target.name === 'when' && syncWhen());
  syncWhen();
  if (isNew) form.elements.title.focus();
}

function openOptionForm(item, option) {
  const isNew = !option;
  const v = option || { url: '', title: '', price: null, image: '', siteName: '', note: '' };
  const heading = isNew ? (item.options.length ? 'Add an alternative' : 'Add a link') : 'Edit option';

  const form = openSheet(
    `
    <h2>${heading}</h2>
    <p class="hint">For “${esc(item.title)}”. Add two or more to make it a choice: pick one and only that price counts.</p>
    <div class="field"><span>Link</span><div class="share-row">
      <input name="url" type="url" inputmode="url" autocomplete="off" placeholder="Paste a link: https://…" value="${esc(v.url)}">
      <button type="button" class="btn small" data-action="fetch-preview">Fetch</button>
    </div></div>
    <div class="preview-box">
      ${v.image ? `<img src="${esc(v.image)}" alt="" referrerpolicy="no-referrer">` : ''}
      <span class="pv-status">${v.siteName ? esc(v.siteName) : 'Paste a link and we’ll fetch the name, picture and price.'}</span>
    </div>
    <input type="hidden" name="image" value="${esc(v.image)}">
    <input type="hidden" name="siteName" value="${esc(v.siteName)}">
    <label class="field"><span>Name</span>
      <input name="title" maxlength="300" value="${esc(v.title)}" placeholder="e.g. Grey 3-seat sofa"></label>
    <label class="field"><span>Price (${esc(state.list.currency)})</span>
      <input name="price" inputmode="decimal" autocomplete="off" value="${v.price ?? ''}" placeholder="e.g. 4 995"></label>
    <label class="field"><span>Note</span>
      <input name="note" maxlength="500" value="${esc(v.note)}" placeholder="Optional: size, colour, delivery…"></label>
    ${sheetActions(isNew ? '' : 'delete-option', `data-item="${item.id}" data-opt="${option?.id}"`)}`,
    async (data) => {
      const path = isNew ? `/items/${item.id}/options` : `/items/${item.id}/options/${option.id}`;
      return mutate(path, isNew ? 'POST' : 'PATCH', data);
    },
  );

  form.dataset.fetched = v.url;
  const auto = () => setTimeout(() => fetchPreviewInto(form), 0);
  form.elements.url.addEventListener('paste', auto);
  form.elements.url.addEventListener('change', auto);
  if (isNew) form.elements.url.focus();
}

async function fetchPreviewInto(form, force = false) {
  const url = form.elements.url.value.trim();
  if (!/^https?:\/\/\S+$/i.test(url) || (!force && form.dataset.fetched === url)) return;
  form.dataset.fetched = url;
  const box = form.querySelector('.preview-box');
  box.innerHTML = '<span class="pv-status">Fetching preview…</span>';
  try {
    const p = await api(`/lists/${state.list.id}/preview?url=${encodeURIComponent(url)}`);
    if (form.elements.url.value.trim() !== url) return; // user changed it meanwhile
    const { elements } = form;
    if (p.title && (!elements.title.value || elements.title.dataset.auto === elements.title.value)) {
      elements.title.value = elements.title.dataset.auto = p.title;
    }
    if (p.price != null && (!elements.price.value || elements.price.dataset.auto === elements.price.value)) {
      elements.price.value = elements.price.dataset.auto = String(p.price);
    }
    elements.image.value = p.image || '';
    elements.siteName.value = p.siteName || '';
    const currencyNote =
      p.currency && p.price != null && p.currency !== state.list.currency ? ` · price on page is in ${esc(p.currency)}` : '';
    box.innerHTML = `${p.image ? `<img src="${esc(p.image)}" alt="" referrerpolicy="no-referrer">` : ''}
      <span class="pv-status">${esc(p.siteName)}${p.price == null ? ' · no price found, add it yourself' : ''}${currencyNote}</span>`;
  } catch (err) {
    box.innerHTML = `<span class="pv-status">${esc(err.message)}</span>`;
  }
}

function shareRow(label, url) {
  return `<div class="field"><span>${label}</span><div class="share-row">
    <input readonly value="${esc(url)}" onfocus="this.select()">
    <button type="button" class="btn small" data-action="copy" data-value="${esc(url)}">Copy</button>
  </div></div>`;
}

function openShare() {
  const main = state.canEdit ? editUrl() : viewUrl();
  openSheet(
    `
    <h2>Share “${esc(state.list.title)}”</h2>
    ${state.canEdit ? shareRow('Edit link: anyone with it can make changes', editUrl()) : ''}
    ${shareRow('View-only link', viewUrl())}
    <p class="hint">Changes show up for everyone right away. On a phone, open the link and use “Add to Home Screen” to keep it like an app.</p>
    <div class="actions">
      <span class="spacer"></span>
      ${navigator.share ? `<button type="button" class="btn" data-action="native-share" data-value="${esc(main)}">Share via…</button>` : ''}
      <button type="button" class="btn primary" data-action="close-sheet">Done</button>
    </div>`,
    async () => true,
  );
}

function openSettings() {
  const { title, currency } = state.list;
  const options = CURRENCIES.includes(currency) ? CURRENCIES : [currency, ...CURRENCIES];
  openSheet(
    `
    <h2>Plan settings</h2>
    <label class="field"><span>Name</span><input name="title" required maxlength="120" value="${esc(title)}"></label>
    <label class="field"><span>Currency</span>
      <select name="currency">${options.map((c) => `<option ${c === currency ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
    ${sheetActions('')}`,
    (data) => mutate('', 'PATCH', data),
  );
}

// ---- click handling -------------------------------------------------------

const actions = {
  'add-item': () => openItemForm(),
  'edit-item': (el) => openItemForm(findItem(el.dataset.item)),
  'toggle-done': (el) => {
    const item = findItem(el.dataset.item);
    mutate(`/items/${item.id}`, 'PATCH', { done: !item.done });
  },
  'delete-item': async (el) => {
    if (!confirm('Delete this item and its links?')) return;
    if (await mutate(`/items/${el.dataset.item}`, 'DELETE')) sheet.close();
  },
  'add-option': (el) => openOptionForm(findItem(el.dataset.item)),
  'edit-option': (el) => {
    const item = findItem(el.dataset.item);
    openOptionForm(item, item.options.find((o) => o.id === el.dataset.opt));
  },
  'delete-option': async (el) => {
    if (!confirm('Remove this option?')) return;
    if (await mutate(`/items/${el.dataset.item}/options/${el.dataset.opt}`, 'DELETE')) sheet.close();
  },
  choose: (el) => {
    const item = findItem(el.dataset.item);
    const chosenId = item.chosenId === el.dataset.opt ? '' : el.dataset.opt;
    mutate(`/items/${item.id}`, 'PATCH', { chosenId });
  },
  'fetch-preview': (el) => fetchPreviewInto(el.closest('form'), true),
  filter: (el) => {
    state.filter = el.dataset.value;
    renderList();
  },
  'hide-done': () => {
    state.hideDone = !state.hideDone;
    local.set(HIDE_DONE, state.hideDone);
    renderList();
  },
  share: () => openShare(),
  settings: () => openSettings(),
  'close-sheet': () => sheet.close(),
  copy: async (el) => {
    try {
      await navigator.clipboard.writeText(el.dataset.value);
      toast('Link copied');
    } catch {
      toast('Couldn’t copy. Select the link and copy it manually.', true);
    }
  },
  'native-share': (el) => navigator.share({ title: state.list.title, url: el.dataset.value }).catch(() => {}),
  forget: (el) => {
    local.set(RECENT, local.get(RECENT, []).filter((r) => r.id !== el.dataset.id));
    renderHome();
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || !actions[el.dataset.action]) return;
  e.preventDefault();
  actions[el.dataset.action](el);
});

// Broken product images: fall back to the link icon.
document.addEventListener(
  'error',
  (e) => {
    if (e.target.tagName !== 'IMG') return;
    const parent = e.target.parentElement;
    e.target.remove();
    if (parent?.classList.contains('thumb')) {
      parent.classList.add('blank');
      parent.textContent = '🔗';
    }
  },
  true,
);

// Phones pause background tabs; catch up when we come back.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.list) refresh();
});

// ---- start ----------------------------------------------------------------

const match = location.pathname.match(/^\/l\/([A-Za-z0-9_-]+)/);
if (match) openList(match[1]);
else renderHome();
