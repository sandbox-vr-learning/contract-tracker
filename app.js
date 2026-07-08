import {
  dbGetSession, dbOnAuthStateChange, dbSignInWithEmail, dbSignOut, dbGetCurrentUserRole,
  dbFetchContracts, dbUpsertContract, dbDeleteContract,
  dbFetchOwners, dbFindOrCreateOwner, dbSetContractOwners,
  dbFetchCategories, dbUpsertCategory, dbDeleteCategory,
  dbFetchAlertThresholds, dbUpsertAlertThreshold, dbDeleteAlertThreshold,
  dbFetchUserRoles, dbUpsertUserRole, dbDeleteUserRole,
} from './db.js';

const state = {
  session: null,
  role: null,
  view: 'dashboard',
  contracts: [],
  owners: [],
  categories: [],
  userRoles: [],
  thresholds: [],
  importRows: [],
  editingContractId: null,
  modalOwners: [],
  sort: { field: 'renewal_deadline', dir: 'asc' },
};

const MONTHS = { Jan:0, Feb:1, Mar:2, Apr:3, May:4, Jun:5, Jul:6, Aug:7, Sep:8, Oct:9, Nov:10, Dec:11 };

// ---------- Utilities ----------

function $(sel) { return document.querySelector(sel); }
function $all(sel) { return Array.from(document.querySelectorAll(sel)); }

function money(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function fmtDate(d) {
  if (!d) return '—';
  const date = new Date(d + 'T00:00:00');
  if (isNaN(date)) return '—';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function daysUntil(dateStr) {
  if (!dateStr) return Infinity;
  const target = new Date(dateStr + 'T00:00:00');
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target - today) / 86400000);
}

// The date that actually matters: renewal_deadline minus notice_period_days, if set.
function relevantDeadline(contract) {
  if (!contract.notice_period_days || !contract.renewal_deadline) return contract.renewal_deadline;
  const d = new Date(contract.renewal_deadline + 'T00:00:00');
  d.setDate(d.getDate() - contract.notice_period_days);
  return d.toISOString().slice(0, 10);
}

// Multi-year totals get divided by their term so the dashboard shows a true annual figure.
function annualizedValue(c) {
  const v = Number(c.total_value) || 0;
  if (c.value_type === 'multi_year' && c.contract_term_years > 0) return v / c.contract_term_years;
  return v;
}

function toast(message, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function ownersText(owners) {
  return (owners ?? []).map((o) => o.name).join(', ') || '—';
}

function valueTypeBadge(c) {
  if (!c.value_type) return '<span class="badge badge-orange">Needs review</span>';
  const labels = {
    annual: 'Annual',
    multi_year: `Multi-year${c.contract_term_years ? ` (${c.contract_term_years}y)` : ''}`,
    one_time: 'One-time',
  };
  return `<span class="badge badge-blue">${esc(labels[c.value_type] || c.value_type)}</span>`;
}

function statusBadge(status) {
  const map = { active: 'badge-green', cancelled: 'badge-red', expired: 'badge-grey' };
  return `<span class="badge ${map[status] || 'badge-grey'}">${esc(status || 'active')}</span>`;
}

function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Parses "Jane Doe (jane.doe@sandboxvr.com), it (it@sandboxvr.com)" into [{name, email}] — used only by CSV import.
function parseOwnersField(text) {
  if (!text) return [];
  const matches = [...text.matchAll(/([^,()]+?)\s*[\(<]([^)>]+)[\)>]/g)];
  return matches
    .map((m) => ({ name: m[1].trim(), email: m[2].trim().toLowerCase() }))
    .filter((o) => o.name && o.email);
}

function parseCurrency(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/[$,]/g, '').trim();
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return isNaN(n) ? null : n;
}

// Parses "Jun 28, 2023" into "2023-06-28"
function parseVendrDate(text) {
  if (!text) return null;
  const m = String(text).trim().match(/^([A-Za-z]{3})\w*\s+(\d{1,2}),\s*(\d{4})$/);
  if (!m) return null;
  const month = MONTHS[m[1].slice(0, 3)];
  if (month === undefined) return null;
  const day = String(m[2]).padStart(2, '0');
  const monthStr = String(month + 1).padStart(2, '0');
  return `${m[3]}-${monthStr}-${day}`;
}

// Minimal RFC4180-ish CSV parser (handles quoted fields with commas/newlines).
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else if (c === '\r') {
      // skip, \n handles the row break
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  const headers = rows.shift().map((h) => h.trim());
  return rows
    .filter((r) => r.some((v) => v.trim() !== ''))
    .map((r) => Object.fromEntries(headers.map((h, i) => [h, (r[i] ?? '').trim()])));
}

// Suggests the next contract ref by finding the highest existing C-### number.
function suggestNextRef() {
  const refs = state.contracts.map((c) => c.contract_ref).filter(Boolean);
  const parsed = refs
    .map((ref) => ({ ref, match: ref.match(/^C-(\d+)/) }))
    .filter((r) => r.match);
  if (!parsed.length) return 'C-001';
  const top = parsed.reduce((best, cur) => (parseInt(cur.match[1], 10) > parseInt(best.match[1], 10) ? cur : best));
  const nextNum = parseInt(top.match[1], 10) + 1;
  return `C-${String(nextNum).padStart(top.match[1].length, '0')}`;
}

// ---------- Auth ----------

async function init() {
  state.session = await dbGetSession();
  dbOnAuthStateChange(async (session) => {
    state.session = session;
    await afterAuthChange();
  });
  await afterAuthChange();
  bindStaticEvents();
}

async function afterAuthChange() {
  if (!state.session) {
    showScreen('login');
    return;
  }
  const email = state.session.user.email;
  state.role = await dbGetCurrentUserRole(email);
  if (!state.role) {
    $('#no-access-email').textContent = email;
    showScreen('no-access');
    return;
  }
  $('#current-user-email').textContent = email + ' (' + state.role + ')';
  $('#nav-access').classList.toggle('hidden', state.role !== 'admin');
  showScreen('app');
  await loadAllData();
  navigate(state.view);
}

function showScreen(which) {
  $('#login-screen').classList.toggle('hidden', which !== 'login');
  $('#no-access-screen').classList.toggle('hidden', which !== 'no-access');
  $('#app-shell').classList.toggle('hidden', which !== 'app');
}

async function loadAllData() {
  try {
    state.contracts = await dbFetchContracts();
    state.owners = await dbFetchOwners();
    state.categories = await dbFetchCategories();
    state.thresholds = await dbFetchAlertThresholds();
    populateCategoryDropdowns();
    if (state.role === 'admin') state.userRoles = await dbFetchUserRoles();
    updateActionBadge();
  } catch (e) {
    toast('Failed to load data: ' + e.message, true);
  }
}

function populateCategoryDropdowns() {
  const options = state.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');

  const modalSelect = $('#cm-category');
  const modalVal = modalSelect.value;
  modalSelect.innerHTML = `<option value="">Uncategorized</option>${options}`;
  modalSelect.value = modalVal;

  const filterSelect = $('#filter-category');
  const filterVal = filterSelect.value;
  filterSelect.innerHTML = `<option value="">All categories</option>${options}`;
  filterSelect.value = filterVal;
}

// ---------- Navigation ----------

function navigate(view) {
  state.view = view;
  $all('.view').forEach((v) => v.classList.add('hidden'));
  $('#view-' + view)?.classList.remove('hidden');
  $all('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === view));

  if (view === 'dashboard') renderDashboard();
  if (view === 'contracts') renderContracts();
  if (view === 'action') renderActionRequired();
  if (view === 'access') renderAccess();
}

// ---------- Dashboard ----------

function renderDashboard() {
  const active = state.contracts.filter((c) => c.status === 'active');
  const totalValue = active.reduce((sum, c) => sum + annualizedValue(c), 0);
  const totalSavings = state.contracts.reduce((sum, c) => sum + (Number(c.negotiated_savings) || 0), 0);

  $('#stat-total-value').textContent = money(totalValue);
  $('#stat-active-count').textContent = active.length;
  $('#stat-savings').textContent = money(totalSavings);

  const withDeadline = active
    .map((c) => ({ ...c, _relevant: relevantDeadline(c), _days: daysUntil(relevantDeadline(c)) }))
    .filter((c) => c._relevant && c._days >= 0)
    .sort((a, b) => a._days - b._days);

  $('#stat-30').textContent = withDeadline.filter((c) => c._days <= 30).length;
  $('#stat-90').textContent = withDeadline.filter((c) => c._days <= 90).length;

  const biggest = [...active]
    .filter((c) => c.total_value)
    .sort((a, b) => b.total_value - a.total_value)
    .slice(0, 5);
  $('#biggest-renewals').innerHTML = biggest.length
    ? biggest.map((c) => `
        <tr>
          <td>${esc(c.contract_ref)}</td>
          <td>${esc(c.supplier || '—')}</td>
          <td><span class="badge badge-blue">${money(c.total_value)}</span></td>
          <td>${fmtDate(relevantDeadline(c))}</td>
        </tr>
      `).join('')
    : '<tr><td colspan="4" class="muted">No active contracts yet.</td></tr>';

  renderNeedsReview(active);
  renderAutoRenewRisk(withDeadline);
  renderPastDeadline(active);
  renderStageBreakdown(active);
  renderCategoryChart(active);
  renderUpcomingRenewals(withDeadline);
  $('#renewal-window').onchange = () => renderUpcomingRenewals(withDeadline);
  updateActionBadge();
}

function renderNeedsReview(active) {
  const rows = active.filter((c) => !c.value_type);
  $('#needs-review-card').classList.toggle('hidden', rows.length === 0);
  $('#needs-review-list').innerHTML = rows.map((c) => `
    <div class="alert-row">
      <div><strong>${esc(c.contract_ref)}</strong> — ${esc(c.supplier || 'Unknown supplier')} (${money(c.total_value)})</div>
      <button class="btn btn-secondary" data-classify="${c.id}">Classify</button>
    </div>
  `).join('');
  $all('[data-classify]').forEach((btn) => btn.onclick = () => openContractModal(btn.dataset.classify));
}

function renderAutoRenewRisk(withDeadline) {
  const rows = withDeadline.filter((c) => c.auto_renew && c._days <= 90);
  $('#auto-renew-card').classList.toggle('hidden', rows.length === 0);
  $('#auto-renew-list').innerHTML = rows.map((c) => `
    <div class="alert-row">
      <div><strong>${esc(c.contract_ref)}</strong> — ${esc(c.supplier || 'Unknown supplier')} renews in ${c._days}d (${fmtDate(c._relevant)})</div>
      <span class="badge badge-orange">${money(c.total_value)}</span>
    </div>
  `).join('');
}

function renderPastDeadline(active) {
  const rows = active.filter((c) => c.renewal_deadline && daysUntil(c.renewal_deadline) < 0);
  $('#past-deadline-card').classList.toggle('hidden', rows.length === 0);
  $('#past-deadline-list').innerHTML = rows.map((c) => `
    <div class="alert-row">
      <div><strong>${esc(c.contract_ref)}</strong> — ${esc(c.supplier || 'Unknown supplier')} was due ${fmtDate(c.renewal_deadline)} (${Math.abs(daysUntil(c.renewal_deadline))}d ago)</div>
      <button class="btn btn-secondary" data-classify="${c.id}">Review</button>
    </div>
  `).join('');
  $all('[data-classify]').forEach((btn) => btn.onclick = () => openContractModal(btn.dataset.classify));
}

function renderStageBreakdown(active) {
  const counts = {};
  active.forEach((c) => {
    const stage = c.renewal_stage || 'Not started';
    counts[stage] = (counts[stage] || 0) + 1;
  });
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...entries.map((e) => e[1]), 1);
  $('#stage-breakdown').innerHTML = entries.length
    ? entries.map(([stage, count]) => `
        <div class="bar-row">
          <div>${esc(stage)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${(count / max * 100).toFixed(0)}%"></div></div>
          <div class="bar-value">${count}</div>
        </div>
      `).join('')
    : '<p class="muted">No active contracts yet.</p>';
}

function renderCategoryChart(active) {
  const sums = {};
  active.forEach((c) => {
    const cat = c.category_name || 'Uncategorized';
    sums[cat] = (sums[cat] || 0) + (Number(c.total_value) || 0);
  });
  const entries = Object.entries(sums).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...entries.map((e) => e[1]), 1);
  $('#category-chart').innerHTML = entries.length
    ? entries.map(([cat, value]) => `
        <div class="bar-row">
          <div>${esc(cat)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${(value / max * 100).toFixed(0)}%"></div></div>
          <div class="bar-value">${money(value)}</div>
        </div>
      `).join('')
    : '<p class="muted">No active contracts yet.</p>';
}

function renderUpcomingRenewals(withDeadline) {
  const windowDays = Number($('#renewal-window').value);
  const rows = withDeadline.filter((c) => c._days <= windowDays);
  $('#upcoming-empty').classList.toggle('hidden', rows.length > 0);
  $('#upcoming-renewals-body').innerHTML = rows.map((c) => {
    const urgencyClass = c._days <= 30 ? 'urgency-30' : c._days <= 60 ? 'urgency-60' : 'urgency-90';
    return `
      <tr class="${urgencyClass}">
        <td>${esc(c.contract_ref)}</td>
        <td>${esc(c.supplier || '—')}</td>
        <td>${money(c.total_value)}</td>
        <td>${fmtDate(c._relevant)} <span class="muted">(${c._days}d)</span></td>
        <td>${esc(ownersText(c.owners))}</td>
      </tr>
    `;
  }).join('');
}

// ---------- Action Required ----------

function computeActionItems() {
  return state.contracts
    .filter((c) => c.status === 'active')
    .map((c) => {
      const issues = [];
      if (!c.value_type) issues.push('Unclassified value');
      if (!c.category_id) issues.push('Uncategorized');
      if (c.renewal_deadline && daysUntil(c.renewal_deadline) < 0) issues.push('Past deadline');
      return { ...c, issues };
    })
    .filter((c) => c.issues.length > 0)
    .sort((a, b) => b.issues.length - a.issues.length);
}

function updateActionBadge() {
  const count = computeActionItems().length;
  const badge = $('#nav-action-count');
  badge.textContent = count;
  badge.classList.toggle('hidden', count === 0);
}

function renderActionRequired() {
  const canEdit = state.role === 'admin' || state.role === 'editor';
  const items = computeActionItems();
  $('#action-required-empty').classList.toggle('hidden', items.length > 0);
  $('#action-required-body').innerHTML = items.map((c) => `
    <tr>
      <td>${esc(c.contract_ref)}</td>
      <td>${esc(c.supplier || '—')}</td>
      <td>${money(c.total_value)}</td>
      <td>${fmtDate(c.renewal_deadline)}</td>
      <td>${c.issues.map((i) => `<span class="badge badge-orange">${esc(i)}</span>`).join(' ')}</td>
      <td>${canEdit ? `<button class="btn btn-secondary" data-edit="${c.id}">Edit</button>` : ''}</td>
    </tr>
  `).join('');
  $all('#action-required-body [data-edit]').forEach((btn) => btn.onclick = () => openContractModal(btn.dataset.edit));
}

// ---------- Contracts ----------

function sortContracts(rows) {
  const { field, dir } = state.sort;
  const mult = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    let av = a[field];
    let bv = b[field];
    if (field === 'total_value') { av = Number(av) || 0; bv = Number(bv) || 0; }
    if (av === null || av === undefined) av = '';
    if (bv === null || bv === undefined) bv = '';
    if (av < bv) return -1 * mult;
    if (av > bv) return 1 * mult;
    return 0;
  });
}

function renderSortArrows() {
  $all('th.sortable').forEach((th) => {
    th.querySelector('.sort-arrow')?.remove();
    if (th.dataset.sort === state.sort.field) {
      const arrow = document.createElement('span');
      arrow.className = 'sort-arrow';
      arrow.textContent = state.sort.dir === 'asc' ? '↑' : '↓';
      th.appendChild(arrow);
    }
  });
}

function renderContracts() {
  const canEdit = state.role === 'admin' || state.role === 'editor';
  const search = ($('#contracts-search').value || '').toLowerCase();
  const statusFilter = $('#filter-status').value;
  const categoryFilter = $('#filter-category').value;

  let rows = state.contracts.filter((c) => {
    if (search && !(c.contract_ref?.toLowerCase().includes(search) || c.supplier?.toLowerCase().includes(search))) return false;
    if (statusFilter && c.status !== statusFilter) return false;
    if (categoryFilter && c.category_id !== categoryFilter) return false;
    return true;
  });
  rows = sortContracts(rows);

  $('#add-contract-btn').classList.toggle('hidden', !canEdit);

  $('#contracts-body').innerHTML = rows.map((c) => `
    <tr>
      <td>${esc(c.contract_ref)}</td>
      <td>${esc(c.supplier || '—')}</td>
      <td>${esc(c.category_name || '—')}</td>
      <td>${money(c.total_value)}</td>
      <td>${fmtDate(c.renewal_deadline)}</td>
      <td>${c.notice_period_days ?? '—'}</td>
      <td>${c.auto_renew ? '<span class="badge badge-green">Yes</span>' : '<span class="badge badge-grey">No</span>'}</td>
      <td>${esc(c.renewal_stage || '—')}</td>
      <td>${statusBadge(c.status)}</td>
      <td>${esc(ownersText(c.owners))}</td>
      <td>${valueTypeBadge(c)}</td>
      <td>${c.negotiated_savings ? money(c.negotiated_savings) : '—'}${c.negotiated_savings_pct ? ` (${c.negotiated_savings_pct}%)` : ''}</td>
      <td class="muted">${esc(c.notes || '')}</td>
      <td>
        ${canEdit ? `
          <button class="btn btn-secondary" data-edit="${c.id}">Edit</button>
          <button class="btn btn-danger" data-delete="${c.id}">Delete</button>
        ` : ''}
      </td>
    </tr>
  `).join('');

  $all('[data-edit]').forEach((btn) => btn.onclick = () => openContractModal(btn.dataset.edit));
  $all('[data-delete]').forEach((btn) => btn.onclick = () => deleteContract(btn.dataset.delete));
  renderSortArrows();
}

// ---------- Owners picker ----------

function renderOwnerChips() {
  $('#cm-owner-chips').innerHTML = state.modalOwners.map((o) => `
    <span class="owner-chip">${esc(o.name)} <button type="button" data-remove-owner="${o.id}">×</button></span>
  `).join('');
  $all('[data-remove-owner]').forEach((btn) => btn.onclick = () => {
    state.modalOwners = state.modalOwners.filter((o) => o.id !== btn.dataset.removeOwner);
    renderOwnerChips();
  });
}

function addOwnerToModal(owner) {
  if (!owner || state.modalOwners.find((o) => o.id === owner.id)) return;
  state.modalOwners.push(owner);
  $('#cm-owner-search').value = '';
  $('#cm-owner-suggestions').classList.add('hidden');
  renderOwnerChips();
}

async function createAndAddOwner(email) {
  const name = prompt(`Name for ${email}?`);
  if (!name) return;
  try {
    const owner = await dbFindOrCreateOwner(name, email);
    if (!state.owners.find((o) => o.id === owner.id)) {
      state.owners.push(owner);
      state.owners.sort((a, b) => a.name.localeCompare(b.name));
    }
    addOwnerToModal(owner);
  } catch (e) {
    toast('Failed to add owner: ' + e.message, true);
  }
}

function renderOwnerSuggestions(query) {
  const q = query.trim().toLowerCase();
  const box = $('#cm-owner-suggestions');
  if (!q) { box.classList.add('hidden'); box.innerHTML = ''; return; }

  const selectedIds = new Set(state.modalOwners.map((o) => o.id));
  const matches = state.owners
    .filter((o) => !selectedIds.has(o.id) && (o.name.toLowerCase().includes(q) || o.email.toLowerCase().includes(q)))
    .slice(0, 8);

  let html = matches.map((o) => `<div class="owner-suggestion" data-add-owner="${o.id}">${esc(o.name)} <span class="email">${esc(o.email)}</span></div>`).join('');
  if (q.includes('@') && !matches.some((o) => o.email.toLowerCase() === q)) {
    html += `<div class="owner-suggestion create-new" data-create-owner="${esc(q)}">+ Add new owner "${esc(q)}"</div>`;
  }
  box.innerHTML = html || '<div class="owner-suggestion muted">No matches</div>';
  box.classList.remove('hidden');

  $all('[data-add-owner]').forEach((el) => el.onclick = () => addOwnerToModal(matches.find((o) => o.id === el.dataset.addOwner)));
  $all('[data-create-owner]').forEach((el) => el.onclick = () => createAndAddOwner(el.dataset.createOwner));
}

// ---------- Contract modal ----------

function openContractModal(id) {
  state.editingContractId = id || null;
  const c = id ? state.contracts.find((x) => x.id === id) : null;

  $('#contract-modal-title').textContent = c ? 'Edit contract' : 'Add contract';
  $('#cm-ref').value = c ? c.contract_ref : suggestNextRef();
  $('#cm-supplier').value = c?.supplier || '';
  $('#cm-category').value = c?.category_id || '';
  $('#cm-value').value = c?.total_value ?? '';
  $('#cm-value-type').value = c?.value_type || '';
  $('#cm-term-years').value = c?.contract_term_years ?? '';
  $('#cm-term-years-field').classList.toggle('hidden', c?.value_type !== 'multi_year');
  $('#cm-deadline').value = c?.renewal_deadline || '';
  $('#cm-notice').value = c?.notice_period_days ?? '';
  $('#cm-autorenew').value = String(c?.auto_renew ?? false);
  $('#cm-stage').value = c?.renewal_stage || 'Not started';
  $('#cm-status').value = c?.status || 'active';
  $('#cm-savings').value = c?.negotiated_savings ?? '';
  $('#cm-savings-pct').value = c?.negotiated_savings_pct ?? '';
  $('#cm-notes').value = c?.notes || '';

  state.modalOwners = [...(c?.owners ?? [])];
  $('#cm-owner-search').value = '';
  $('#cm-owner-suggestions').classList.add('hidden');
  renderOwnerChips();

  $('#contract-modal').classList.remove('hidden');
}

function closeContractModal() {
  $('#contract-modal').classList.add('hidden');
  state.editingContractId = null;
}

async function saveContractFromModal() {
  const ref = $('#cm-ref').value.trim();
  if (!ref) { toast('Contract ref is required', true); return; }

  const valueType = $('#cm-value-type').value || null;
  const payload = {
    id: state.editingContractId || undefined,
    contract_ref: ref,
    supplier: $('#cm-supplier').value.trim() || null,
    category_id: $('#cm-category').value || null,
    total_value: $('#cm-value').value ? Number($('#cm-value').value) : null,
    value_type: valueType,
    contract_term_years: valueType === 'multi_year' && $('#cm-term-years').value ? Number($('#cm-term-years').value) : null,
    renewal_deadline: $('#cm-deadline').value || null,
    notice_period_days: $('#cm-notice').value ? Number($('#cm-notice').value) : null,
    auto_renew: $('#cm-autorenew').value === 'true',
    renewal_stage: $('#cm-stage').value.trim() || 'Not started',
    status: $('#cm-status').value,
    negotiated_savings: $('#cm-savings').value ? Number($('#cm-savings').value) : null,
    negotiated_savings_pct: $('#cm-savings-pct').value ? Number($('#cm-savings-pct').value) : null,
    notes: $('#cm-notes').value.trim() || null,
  };

  try {
    const saved = await dbUpsertContract(payload);
    await dbSetContractOwners(saved.id, state.modalOwners.map((o) => o.id));

    toast('Contract saved');
    closeContractModal();
    state.contracts = await dbFetchContracts();
    renderContracts();
    updateActionBadge();
  } catch (e) {
    toast('Save failed: ' + e.message, true);
  }
}

async function deleteContract(id) {
  const c = state.contracts.find((x) => x.id === id);
  if (!confirm(`Delete contract ${c?.contract_ref}? This cannot be undone.`)) return;
  try {
    await dbDeleteContract(id);
    state.contracts = state.contracts.filter((x) => x.id !== id);
    renderContracts();
    updateActionBadge();
    toast('Contract deleted');
  } catch (e) {
    toast('Delete failed: ' + e.message, true);
  }
}

// ---------- CSV Import ----------

function handleCSVFileSelected() {
  $('#parse-csv-btn').disabled = !$('#csv-file').files.length;
}

async function parseCSVFile() {
  const file = $('#csv-file').files[0];
  if (!file) return;
  const text = await file.text();
  const raw = parseCSV(text);

  state.importRows = raw.map((r) => ({
    contract_ref: r['Name']?.trim() || null,
    supplier: r['Supplier']?.trim() || null,
    total_value: parseCurrency(r['Total value']),
    renewal_deadline: parseVendrDate(r['Renewal deadline']),
    auto_renew: (r['Auto-renew'] || '').trim().toLowerCase() === 'yes',
    renewal_stage: r['Renewal stage']?.trim() || 'Not started',
    owners: parseOwnersField(r['Owners']),
    negotiated_savings: parseCurrency(r['Negotiated savings']),
    negotiated_savings_pct: r['Negotiated savings %'] ? parseCurrency(r['Negotiated savings %']) : null,
    status: 'active',
  })).filter((r) => r.contract_ref);

  $('#import-count').textContent = state.importRows.length;
  $('#import-preview-body').innerHTML = state.importRows.slice(0, 50).map((r) => `
    <tr>
      <td>${esc(r.contract_ref)}</td>
      <td>${esc(r.supplier)}</td>
      <td>${money(r.total_value)}</td>
      <td>${fmtDate(r.renewal_deadline)}</td>
      <td>${r.auto_renew ? 'Yes' : 'No'}</td>
      <td>${esc(r.renewal_stage)}</td>
      <td>${esc(r.owners.map((o) => o.name).join(', '))}</td>
    </tr>
  `).join('');
  $('#import-preview-card').classList.remove('hidden');
  $('#import-status').textContent = `Parsed ${state.importRows.length} rows. Review below, then import.`;
}

async function confirmImport() {
  $('#confirm-import-btn').disabled = true;
  let ok = 0, failed = 0;
  for (const row of state.importRows) {
    try {
      const { owners, ...fields } = row;
      const saved = await dbUpsertContract(fields);
      if (owners.length) {
        const ownerRecords = await Promise.all(owners.map((o) => dbFindOrCreateOwner(o.name, o.email)));
        await dbSetContractOwners(saved.id, ownerRecords.map((o) => o.id));
      }
      ok++;
    } catch (e) {
      failed++;
    }
  }
  $('#import-status').textContent = `Imported ${ok} contracts${failed ? `, ${failed} failed` : ''}.`;
  $('#confirm-import-btn').disabled = false;
  state.contracts = await dbFetchContracts();
  state.owners = await dbFetchOwners();
  updateActionBadge();
  toast(`Import complete: ${ok} contracts`);
}

// ---------- CSV Export ----------

function exportCSV() {
  const headers = ['Name','Supplier','Category','Total value','Value type','Contract term (years)','Renewal deadline','Notice period (days)','Auto-renew','Renewal stage','Status','Owners','Negotiated savings','Negotiated savings %','Notes'];
  const lines = [headers.join(',')];
  for (const c of state.contracts) {
    const row = [
      c.contract_ref, c.supplier, c.category_name ?? '', c.total_value ?? '', c.value_type ?? '', c.contract_term_years ?? '',
      c.renewal_deadline ?? '', c.notice_period_days ?? '', c.auto_renew ? 'Yes' : 'No', c.renewal_stage,
      c.status, ownersText(c.owners), c.negotiated_savings ?? '', c.negotiated_savings_pct ?? '', c.notes ?? '',
    ].map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`);
    lines.push(row.join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `contracts-export-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------- Admin: access control, alert timing, categories ----------

function renderAccess() {
  if (state.role !== 'admin') return;

  $('#access-body').innerHTML = state.userRoles.map((u) => `
    <tr>
      <td>${esc(u.email)}</td>
      <td>${esc(u.role)}</td>
      <td><button class="btn btn-danger" data-remove-role="${u.id}">Remove</button></td>
    </tr>
  `).join('');
  $all('[data-remove-role]').forEach((btn) => btn.onclick = () => removeUserRole(btn.dataset.removeRole));

  $('#thresholds-body').innerHTML = state.thresholds.map((t) => `
    <tr>
      <td>${t.days_before}</td>
      <td><input type="checkbox" data-threshold-toggle="${t.id}" ${t.enabled ? 'checked' : ''} /></td>
      <td><button class="btn btn-danger" data-remove-threshold="${t.id}">Remove</button></td>
    </tr>
  `).join('');
  $all('[data-threshold-toggle]').forEach((cb) => cb.onchange = () => toggleThreshold(cb.dataset.thresholdToggle, cb.checked));
  $all('[data-remove-threshold]').forEach((btn) => btn.onclick = () => removeThreshold(btn.dataset.removeThreshold));

  $('#categories-body').innerHTML = state.categories.map((c) => `
    <tr>
      <td>${esc(c.name)}</td>
      <td><button class="btn btn-danger" data-remove-category="${c.id}">Delete</button></td>
    </tr>
  `).join('');
  $all('[data-remove-category]').forEach((btn) => btn.onclick = () => removeCategory(btn.dataset.removeCategory));
}

async function saveUserRole() {
  const email = $('#access-email').value.trim().toLowerCase();
  const role = $('#access-role').value;
  if (!email) { toast('Email is required', true); return; }
  try {
    await dbUpsertUserRole({ email, role });
    state.userRoles = await dbFetchUserRoles();
    $('#access-email').value = '';
    renderAccess();
    toast('Access updated');
  } catch (e) {
    toast('Failed: ' + e.message, true);
  }
}

async function removeUserRole(id) {
  if (!confirm('Remove this person\'s access?')) return;
  try {
    await dbDeleteUserRole(id);
    state.userRoles = state.userRoles.filter((u) => u.id !== id);
    renderAccess();
  } catch (e) {
    toast('Failed: ' + e.message, true);
  }
}

async function toggleThreshold(id, enabled) {
  try {
    await dbUpsertAlertThreshold({ id, enabled });
    state.thresholds = await dbFetchAlertThresholds();
  } catch (e) {
    toast('Failed: ' + e.message, true);
  }
}

async function removeThreshold(id) {
  try {
    await dbDeleteAlertThreshold(id);
    state.thresholds = state.thresholds.filter((t) => t.id !== id);
    renderAccess();
  } catch (e) {
    toast('Failed: ' + e.message, true);
  }
}

async function addThreshold() {
  const days = Number($('#new-threshold-days').value);
  if (!days || days < 0) { toast('Enter a valid number of days', true); return; }
  try {
    await dbUpsertAlertThreshold({ days_before: days, enabled: true });
    state.thresholds = await dbFetchAlertThresholds();
    $('#new-threshold-days').value = '';
    renderAccess();
  } catch (e) {
    toast('Failed: ' + e.message, true);
  }
}

async function addCategory() {
  const name = $('#new-category-name').value.trim();
  if (!name) { toast('Enter a category name', true); return; }
  try {
    await dbUpsertCategory({ name });
    state.categories = await dbFetchCategories();
    $('#new-category-name').value = '';
    populateCategoryDropdowns();
    renderAccess();
    toast('Category added');
  } catch (e) {
    toast('Failed: ' + e.message, true);
  }
}

async function removeCategory(id) {
  if (!confirm('Delete this category? Contracts using it will become Uncategorized.')) return;
  try {
    await dbDeleteCategory(id);
    state.categories = state.categories.filter((c) => c.id !== id);
    populateCategoryDropdowns();
    renderAccess();
    state.contracts = await dbFetchContracts();
    updateActionBadge();
  } catch (e) {
    toast('Failed: ' + e.message, true);
  }
}

// ---------- Event binding ----------

function bindStaticEvents() {
  $('#login-submit').onclick = async () => {
    const email = $('#login-email').value.trim();
    if (!email) return;
    try {
      await dbSignInWithEmail(email);
      $('#login-status').textContent = 'Check your email for a magic link.';
    } catch (e) {
      $('#login-status').textContent = 'Error: ' + e.message;
    }
  };

  $('#no-access-signout').onclick = () => dbSignOut();
  $('#signout-btn').onclick = () => dbSignOut();

  $all('.nav-item[data-view]').forEach((n) => n.onclick = () => navigate(n.dataset.view));

  $('#export-csv-btn').onclick = exportCSV;
  $('#contracts-search').oninput = renderContracts;
  $('#filter-status').onchange = renderContracts;
  $('#filter-category').onchange = renderContracts;
  $all('th.sortable').forEach((th) => th.onclick = () => {
    if (state.sort.field === th.dataset.sort) {
      state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      state.sort = { field: th.dataset.sort, dir: 'asc' };
    }
    renderContracts();
  });

  $('#add-contract-btn').onclick = () => openContractModal(null);
  $('#cm-cancel').onclick = closeContractModal;
  $('#cm-save').onclick = saveContractFromModal;
  $('#cm-value-type').onchange = () => $('#cm-term-years-field').classList.toggle('hidden', $('#cm-value-type').value !== 'multi_year');
  $('#cm-owner-search').oninput = (e) => renderOwnerSuggestions(e.target.value);
  $('#cm-owner-search').onblur = () => setTimeout(() => $('#cm-owner-suggestions').classList.add('hidden'), 150);

  $('#csv-file').onchange = handleCSVFileSelected;
  $('#parse-csv-btn').onclick = parseCSVFile;
  $('#confirm-import-btn').onclick = confirmImport;

  $('#access-save-btn').onclick = saveUserRole;
  $('#add-threshold-btn').onclick = addThreshold;
  $('#add-category-btn').onclick = addCategory;
}

init();
