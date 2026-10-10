const $ = id => document.getElementById(id);
let torrents = [];
let filter = 'pending';
let sortKey = 'downloadSpeed';
let sortDirection = 'desc';
const sortLabels = {
  name: 'Titre', state: 'État', category: 'Catégorie', progress: 'Progression', size: 'Taille',
  downloadSpeed: 'Vitesse de téléchargement', uploadSpeed: 'Vitesse d’upload',
  seedsConnected: 'Seeds', peersConnected: 'Peers', ratio: 'Ratio', uploaded: 'Volume envoyé', eta: 'Temps restant',
};
const columnKeys = Object.keys(sortLabels);
const textColumns = new Set(['name', 'state', 'category']);
const defaultDirection = key => textColumns.has(key) || key === 'eta' ? 'asc' : 'desc';
let visibleColumns = new Set(columnKeys);
try {
  const saved = JSON.parse(localStorage.getItem('torrent-watch.columns.v1'));
  if (Array.isArray(saved) && saved.every(key => columnKeys.includes(key))) visibleColumns = new Set(['name', ...saved]);
} catch { /* Storage can be disabled; all columns remain available. */ }
function applyColumns() {
  document.querySelectorAll('[data-column]').forEach(cell => { cell.hidden = !visibleColumns.has(cell.dataset.column); });
  document.querySelectorAll('#sort-field option').forEach(option => { option.hidden = option.disabled = !visibleColumns.has(option.value); });
  document.querySelectorAll('[data-column-toggle]').forEach(input => { input.checked = visibleColumns.has(input.dataset.columnToggle); });
  if (!visibleColumns.has(sortKey)) { sortKey = 'name'; sortDirection = 'asc'; }
  updateSortControls();
}
function setupColumns() {
  for (const key of columnKeys) {
    const heading = element('th'); heading.scope = 'col'; heading.dataset.column = key; heading.setAttribute('aria-sort', 'none');
    if (['downloadSpeed', 'uploadSpeed'].includes(key)) heading.className = 'speed-heading';
    const button = element('button', 'sort-button'); button.type = 'button'; button.dataset.sort = key;
    button.append(element('span', '', sortLabels[key]));
    const arrow = element('span', 'sort-arrow', '↕'); arrow.setAttribute('aria-hidden', 'true'); button.append(arrow);
    if (['seedsConnected', 'peersConnected'].includes(key)) button.title = 'Trier par nombre connecté ; affichage connectés / connus';
    if (key === 'ratio') button.title = 'Ratio de partage calculé par qBittorrent';
    heading.append(button); $('column-headings').append(heading);
    const option = element('option', '', sortLabels[key]); option.value = key; $('sort-field').append(option);
    const label = element('label'); const input = element('input'); input.type = 'checkbox'; input.dataset.columnToggle = key;
    input.checked = visibleColumns.has(key); input.disabled = key === 'name';
    label.append(input, element('span', '', sortLabels[key])); $('column-choices').append(label);
    input.addEventListener('change', () => {
      if (input.checked) visibleColumns.add(key); else visibleColumns.delete(key);
      try { localStorage.setItem('torrent-watch.columns.v1', JSON.stringify([...visibleColumns])); } catch { /* Optional preference. */ }
      applyColumns(); render();
    });
  }
  applyColumns();
}
function sortValue(torrent) {
  if (sortKey === 'state') return states[torrent.state] || 'État inconnu';
  if (sortKey === 'category') return torrent.category || null;
  if (sortKey === 'eta') return torrent.progress >= 1 ? 0 : torrent.eta > 0 ? torrent.eta : null;
  return torrent[sortKey];
}
function compareTorrents(a, b) {
  const left = sortValue(a), right = sortValue(b);
  // Unknown counts and ETAs always stay last, in either direction.
  if (left == null && right != null) return 1;
  if (right == null && left != null) return -1;
  const order = left == null ? 0 : textColumns.has(sortKey)
    ? left.localeCompare(right, 'fr', { numeric: true, sensitivity: 'base' }) : left - right;
  return order * (sortDirection === 'asc' ? 1 : -1) || a.name.localeCompare(b.name, 'fr', { numeric: true });
}
function updateSortControls() {
  document.querySelectorAll('th[aria-sort]').forEach(th => th.setAttribute('aria-sort', 'none'));
  document.querySelectorAll('[data-sort]').forEach(button => {
    const active = button.dataset.sort === sortKey;
    button.classList.toggle('sort-active', active);
    button.querySelector('.sort-arrow').textContent = active ? (sortDirection === 'asc' ? '↑' : '↓') : '↕';
    const next = active ? (sortDirection === 'asc' ? 'desc' : 'asc') : defaultDirection(button.dataset.sort);
    button.setAttribute('aria-label', `Trier par ${sortLabels[button.dataset.sort].toLocaleLowerCase('fr')}, ordre ${next === 'asc' ? 'croissant' : 'décroissant'}`);
    if (active) button.closest('th').setAttribute('aria-sort', sortDirection === 'asc' ? 'ascending' : 'descending');
  });
  $('sort-field').value = sortKey;
  $('sort-direction').textContent = sortDirection === 'asc' ? '↑ Croissant' : '↓ Décroissant';
  $('sort-direction').setAttribute('aria-label', `Passer au tri ${sortDirection === 'asc' ? 'décroissant' : 'croissant'}`);
}
function selectSort(key) {
  if (key === sortKey) sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
  else { sortKey = key; sortDirection = defaultDirection(key); }
  updateSortControls();
  render();
}
let authenticated = false;
let updating = false;
let generation = 0;
let lastUpdate = null;
const states = {
  downloading: 'Téléchargement', forcedDL: 'Téléchargement', metaDL: 'Métadonnées', forcedMetaDL: 'Métadonnées',
  stalledDL: 'En attente de sources', queuedDL: 'En file d’attente', pausedDL: 'En pause', stoppedDL: 'Arrêté',
  uploading: 'En partage', forcedUP: 'En partage', stalledUP: 'Terminé', pausedUP: 'En pause', stoppedUP: 'Arrêté', queuedUP: 'Partage en attente',
  checkingDL: 'Vérification', checkingUP: 'Vérification', checkingResumeData: 'Vérification', moving: 'Déplacement', allocating: 'Préparation',
  error: 'Erreur', missingFiles: 'Fichiers manquants', unknown: 'État inconnu',
};
const fmt = (n, digits = 1) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: digits }).format(n);
function bytes(n) {
  const units = ['o', 'Kio', 'Mio', 'Gio', 'Tio'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${fmt(n)} ${units[i]}`;
}
function eta(n) {
  if (n === null || n <= 0) return '—';
  if (n < 60) return '< 1 min';
  if (n < 3600) return `${Math.ceil(n / 60)} min`;
  if (n < 86400) return `${Math.floor(n / 3600)} h ${Math.floor(n % 3600 / 60)} min`;
  return `${Math.floor(n / 86400)} j ${Math.floor(n % 86400 / 3600)} h`;
}
function element(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}
async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(35000),
  });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || 'Erreur de connexion.'), { status: response.status });
  return data;
}
function showLogin() {
  authenticated = false;
  generation++;
  torrents = [];
  lastUpdate = null;
  $('torrent-list').replaceChildren();
  $('dashboard').hidden = true;
  $('loading').hidden = true;
  $('login-panel').hidden = false;
}
function showDashboard() {
  authenticated = true;
  generation++;
  $('login-panel').hidden = true;
  $('loading').hidden = true;
  $('dashboard').hidden = false;
  refresh();
}
function render() {
  const pending = torrents.filter(t => t.progress < 1);
  $('metric-active').textContent = torrents.filter(t => t.downloadSpeed > 0 && t.progress < 1).length;
  $('metric-down').textContent = `${bytes(torrents.reduce((s, t) => s + t.downloadSpeed, 0))}/s`;
  $('metric-up').textContent = `${bytes(torrents.reduce((s, t) => s + t.uploadSpeed, 0))}/s`;
  $('metric-done').textContent = torrents.length - pending.length;
  $('pending-count').textContent = pending.length;
  const search = $('search').value.toLocaleLowerCase('fr');
  const visible = torrents.filter(t => (filter === 'all' || (filter === 'pending' ? t.progress < 1 : t.progress >= 1)) && t.name.toLocaleLowerCase('fr').includes(search))
    .sort(compareTorrents);
  const rows = document.createDocumentFragment();
  for (const t of visible) {
    const row = element('tr');
    for (const key of columnKeys) {
      const cell = element('td'); cell.dataset.column = key; cell.dataset.label = sortLabels[key]; cell.hidden = !visibleColumns.has(key);
      switch (key) {
        case 'name': {
          cell.className = 'title-cell';
          const name = element('strong', 'torrent-name', t.name); name.title = t.name; cell.append(name); break;
        }
        case 'state': {
          const active = t.downloadSpeed > 0 || t.uploadSpeed > 0 ? 'active' : '';
          const danger = ['error', 'missingFiles'].includes(t.state) ? 'danger' : '';
          cell.append(element('span', `state ${active} ${danger}`, states[t.state] || 'État inconnu')); break;
        }
        case 'category': cell.append(element('span', 'category', t.category || '—')); break;
        case 'progress': {
          const progress = element('progress'); progress.max = 1; progress.value = t.progress;
          progress.setAttribute('aria-label', `Progression de ${t.name}`);
          cell.append(element('span', 'percent', `${fmt(t.progress * 100)} %`), progress,
            element('small', 'downloaded-size', `${bytes(t.downloaded)} téléchargés`)); break;
        }
        case 'size': case 'uploaded': cell.textContent = bytes(t[key]); break;
        case 'ratio': cell.textContent = fmt(t.ratio, 2); break;
        case 'downloadSpeed': case 'uploadSpeed': {
          cell.className = `speed-cell ${key === 'downloadSpeed' ? 'download-speed-cell' : 'upload-speed-cell'}`;
          cell.append(element('strong', t[key] > 0 ? 'mint' : '', `${bytes(t[key])}/s`)); break;
        }
        case 'seedsConnected': case 'peersConnected': {
          cell.className = 'count-cell';
          const total = key === 'seedsConnected' ? t.seedsTotal : t.peersTotal;
          cell.append(element('strong', '', t[key] === null ? '—' : fmt(t[key], 0)),
            element('span', '', ` / ${total === null ? '—' : fmt(total, 0)}`)); break;
        }
        case 'eta': cell.className = 'eta-cell'; cell.textContent = t.progress >= 1 ? 'Terminé' : eta(t.eta); break;
      }
      row.append(cell);
    }
    rows.append(row);
  }
  $('torrent-list').replaceChildren(rows);
  $('empty').hidden = visible.length > 0;
  $('empty').querySelector('h2').textContent = search ? 'Aucun résultat.' : filter === 'pending' ? 'Rien en attente.' : 'Aucun téléchargement ici.';
  $('empty').querySelector('p').textContent = search ? 'Essaie avec un autre titre.' : 'Les nouveaux téléchargements apparaîtront ici.';
}
async function refresh() {
  if (!authenticated || updating || document.hidden) return;
  updating = true;
  const current = generation;
  $('refresh').disabled = true;
  try {
    const data = await api('/api/torrents');
    if (!authenticated || generation !== current) return;
    torrents = data.torrents;
    lastUpdate = new Date(data.updatedAt);
    $('connection').textContent = `● À jour à ${lastUpdate.toLocaleTimeString('fr-FR')}`;
    $('connection').className = 'connected';
    $('error-banner').hidden = true;
    render();
  } catch (error) {
    if (generation !== current) return;
    if ([401, 403, 503].includes(error.status)) { showLogin(); $('login-error').textContent = error.message; return; }
    $('connection').textContent = lastUpdate ? `● Hors ligne · dernières données à ${lastUpdate.toLocaleTimeString('fr-FR')}` : '● Connexion indisponible';
    $('connection').className = 'offline';
    $('error-banner').textContent = error.status === 502 ? error.message : 'Le suivi est inaccessible. Nouvel essai automatique dans quelques secondes.';
    $('error-banner').hidden = false;
  } finally { updating = false; $('refresh').disabled = false; }
}
$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('login-button').disabled = true;
  $('login-error').textContent = '';
  try {
    const data = await api('/api/auth/plex/start', {});
    window.location.assign(data.authUrl);
  } catch (error) { $('login-error').textContent = error.status ? error.message : 'Impossible de joindre le serveur.'; }
  finally { $('login-button').disabled = false; }
});
$('logout').addEventListener('click', async () => {
  try { await api('/api/logout', {}); showLogin(); }
  catch (error) { if (error.status === 401) showLogin(); else { $('error-banner').textContent = 'Déconnexion impossible. Réessaie.'; $('error-banner').hidden = false; } }
});
document.querySelectorAll('[data-filter]').forEach(button => button.addEventListener('click', () => {
  filter = button.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(b => { b.classList.toggle('selected', b === button); b.setAttribute('aria-pressed', String(b === button)); });
  render();
}));
setupColumns();
document.querySelectorAll('[data-sort]').forEach(button => button.addEventListener('click', () => selectSort(button.dataset.sort)));
$('sort-field').addEventListener('change', event => selectSort(event.target.value));
$('sort-direction').addEventListener('click', () => selectSort(sortKey));
updateSortControls();
$('search').addEventListener('input', render);
$('refresh').addEventListener('click', refresh);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
setInterval(refresh, 5000);
async function bootstrap() {
  const returning = new URLSearchParams(location.search).get('plex') === 'return';
  if (returning) history.replaceState(null, '', '/');
  try { await api('/api/session'); showDashboard(); return; }
  catch (error) {
    if (!returning) { showLogin(); if (error.status !== 401) $('login-error').textContent = error.message; return; }
  }
  showLogin();
  $('login-button').disabled = true;
  try {
    for (let i = 0; i < 15; i++) {
      $('login-error').textContent = 'Vérification de ton accès Plex…';
      const result = await api('/api/auth/plex/status', {});
      if (result.authenticated) { $('login-error').textContent = ''; showDashboard(); return; }
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    $('login-error').textContent = 'Connexion non terminée. Réessaie avec Plex.';
  } catch (error) { $('login-error').textContent = error.status ? error.message : 'Impossible de joindre le serveur.'; }
  finally { $('login-button').disabled = false; }
}
bootstrap();
