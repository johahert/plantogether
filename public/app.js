import { TAG_COLORS, itemCost, isIncome, totals } from './shared.js';

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
  filter: 'all', // 'all' | 'decide' | a tag id
  hideDone: local.get(HIDE_DONE, false),
  events: null,
  quickBusy: false,
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
function toast(message, { error = false, action } = {}) {
  toastEl.innerHTML = `<span>${esc(message)}</span>${action ? `<button type="button">${esc(action.label)}</button>` : ''}`;
  if (action) toastEl.querySelector('button').onclick = () => {
    toastEl.className = '';
    action.run();
  };
  toastEl.className = `show${error ? ' error' : ''}${action ? ' has-action' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastEl.className = ''), error || action ? 5000 : 2200);
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
  if (state.filter !== 'all' && state.filter !== 'decide' && !tagById(state.filter)) state.filter = 'all';
  remember();
  renderList();
}

async function mutate(path, method, body) {
  try {
    const data = await api(`/lists/${state.list.id}${path}`, { method, body });
    applyList(data);
    return data;
  } catch (err) {
    toast(err.message, { error: true });
    return false;
  }
}

const findItem = (id) => state.list.items.find((i) => i.id === id);
const tagById = (id) => state.list.tags.find((t) => t.id === id);
const colorOf = (tag) => (TAG_COLORS.includes(tag?.color) ? tag.color : 'slate');

function tagPill(tag, extra = '') {
  return `<span class="tag" data-color="${colorOf(tag)}" ${extra}>${esc(tag.name)}</span>`;
}

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
  document.body.classList.remove('has-composer');
  const recent = local.get(RECENT, []);
  const keys = local.get(KEYS, {});
  const currency = guessCurrency();
  app.innerHTML = `
    <div class="wrap">
      <section class="hero">
        <img src="/icon.svg" alt="" width="56" height="56">
        <h1>PlanTogether</h1>
        <p>Plan a move together: what to sell, throw away and buy, when to do it, and what it all costs.</p>
      </section>
      <form class="card" id="create-form">
        <h2>Start a new plan</h2>
        <label class="field"><span>Name</span>
          <input name="title" required maxlength="120" placeholder="Our move to …"></label>
        <label class="field"><span>Currency</span>
          <select name="currency">${CURRENCIES.map((c) => `<option ${c === currency ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
        <button class="btn primary block">Create plan</button>
      </form>
      ${
        recent.length
          ? `<section class="card"><h2>Your plans on this device</h2><ul class="recent">${recent
              .map(
                (r) => `<li>
                  <a href="/l/${esc(r.id)}${keys[r.id] ? `#key=${esc(keys[r.id])}` : ''}">
                    <span>${esc(r.title)}</span>${r.edit ? '' : '<small>View only</small>'}</a>
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
      toast(err.message, { error: true });
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
    if (err.status === 404) local.set(RECENT, local.get(RECENT, []).filter((r) => r.id !== id));
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

function matchesFilter(item) {
  if (state.hideDone && item.done) return false;
  if (state.filter === 'all') return true;
  if (state.filter === 'decide') return item.options.length > 1 && !item.chosenId;
  return item.tags.includes(state.filter);
}

function renderList() {
  const { list, canEdit } = state;
  document.title = `${list.title} · PlanTogether`;
  document.body.classList.toggle('has-composer', canEdit);
  const t = totals(list.items, list.tags);
  const doneCount = list.items.filter((i) => i.done).length;
  const pct = list.items.length ? Math.round((doneCount / list.items.length) * 100) : 0;
  const undecided = list.items.filter((i) => i.options.length > 1 && !i.chosenId).length;

  // Keep whatever someone is typing in the quick-add box across re-renders.
  const draft = document.getElementById('quick-input')?.value ?? '';
  const hadFocus = document.activeElement?.id === 'quick-input';
  const scrollX = document.querySelector('.filters')?.scrollLeft ?? 0;

  const chip = (value, label, pressed, extra = '') =>
    `<button class="chip" data-action="filter" data-value="${value}" aria-pressed="${pressed}" ${extra}>${label}</button>`;

  app.innerHTML = `
    <header class="top"><div class="wrap">
      <a class="icon-btn back" href="/" aria-label="All plans">‹</a>
      <h1>${esc(list.title)}</h1>
      <button class="icon-btn" data-action="share" aria-label="Share">${ICON_SHARE}</button>
      ${canEdit ? `<button class="icon-btn" data-action="settings" aria-label="Plan settings and tags">${ICON_GEAR}</button>` : ''}
    </div></header>
    ${canEdit ? '' : '<div class="readonly-banner">View only. Ask for the edit link to make changes.</div>'}
    <main class="wrap">
      <section class="summary">
        <div class="stats">
          <div><small>To spend</small><strong>${money(t.spend)}</strong></div>
          <div><small>From sales</small><strong>${money(t.income)}</strong></div>
          <div><small>Net cost</small><strong>${money(t.spend - t.income)}</strong></div>
        </div>
        ${
          t.undecided
            ? `<p class="summary-note">+ ${t.undecided} undecided choice${t.undecided > 1 ? 's' : ''}: ${money(t.minExtra)} – ${money(t.maxExtra)} more</p>`
            : ''
        }
        <div class="progress-row">
          <div class="progress"><span style="width:${pct}%"></span></div>
          <small>${doneCount}/${list.items.length} done</small>
        </div>
      </section>
      <nav class="filters" aria-label="Filter">
        ${chip('all', 'All', state.filter === 'all')}
        ${list.tags.map((tag) => chip(tag.id, `<i data-color="${colorOf(tag)}"></i>${esc(tag.name)}`, state.filter === tag.id)).join('')}
        ${undecided ? chip('decide', `To decide · ${undecided}`, state.filter === 'decide') : ''}
        <button class="chip" data-action="hide-done" aria-pressed="${state.hideDone}">${state.hideDone ? 'Show done' : 'Hide done'}</button>
      </nav>
      ${timeline(list.items.filter(matchesFilter))}
    </main>
    ${
      canEdit
        ? `<form class="composer" id="quick-form" autocomplete="off">
            <button type="button" class="icon-btn" data-action="add-item" aria-label="Add with details">＋</button>
            <input id="quick-input" name="text" enterkeyhint="send" maxlength="2200"
              placeholder="Quick add: “sell bookcase” or paste a link" ${state.quickBusy ? 'disabled' : ''}>
            <button class="send" aria-label="Smart add" ${state.quickBusy ? 'disabled' : ''}>${state.quickBusy ? '<span class="spinner"></span>' : '✨'}</button>
          </form>`
        : ''
    }`;

  const quick = document.getElementById('quick-input');
  if (quick) {
    quick.value = draft;
    if (hadFocus) quick.focus();
    document.getElementById('quick-form').addEventListener('submit', quickAdd);
  }
  const filters = document.querySelector('.filters');
  if (filters) filters.scrollLeft = scrollX;
}

async function quickAdd(e) {
  e.preventDefault();
  const input = document.getElementById('quick-input');
  const text = input.value.trim();
  if (!text || state.quickBusy) return;
  state.quickBusy = true;
  renderList();
  let data;
  try {
    data = await api(`/lists/${state.list.id}/quick`, { method: 'POST', body: { text } });
  } catch (err) {
    toast(err.message, { error: true });
  }
  state.quickBusy = false;
  if (data) document.getElementById('quick-input').value = '';
  if (!data) return renderList();
  if (state.filter !== 'all' && state.filter !== 'decide' && state.filter !== data.added.tagId) state.filter = 'all';
  applyList(data);

  const { itemId, tagId, newTag } = data.added;
  const tag = tagById(tagId);
  toast(`${newTag ? 'New tag' : 'Added to'} “${tag?.name}”`, {
    action: { label: 'Edit', run: () => openItemForm(findItem(itemId)) },
  });
  const card = document.querySelector(`[data-id="${itemId}"]`);
  card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  card?.classList.add('flash');
}

function timeline(items) {
  if (!state.list.items.length) {
    return `<div class="empty">
      <p><strong>Nothing here yet.</strong></p>
      ${
        state.canEdit
          ? `<p>Type something below, like “sell the old bookcase” or “throw away broken chair”, or paste a link to a sofa you like.
             ✨ files it under the right tag for you.</p>
             <p>Use <b>＋</b> to add one with a date, a person and notes.</p>`
          : ''
      }
    </div>`;
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
    html += `<section class="month">
      <h2>${esc(monthName(key))}${key === thisMonth ? '<span class="now">This month</span>' : ''}<small>${count(total)}</small></h2>`;
    if (whole.length) html += `<div class="day-label">Any time this month</div>${cards(whole)}`;
    for (const day of [...days.keys()].sort()) {
      const cls = day === today ? 'today' : day < today ? 'past' : '';
      html += `<div class="day-label ${cls}">${day === today ? 'Today · ' : ''}${esc(dayName(day))}</div>${cards(days.get(day))}`;
    }
    html += '</section>';
  }
  if (undated.length) {
    html += `<section class="month"><h2>No date yet<small>${count(undated.length)}</small></h2>${cards(undated)}</section>`;
  }
  return html;
}

function itemCard(item, today) {
  const { canEdit, list } = state;
  const cost = itemCost(item);
  const income = isIncome(item, list.tags);
  const tags = item.tags.map(tagById).filter(Boolean);
  const overdue =
    !item.done && item.date && (item.date.length === 7 ? item.date < today.slice(0, 7) : item.date < today);

  let costHtml = '';
  if (!cost.decided) {
    costHtml = `<span class="cost undecided">${money(cost.min)} – ${money(cost.max)}</span>`;
  } else if (cost.amount) {
    costHtml = `<span class="cost ${income ? 'income' : ''}">${income ? '+' : ''}${money(cost.amount)}</span>`;
  }
  const addLabel = item.options.length ? '+ Alternative' : income ? '+ Listing' : '+ Link';

  return `
    <article class="item ${item.done ? 'done' : ''}" data-id="${item.id}" data-color="${colorOf(tags[0])}">
      <div class="item-row">
        <button class="check" data-action="toggle-done" data-item="${item.id}" aria-pressed="${item.done}"
          aria-label="${item.done ? 'Mark not done' : 'Mark done'}" ${canEdit ? '' : 'disabled'}>${ICON_CHECK}</button>
        <div class="item-main">
          <h3>${esc(item.title)}</h3>
          ${tags.length ? `<div class="tags">${tags.map((t) => tagPill(t)).join('')}</div>` : ''}
          ${
            item.date || item.assignee
              ? `<div class="meta">
                  ${item.date ? `<span class="${overdue ? 'overdue' : ''}">📅 ${esc(whenLabel(item.date))}</span>` : ''}
                  ${item.assignee ? `<span>👤 ${esc(item.assignee)}</span>` : ''}
                </div>`
              : ''
          }
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
  const hint = item.chosenId ? 'Chosen. Only this one counts toward the total.' : `Pick one of ${options.length}`;
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
            ? `<button class="btn small block ${chosen ? 'primary' : ''}" data-action="choose"
                data-item="${item.id}" data-opt="${o.id}">${chosen ? '✓ Chosen' : 'Choose'}</button>`
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
  sheet.innerHTML = `<form class="sheet-body" novalidate><div class="grabber"></div>${html}</form>`;
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

function tagPicker(selectedIds) {
  return `<div class="field"><span>Tags</span>
    <div class="tag-picker">
      ${state.list.tags
        .map(
          (tag) => `<label class="tag-toggle">
            <input type="checkbox" name="tag" value="${tag.id}" ${selectedIds.includes(tag.id) ? 'checked' : ''}>
            ${tagPill(tag)}</label>`,
        )
        .join('')}
      <span class="new-tag">
        <input type="text" maxlength="40" placeholder="+ New tag" aria-label="New tag" enterkeyhint="done">
      </span>
    </div></div>`;
}

// Typing a new tag name and pressing enter adds a selected chip (created on save).
function wireTagPicker(form) {
  const input = form.querySelector('.new-tag input');
  const addChip = () => {
    const name = input.value.trim();
    if (!name) return;
    input.value = '';
    const existing = [...form.querySelectorAll('input[name=tag]')].find(
      (el) => (tagById(el.value)?.name ?? el.value).toLowerCase() === name.toLowerCase(),
    );
    if (existing) {
      existing.checked = true;
      return;
    }
    const label = document.createElement('label');
    label.className = 'tag-toggle';
    label.innerHTML = `<input type="checkbox" name="tag" value="${esc(name)}" checked>${tagPill({ name, color: 'slate' })}`;
    input.parentElement.before(label);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addChip();
    }
  });
  input.addEventListener('blur', addChip);
}

function openItemForm(item) {
  if (!state.canEdit) return;
  const isNew = !item;
  const v = item || {
    title: '',
    tags: tagById(state.filter) ? [state.filter] : [],
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
    ${tagPicker(v.tags)}
    <div class="field"><span>When</span><div class="seg">
      ${radio('when', 'none', 'No date', mode === 'none')}
      ${radio('when', 'day', 'A day', mode === 'day')}
      ${radio('when', 'month', 'A month', mode === 'month')}
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
    async (data, form) => {
      form.querySelector('.new-tag input').dispatchEvent(new Event('blur'));
      const date = data.when === 'day' ? data.day : data.when === 'month' ? data.month : '';
      if (data.when !== 'none' && !date) {
        toast(data.when === 'day' ? 'Pick a day' : 'Pick a month', { error: true });
        return false;
      }
      const tags = [...form.querySelectorAll('input[name=tag]:checked')].map((el) => el.value);
      const body = { title: data.title, tags, date, assignee: data.assignee, notes: data.notes };
      return isNew ? mutate('/items', 'POST', body) : mutate(`/items/${item.id}`, 'PATCH', body);
    },
  );

  wireTagPicker(form);
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
    <div class="field"><span>Link</span><div class="input-row">
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
  return `<div class="field"><span>${label}</span><div class="input-row">
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

function tagRows() {
  return state.list.tags
    .map(
      (tag) => `<div class="tag-row" data-tag="${tag.id}">
        <button type="button" class="swatch" data-action="cycle-color" data-tag="${tag.id}" data-color="${colorOf(tag)}"
          aria-label="Change colour"></button>
        <input class="tag-name" value="${esc(tag.name)}" maxlength="40" aria-label="Tag name" data-tag="${tag.id}">
        <select class="tag-money" data-tag="${tag.id}" aria-label="How prices count">
          <option value="spend" ${tag.money === 'spend' ? 'selected' : ''}>Costs</option>
          <option value="income" ${tag.money === 'income' ? 'selected' : ''}>Income</option>
        </select>
        <button type="button" class="icon-btn" data-action="delete-tag" data-tag="${tag.id}" aria-label="Delete tag">✕</button>
      </div>`,
    )
    .join('');
}

function openSettings() {
  const { title, currency } = state.list;
  const options = CURRENCIES.includes(currency) ? CURRENCIES : [currency, ...CURRENCIES];
  const form = openSheet(
    `
    <h2>Plan settings</h2>
    <div class="row">
      <label class="field grow"><span>Name</span><input name="title" required maxlength="120" value="${esc(title)}"></label>
      <label class="field"><span>Currency</span>
        <select name="currency">${options.map((c) => `<option ${c === currency ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
    </div>
    <div class="field"><span>Tags</span>
      <p class="hint">“Income” tags count prices as money coming in (like selling). Changes save right away.</p>
      <div class="tag-rows">${tagRows()}</div>
      <div class="input-row">
        <input class="new-tag-name" maxlength="40" placeholder="New tag, e.g. Kitchen" enterkeyhint="done">
        <button type="button" class="btn small" data-action="add-tag">Add</button>
      </div>
    </div>
    ${sheetActions('')}`,
    (data) => mutate('', 'PATCH', { title: data.title, currency: data.currency }),
  );

  const refreshRows = () => (form.querySelector('.tag-rows').innerHTML = tagRows());
  form.addEventListener('change', async (e) => {
    const id = e.target.dataset.tag;
    if (!id) return;
    if (e.target.classList.contains('tag-name')) {
      if (!(await mutate(`/tags/${id}`, 'PATCH', { name: e.target.value }))) refreshRows();
    }
    if (e.target.classList.contains('tag-money')) await mutate(`/tags/${id}`, 'PATCH', { money: e.target.value });
  });
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (e.target.classList.contains('new-tag-name')) {
      e.preventDefault();
      actions['add-tag'](e.target);
    } else if (e.target.classList.contains('tag-name')) {
      e.preventDefault();
      e.target.blur();
    }
  });
  form.refreshRows = refreshRows;
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
  'add-tag': async (el) => {
    const form = el.closest('form');
    const input = form.querySelector('.new-tag-name');
    if (!input.value.trim()) return;
    if (await mutate('/tags', 'POST', { name: input.value })) {
      input.value = '';
      form.refreshRows();
    }
  },
  'delete-tag': async (el) => {
    const tag = tagById(el.dataset.tag);
    const used = state.list.items.filter((i) => i.tags.includes(tag.id)).length;
    if (!confirm(`Delete the tag “${tag.name}”?${used ? ` It is removed from ${used} item(s); the items stay.` : ''}`)) return;
    if (await mutate(`/tags/${tag.id}`, 'DELETE')) el.closest('form').refreshRows();
  },
  'cycle-color': async (el) => {
    const tag = tagById(el.dataset.tag);
    const color = TAG_COLORS[(TAG_COLORS.indexOf(colorOf(tag)) + 1) % TAG_COLORS.length];
    if (await mutate(`/tags/${tag.id}`, 'PATCH', { color })) el.dataset.color = color;
  },
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
      toast('Couldn’t copy. Select the link and copy it manually.', { error: true });
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

const ICON_SHARE =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>';
const ICON_GEAR =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>';
const ICON_CHECK =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

// ---- start ----------------------------------------------------------------

const match = location.pathname.match(/^\/l\/([A-Za-z0-9_-]+)/);
if (match) openList(match[1]);
else renderHome();
