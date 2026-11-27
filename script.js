(() => {
  'use strict';

  /* ===== Настройки ===== */
  const MAP_KEY = '714882ec-8dbf-4ff8-ac05-92e6b93317aa';
  const CENTER = [92.8672, 56.0184]; // Красноярск: [долгота, широта]
  const START_ZOOM = 11;
  const CITY_NAME = 'Красноярск';
  const MAX_FILES = 5;
  const MAX_IMAGE_MB = 10;
  const MAX_VIDEO_MB = 50;
  const BUCKET = 'problem-media';
  // Только нужные поля ленты: меньше трафика при каждом обновлении.
  const FEED_COLS = 'id,category_id,category_name,lat,lng,address,district,comment,media,created_at,voting_ends_at,voting_open,yes_votes,no_votes,status';

  const DISTRICTS = [
    'Ленинский район', 'Кировский район', 'Советский район', 'Железнодорожный район',
    'Центральный район', 'Октябрьский район', 'Свердловский район'
  ];
  const STATUS = {
    unsolved:    { label: 'Не решена', color: '#e8553b' },
    in_progress: { label: 'Решается',  color: '#f5b82e' },
    solved:      { label: 'Решена',    color: '#2fb464' }
  };
  const PERIODS = [
    { id: 'hour', label: 'За последний час',    ms: 3600e3 },
    { id: 'day',  label: 'За последний день',   ms: 86400e3 },
    { id: 'week', label: 'За последнюю неделю', ms: 7 * 86400e3 },
    { id: 'all',  label: 'За всё время',        ms: Infinity }
  ];

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (iso) => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  const sb = window.citySupabase;

  /* ===== Состояние ===== */
  let map = null;
  let user = null;
  let categories = [];
  let problems = [];
  let filtered = [];
  const myVotes = new Map();           // problem_id -> true | false
  const markers = new Map();           // problem_id -> { marker, status }
  let draft = null;                    // { lat, lng, marker, geo, files }
  let openPanelName = null;
  let openDetailId = null;
  let lastMarkerClick = 0;
  let meMarker = null;
  let feedDirty = true;                // ленту перерисовываем только когда она открыта
  let streetNames = [];                // улицы, на которых уже есть метки
  let districtKey = '';                // чтобы не перерисовывать фильтр без причины
  let lastLoad = 0;
  const state = { q: '', cats: new Set(), districts: new Set(), status: new Set(), period: 'all' };

  /* ===== Уведомления ===== */
  let toastTimer = 0;
  function toast(text, opts = {}) {
    const el = $('#toast');
    el.className = 'toast' + (opts.error ? ' toast--error' : '');
    el.innerHTML = esc(text) + (opts.href ? ' <a href="' + esc(opts.href) + '">' + esc(opts.linkText || 'Открыть') + '</a>' : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, opts.ms || 5000);
  }
  const toastLogin = () => toast('Войдите, чтобы отмечать проблемы и голосовать.', { href: 'login.html', linkText: 'Войти' });

  /* ===== Иконки меток ===== */
  function pinIcon(color) {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="34" height="44" viewBox="0 0 34 44">' +
      '<path d="M17 42S3 27 3 16.5a14 14 0 0 1 28 0C31 27 17 42 17 42z" fill="' + color + '" stroke="#fff" stroke-width="2.5"/>' +
      '<circle cx="17" cy="16.5" r="5.5" fill="#fff"/></svg>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }
  const ME_ICON = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26"><circle cx="13" cy="13" r="12" fill="#1e88ff" fill-opacity=".25"/><circle cx="13" cy="13" r="7" fill="#1e88ff" stroke="#fff" stroke-width="3"/></svg>');
  const DRAFT_COLOR = '#1e88ff';

  /* ===== Картинки меток по категориям =====
     Положите файл img/markers/<id категории>.png (или .svg / .webp).
     id категорий смотрите в таблице categories в Supabase.
     Если для категории файла нет, будет обычная цветная метка.
     Если хотите называть файлы по-своему, впишите сюда:
       { 'Название категории': 'img/markers/water.png' } */
  const MARKER_FILES = {};
  const MARKER_EXTS = ['png', 'svg', 'webp'];
  const MARKER_W = 44, MARKER_H = 52;
  const catImages = new Map();   // String(id категории) -> картинка или null
  const iconCache = new Map();

  function loadFirstImage(srcs) {
    return new Promise((resolve) => {
      const next = (i) => {
        if (i >= srcs.length) { resolve(null); return; }
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => next(i + 1);
        img.src = srcs[i];
      };
      next(0);
    });
  }

  async function preloadMarkerImages() {
    iconCache.clear();
    await Promise.all(categories.map(async (c) => {
      const srcs = MARKER_FILES[c.name]
        ? [MARKER_FILES[c.name]]
        : MARKER_EXTS.map((ext) => 'img/markers/' + c.id + '.' + ext);
      catImages.set(String(c.id), await loadFirstImage(srcs));
    }));
  }

  // Картинка категории + кружок статуса в углу. Без картинки — цветная капля.
  function markerIconFor(p) {
    const key = p.category_id + '|' + p.status;
    if (iconCache.has(key)) return iconCache.get(key);
    const color = STATUS[p.status].color;
    let res = { icon: pinIcon(color), size: [34, 44], anchor: [17, 44] };
    const img = catImages.get(String(p.category_id));
    if (img) {
      try {
        const k = 2;
        const cv = document.createElement('canvas');
        cv.width = MARKER_W * k; cv.height = MARKER_H * k;
        const g = cv.getContext('2d');
        g.scale(k, k);
        const iw = img.naturalWidth || 64, ih = img.naturalHeight || 64;
        const r = Math.min((MARKER_W - 4) / iw, (MARKER_H - 6) / ih);
        const w = iw * r, h = ih * r;
        g.drawImage(img, (MARKER_W - w) / 2, MARKER_H - h, w, h);
        g.beginPath();
        g.arc(MARKER_W - 8, 9, 7, 0, Math.PI * 2);
        g.fillStyle = color; g.fill();
        g.lineWidth = 2.5; g.strokeStyle = '#fff'; g.stroke();
        res = { icon: cv.toDataURL('image/png'), size: [MARKER_W, MARKER_H], anchor: [MARKER_W / 2, MARKER_H] };
      } catch (err) {
        console.warn('Не удалось собрать иконку метки:', err);
      }
    }
    iconCache.set(key, res);
    return res;
  }

  /* ===== Карта ===== */
  function initMap() {
    if (!window.mapgl) {
      $('#map').innerHTML = '<p style="padding:140px 24px;font:18px Roboto,Arial,sans-serif">Не загрузилась карта 2GIS. Проверьте интернет и ключ карты.</p>';
      return;
    }
    map = new mapgl.Map('map', {
      key: MAP_KEY,
      center: CENTER,
      zoom: START_ZOOM,
      zoomControl: false
    });
    map.on('click', (e) => {
      // Клик по метке тоже может дойти до карты — даём метке отметиться первой.
      const lngLat = e.lngLat;
      const point = e.point;
      setTimeout(() => {
        if (Date.now() - lastMarkerClick < 400) return;
        onMapClick(lngLat[1], lngLat[0], point);
      }, 30);
    });
    const syncZoom = () => { $('#zoom-range').value = map.getZoom(); };
    map.on('zoom', syncZoom);
    map.on('zoomend', syncZoom);

    $('#zoom-in').addEventListener('click', () => map.setZoom(map.getZoom() + 1));
    $('#zoom-out').addEventListener('click', () => map.setZoom(map.getZoom() - 1));
    $('#zoom-range').addEventListener('input', (e) => map.setZoom(parseFloat(e.target.value)));
  }

  function flyTo(lat, lng, zoom) {
    if (!map) return;
    map.setCenter([lng, lat]);
    map.setZoom(Math.max(map.getZoom(), zoom || 15));
  }

  function fitToFiltered() {
    if (!map || !filtered.length) return;
    if (filtered.length === 1) { flyTo(filtered[0].lat, filtered[0].lng, 15); return; }
    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    filtered.forEach((p) => {
      minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
      minLng = Math.min(minLng, p.lng); maxLng = Math.max(maxLng, p.lng);
    });
    map.fitBounds(
      { northEast: [maxLng, maxLat], southWest: [minLng, minLat] },
      { padding: { top: 140, bottom: 80, left: 80, right: 100 } }
    );
  }

  /* ===== Данные ===== */
  async function loadCategories() {
    const { data, error } = await sb.from('categories').select('id, name').order('name');
    if (error) { toast(window.ruError(error, 'Не удалось загрузить категории.'), { error: true, ms: 9000 }); return; }
    categories = data || [];
    await preloadMarkerImages();
    renderFilter();
    renderMakeCats();
  }

  // Готовим поля для быстрого поиска, чтобы не собирать строки на каждую букву.
  function prepare(p) {
    p._hay = [p.category_name, p.district, p.address].join(' ').toLowerCase();
    p._time = new Date(p.created_at).getTime();
    return p;
  }

  async function loadProblems() {
    const { data, error } = await sb.from('problems_feed').select(FEED_COLS).order('created_at', { ascending: false }).limit(1000);
    if (error) {
      console.error(error);
      toast(window.ruError(error, 'Не удалось загрузить метки.'), { error: true, ms: 9000 });
      return;
    }
    lastLoad = Date.now();
    problems = (data || []).map(prepare);
    streetNames = [...new Set(problems.map((p) => streetOf(p.address)).filter(Boolean))];
    // Фильтр перерисовываем, только если появились новые районы: иначе он «прыгает» при обновлении.
    const key = problems.map((p) => p.district).filter(Boolean).sort().join('|');
    if (key !== districtKey) { districtKey = key; renderFilter(); }
    applyFilters();
    if (openDetailId) renderDetail();
  }

  async function loadMyVotes() {
    myVotes.clear();
    if (!user) return;
    const { data } = await sb.from('problem_votes').select('problem_id, solved');
    (data || []).forEach((v) => myVotes.set(v.problem_id, v.solved));
  }

  /* ===== Фильтрация ===== */
  function matches(p, periodMs, now) {
    if (state.cats.size && !state.cats.has(String(p.category_id))) return false;
    if (state.districts.size && !state.districts.has(p.district)) return false;
    if (state.status.size && !state.status.has(p.status)) return false;
    if (periodMs !== Infinity && now - p._time > periodMs) return false;
    if (state.q && !p._hay.includes(state.q)) return false;
    return true;
  }

  function filtersActive() {
    return state.cats.size + state.districts.size + state.status.size > 0 || state.period !== 'all';
  }

  function applyFilters() {
    const periodMs = PERIODS.find((x) => x.id === state.period).ms;
    const now = Date.now();
    filtered = problems.filter((p) => matches(p, periodMs, now));
    renderMarkers();
    renderFeed();
    $('#nav-filter').classList.toggle('has-filter', filtersActive());
    $('#filter-count').textContent = 'Найдено событий: ' + filtered.length;
  }

  function renderMarkers() {
    if (!map) return;
    const want = new Map(filtered.map((p) => [p.id, p]));
    for (const [id, m] of markers) {
      const p = want.get(id);
      if (!p || m.status !== p.status) { m.marker.destroy(); markers.delete(id); }
    }
    filtered.forEach((p) => {
      if (markers.has(p.id)) return;
      const mi = markerIconFor(p);
      const marker = new mapgl.Marker(map, {
        coordinates: [p.lng, p.lat],
        icon: mi.icon,
        size: mi.size,
        anchor: mi.anchor
      });
      marker.on('click', () => { lastMarkerClick = Date.now(); openDetail(p.id); });
      markers.set(p.id, { marker, status: p.status });
    });
  }

  /* ===== Панель фильтра ===== */
  function checkHTML(type, name, value, label, checked, extra) {
    return '<label class="check"><input type="' + type + '" name="' + name + '" value="' + esc(value) + '"' + (checked ? ' checked' : '') + '>' +
      '<span class="box' + (type === 'radio' ? ' box--round' : '') + '"></span><span>' + esc(label) + '</span>' + (extra || '') + '</label>';
  }

  function renderFilter() {
    $('#f-cats').innerHTML = categories.length
      ? categories.map((c) => checkHTML('checkbox', 'fcat', c.id, c.name, state.cats.has(String(c.id)))).join('')
      : '<p class="flist__empty">Категорий пока нет</p>';

    $('#f-period').innerHTML = PERIODS.map((p) => checkHTML('radio', 'fperiod', p.id, p.label, state.period === p.id)).join('');

    const found = problems.map((p) => p.district).filter(Boolean);
    const dists = [...new Set([...DISTRICTS, ...found])];
    $('#f-districts').innerHTML = dists.map((d) => checkHTML('checkbox', 'fdist', d, d, state.districts.has(d))).join('');

    $('#f-status').innerHTML = Object.entries(STATUS).map(([k, s]) =>
      checkHTML('checkbox', 'fstatus', k, s.label, state.status.has(k), '<span class="dot dot--' + k + '"></span>')).join('');
  }

  function initFilterEvents() {
    $('#panel-filter').addEventListener('change', (e) => {
      const t = e.target;
      const toggle = (set, val) => { t.checked ? set.add(val) : set.delete(val); };
      if (t.name === 'fcat') toggle(state.cats, t.value);
      else if (t.name === 'fdist') toggle(state.districts, t.value);
      else if (t.name === 'fstatus') toggle(state.status, t.value);
      else if (t.name === 'fperiod') state.period = t.value;
      else return;
      applyFilters();
    });
    $('#filter-reset').addEventListener('click', () => {
      state.cats.clear(); state.districts.clear(); state.status.clear(); state.period = 'all';
      renderFilter();
      applyFilters();
    });
  }

  /* ===== Поиск ===== */
  const searchBox = $('#search');
  const searchInput = $('#search-input');
  const suggestEl = $('#suggest');
  const streetCache = new Map();       // запрос -> улицы из геокодера 2GIS
  let searchTimer = 0;
  let streetTimer = 0;
  let streetAbort = null;
  let suggestItems = [];
  let remote = { q: '', items: [], loading: false };   // улицы, найденные через 2GIS

  const streetOf = (a) => (a ? a.split(',')[0].trim() : '');

  // Улицы ищем через геокодер 2GIS, поэтому находится и та улица, где меток ещё нет.
  async function lookupStreets(q) {
    const key = q.toLowerCase();
    if (streetCache.has(key)) return streetCache.get(key);
    if (streetAbort) streetAbort.abort();
    streetAbort = new AbortController();
    const base = 'https://catalog.api.2gis.com/3.0/items/geocode?q=' + encodeURIComponent(CITY_NAME + ', ' + q) +
      '&page_size=10&key=' + MAP_KEY;
    const attempts = [
      base + '&type=street&fields=items.full_name,items.point,items.geometry.centroid',
      base + '&fields=items.full_name,items.point'
    ];
    try {
      let json = null;
      for (const url of attempts) {
        const res = await fetch(url, { signal: streetAbort.signal });
        if (res.ok) { json = await res.json(); break; }
      }
      const raw = (json && json.result && json.result.items) || [];
      const seen = new Set();
      const out = [];
      raw.forEach((it) => {
        if (it.type && it.type !== 'street') return;
        if (it.full_name && !/красноярск/i.test(it.full_name)) return;
        const name = (it.name || '').trim();
        if (!name || seen.has(name.toLowerCase())) return;
        seen.add(name.toLowerCase());
        let lat = it.point ? it.point.lat : null;
        let lng = it.point ? it.point.lon : null;
        const wkt = it.geometry && it.geometry.centroid && /POINT\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/i.exec(it.geometry.centroid);
        if (lat == null && wkt) { lng = parseFloat(wkt[1]); lat = parseFloat(wkt[2]); }
        out.push({ text: name, kind: 'улица', lat, lng });
      });
      streetCache.set(key, out);
      return out;
    } catch (err) {
      if (err.name !== 'AbortError') console.warn('Поиск улиц недоступен:', err);
      return [];
    }
  }

  function buildSuggestions(q) {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    const has = (t) => t.toLowerCase().includes(s);
    const dists = [...new Set([...DISTRICTS, ...problems.map((p) => p.district).filter(Boolean)])].filter(has).slice(0, 3)
      .map((t) => ({ text: t, kind: 'район' }));

    // Улицы: сначала те, где уже есть метки, затем найденные через 2GIS (без дублей).
    const streets = new Map();
    streetNames.filter(has).forEach((t) => streets.set(t.toLowerCase(), { text: t, kind: 'улица' }));
    const exact = remote.q.toLowerCase() === s;           // ответ геокодера пришёл на этот же запрос
    remote.items.filter((it) => exact || has(it.text)).forEach((it) => {
      const k = it.text.toLowerCase();
      if (streets.has(k)) Object.assign(streets.get(k), { lat: it.lat, lng: it.lng });
      else streets.set(k, it);
    });

    const cats = categories.map((c) => c.name).filter(has).slice(0, 3)
      .map((t) => ({ text: t, kind: 'категория' }));
    return [...dists, ...[...streets.values()].slice(0, 5), ...cats];
  }

  function renderSuggest() {
    const q = searchInput.value;
    if (!q.trim()) { closeSuggest(); return; }
    suggestItems = buildSuggestions(q);
    suggestEl.innerHTML = suggestItems.length
      ? suggestItems.map((it, i) => '<li><button type="button" data-i="' + i + '">' + esc(it.text) + '<small>' + it.kind + '</small></button></li>').join('')
      : '<li class="suggest__empty">' + (remote.loading ? 'Ищем…' : 'Ничего не найдено') + '</li>';
    suggestEl.hidden = false;
    searchBox.classList.add('is-open');
  }
  function closeSuggest() { suggestEl.hidden = true; searchBox.classList.remove('is-open'); }

  function scheduleStreetLookup() {
    clearTimeout(streetTimer);
    const q = searchInput.value.trim();
    if (q.length < 2) { remote = { q: '', items: [], loading: false }; return; }
    remote.loading = true;
    streetTimer = setTimeout(async () => {
      const items = await lookupStreets(q);
      if (searchInput.value.trim() !== q) return;          // пользователь уже печатает дальше
      remote = { q, items, loading: false };
      if (document.activeElement === searchInput) renderSuggest();
    }, 300);
  }

  function runSearch() {
    state.q = searchInput.value.trim().toLowerCase();
    applyFilters();
  }

  // Показать результат поиска на карте: метки, а если меток нет — саму улицу.
  function showSearchResult(place) {
    if (!state.q) return;
    if (filtered.length) { fitToFiltered(); return; }
    if (place && place.lat != null && place.lng != null) {
      flyTo(place.lat, place.lng, 15);
      toast('На улице «' + place.text + '» пока нет отметок.');
    } else {
      toast('По запросу «' + searchInput.value.trim() + '» ничего не найдено.');
    }
  }

  async function submitSearch() {
    closeSuggest();
    searchInput.blur();
    runSearch();
    if (!state.q) return;
    if (filtered.length) { fitToFiltered(); return; }
    const q = searchInput.value.trim();
    const streets = await lookupStreets(q);
    if (searchInput.value.trim() === q) showSearchResult(streets.find((x) => x.lat != null));
  }

  function initSearch() {
    searchInput.addEventListener('input', () => {
      renderSuggest();
      scheduleStreetLookup();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(runSearch, 250);
    });
    searchInput.addEventListener('focus', renderSuggest);
    searchBox.addEventListener('submit', (e) => { e.preventDefault(); submitSearch(); });
    suggestEl.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-i]'); if (!b) return;
      const it = suggestItems[+b.dataset.i];
      searchInput.value = it.text;
      closeSuggest();
      runSearch();
      showSearchResult(it);
    });
    $('#search-clear').addEventListener('click', () => {
      searchInput.value = '';
      remote = { q: '', items: [], loading: false };
      closeSuggest();
      runSearch();
      searchInput.focus();
    });
    document.addEventListener('click', (e) => { if (!searchBox.contains(e.target)) closeSuggest(); });
  }

  /* ===== Карточки событий ===== */
  const ICON_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
  const ICON_NO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>';

  function daysLeft(p) {
    return Math.max(0, Math.ceil((new Date(p.voting_ends_at).getTime() - Date.now()) / 86400e3));
  }

  function voteHTML(p) {
    if (p.status === 'solved') {
      return '<div class="esolved"><span class="esolved__ic">' + ICON_OK + '</span><span>Решено</span></div>';
    }
    if (!p.voting_open) {
      return '<div class="eclosed"><div class="eclosed__t">Не решена</div><div class="eclosed__n">Голосование закончено: да — ' +
        p.yes_votes + ', нет — ' + p.no_votes + '</div></div>';
    }
    const mine = myVotes.get(p.id);
    const note = user ? (mine === undefined ? 'Ваш голос можно изменить' : 'Ваш голос учтён, его можно изменить') : 'Войдите, чтобы голосовать';
    const d = daysLeft(p);
    return '<div class="evote"><div class="evote__q">Решена ли проблема?</div>' +
      '<div class="evote__btns">' +
        '<button class="vbtn vbtn--yes" type="button" data-vote="yes" data-id="' + p.id + '" aria-pressed="' + (mine === true) + '" aria-label="Решена — ' + p.yes_votes + ' голосов">' +
          '<span class="vbtn__ic">' + ICON_OK + '</span><span class="vbtn__n">' + p.yes_votes + '</span></button>' +
        '<button class="vbtn vbtn--no" type="button" data-vote="no" data-id="' + p.id + '" aria-pressed="' + (mine === false) + '" aria-label="Не решена — ' + p.no_votes + ' голосов">' +
          '<span class="vbtn__ic">' + ICON_NO + '</span><span class="vbtn__n">' + p.no_votes + '</span></button>' +
      '</div>' +
      '<div class="evote__note">' + note + '. До итога: ' + d + ' дн.</div></div>';
  }

  function photoHTML(p) {
    const media = Array.isArray(p.media) ? p.media : [];
    if (!media.length) return '<span class="ephoto" aria-hidden="true">Нет фото</span>';
    const first = media.find((m) => m.type === 'image');
    const inner = first
      ? '<img src="' + esc(first.url) + '" alt="" loading="lazy">'
      : '<video src="' + esc(media[0].url) + '#t=0.1" preload="metadata" muted></video>';
    const more = media.length > 1 ? '<span class="ephoto__more">+' + (media.length - 1) + '</span>' : '';
    return '<button class="ephoto" type="button" data-media="' + p.id + '" aria-label="Открыть медиаматериалы">' + inner + more + '</button>';
  }

  function cardHTML(p) {
    const st = STATUS[p.status];
    const meta = '[' + fmtDate(p.created_at) + (p.district ? ', ' + p.district : '') + ']';
    const desc = p.comment
      ? '<p class="edesc">' + esc(p.comment).replace(/\n/g, '<br>') + (p.address ? '<small>' + esc(p.address) + '</small>' : '') + '</p>'
      : '<p class="edesc edesc--empty">Без комментария' + (p.address ? '<small>' + esc(p.address) + '</small>' : '') + '</p>';
    return '<article class="ecard" id="problem-' + p.id + '">' +
      '<div class="ecard__head">' +
        '<button class="ecard__title" type="button" data-focus="' + p.id + '" title="Показать на карте">' +
          '<span class="dot dot--' + p.status + '" title="' + esc(st.label) + '"></span>' + esc(p.category_name) + '</button>' +
        '<span class="ecard__meta">' + esc(meta) + '</span>' +
      '</div>' +
      '<div class="ecard__body">' + photoHTML(p) + desc + voteHTML(p) + '</div>' +
    '</article>';
  }

  function renderFeed(force) {
    if (!force && openPanelName !== 'events') { feedDirty = true; return; }
    feedDirty = false;
    const el = $('#events-list');
    if (!filtered.length) {
      el.innerHTML = '<p class="events__empty">' +
        (problems.length ? 'По выбранным условиям событий нет.' : 'Событий пока нет. Нажмите на карту, чтобы отметить первую проблему.') + '</p>';
      return;
    }
    el.innerHTML = filtered.map(cardHTML).join('');
  }

  /* ===== Карточка метки на карте ===== */
  function openDetail(id) {
    const p = problems.find((x) => x.id === id);
    if (!p) return;
    if (draft) cancelDraft();
    openDetailId = id;
    closePanels();
    renderDetail();
    $('#detail').hidden = false;
  }
  function renderDetail() {
    const p = problems.find((x) => x.id === openDetailId);
    if (!p) { closeDetail(); return; }
    $('#detail-body').innerHTML = cardHTML(p);
  }
  function closeDetail() { openDetailId = null; $('#detail').hidden = true; }

  function focusProblem(id) {
    const p = problems.find((x) => x.id === id);
    if (!p) return;
    flyTo(p.lat, p.lng, 16);
    openDetail(id);
  }

  /* ===== Голосование ===== */
  const voting = new Set();
  async function vote(id, solved) {
    if (!user) { toastLogin(); return; }
    if (voting.has(id) || myVotes.get(id) === solved) return;
    const p = problems.find((x) => x.id === id);
    if (!p || !p.voting_open) return;
    voting.add(id);
    const { error } = await sb.from('problem_votes').upsert(
      { problem_id: id, user_id: user.id, solved },
      { onConflict: 'problem_id,user_id' }
    );
    if (error) {
      voting.delete(id);
      toast(window.ruError(error, 'Не удалось отправить голос.'), { error: true });
      return;
    }
    myVotes.set(id, solved);
    const { data } = await sb.from('problems_feed').select(FEED_COLS).eq('id', id).maybeSingle();
    voting.delete(id);
    if (data) problems = problems.map((x) => (x.id === id ? prepare(data) : x));
    applyFilters();
    if (openDetailId) renderDetail();
  }

  /* ===== Медиа ===== */
  function openMedia(id) {
    const p = problems.find((x) => x.id === id);
    if (!p) return;
    $('#media-title').textContent = p.category_name;
    $('#media-grid').innerHTML = (p.media || []).map((m) => m.type === 'video'
      ? '<video src="' + esc(m.url) + '" controls preload="metadata"></video>'
      : '<img src="' + esc(m.url) + '" alt="Фото к событию" loading="lazy">').join('');
    $('#media').showModal();
  }

  /* ===== Новая метка ===== */
  function onMapClick(lat, lng, point) {
    if (!user) { toastLogin(); return; }
    startDraft(lat, lng, point);
  }

  async function reverseGeocode(lat, lng) {
    try {
      const url = 'https://catalog.api.2gis.com/3.0/items/geocode?lat=' + lat + '&lon=' + lng +
        '&fields=items.adm_div,items.address_name,items.full_name&key=' + MAP_KEY;
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      const item = json && json.result && json.result.items && json.result.items[0];
      if (!item) return { address: null, district: null };
      const div = (item.adm_div || []).find((d) => /район/i.test(d.name || '') && !/округ/i.test(d.name || ''));
      return { address: item.address_name || item.full_name || null, district: div ? div.name : null };
    } catch (err) {
      console.warn('Геокодер недоступен:', err);
      return { address: null, district: null };
    }
  }

  function startDraft(lat, lng, point) {
    closePanels();
    closeDetail();
    if (draft) {
      draft.marker.setCoordinates([lng, lat]);
    } else {
      const marker = new mapgl.Marker(map, { coordinates: [lng, lat], icon: pinIcon(DRAFT_COLOR), size: [34, 44], anchor: [17, 44], zIndex: 100 });
      draft = { marker, files: [] };
      resetMakeForm();
    }
    draft.lat = lat;
    draft.lng = lng;
    draft.click = point && isFinite(point[0]) ? { x: point[0], y: point[1] } : null;
    draft.panUntil = 0;
    draft.autoPanUntil = performance.now() + 1200;   // автосдвиг карты — только сразу после постановки метки
    $('#make-addr').textContent = 'Определяем адрес…';
    $('#make-district-wrap').hidden = true;
    const mine = draft;
    draft.geo = reverseGeocode(lat, lng).then((geo) => {
      if (draft !== mine || mine.lat !== lat || mine.lng !== lng) return geo;
      mine.resolved = geo;
      $('#make-addr').textContent = geo.address || ('Точка на карте: ' + lat.toFixed(5) + ', ' + lng.toFixed(5));
      $('#make-district-wrap').hidden = !!geo.district;
      return geo;
    });
    syncLayers();
  }

  function cancelDraft() {
    if (!draft) return;
    draft.marker.destroy();
    draft = null;
    resetMakeForm();
    syncLayers();
  }

  function syncLayers() {
    const show = !!(draft && !openPanelName);
    makeEl.hidden = !show;
    if (show) { makeDirty = true; startTracking(); }
  }

  /* ===== Окно формы рядом с меткой =====
     ПК: окно стоит справа или слева от метки и едет за ней при движении карты.
     Телефон: нижняя панель; если она закрывает метку, карта сдвигается. */
  const makeEl = $('#make');
  const mqMobile = window.matchMedia('(max-width: 900px)');
  const PIN_H = 44, PIN_HALF = 17, GAP = 14;
  let trackRaf = 0;
  let makeDirty = true;
  let lastPos = { x: NaN, y: NaN };

  // Где метка на экране сейчас. Если карта не умеет считать, берём точку клика.
  function markerScreen() {
    if (!draft) return null;
    try {
      if (map && typeof map.project === 'function') {
        const p = map.project([draft.lng, draft.lat]);
        if (p && isFinite(p[0]) && isFinite(p[1])) return { x: p[0], y: p[1] };
      }
    } catch (err) { /* возьмём точку клика */ }
    return draft.click;
  }

  // Сдвинуть карту так, чтобы всё содержимое уехало на (dx, dy) пикселей.
  function panByPixels(dx, dy) {
    if (!map || (!dx && !dy)) return;
    try {
      const c = map.getCenter();
      const e = 1e-4;
      const p0 = map.project(c);
      const pa = map.project([c[0] + e, c[1]]);
      const pb = map.project([c[0], c[1] + e]);
      const ax = (pa[0] - p0[0]) / e, ay = (pa[1] - p0[1]) / e;
      const bx = (pb[0] - p0[0]) / e, by = (pb[1] - p0[1]) / e;
      const det = ax * by - bx * ay;
      if (!det) return;
      const tx = -dx, ty = -dy;                 // центр камеры едет в обратную сторону
      const dLng = (tx * by - bx * ty) / det;
      const dLat = (ax * ty - tx * ay) / det;
      map.setCenter([c[0] + dLng, c[1] + dLat], { duration: 300 });
      draft.panUntil = performance.now() + 450;
    } catch (err) { console.warn('Не удалось сдвинуть карту:', err); }
  }

  function headerBottom() {
    let b = 0;
    document.querySelectorAll('.top .brand, .top .search, .top .nav').forEach((el) => {
      b = Math.max(b, el.getBoundingClientRect().bottom);
    });
    return b + 8;
  }
  // Ниже этой линии метка видна без белого затухания под шапкой.
  function pinTopLimit() {
    return Math.max(headerBottom(), document.querySelector('.top').getBoundingClientRect().bottom - 24);
  }

  function positionMake() {
    makeDirty = false;
    const p = markerScreen();
    if (!draft || makeEl.hidden || !p) return;
    const vw = window.innerWidth, vh = window.innerHeight;
    const top = headerBottom();
    const now = performance.now();
    const canPan = now > draft.panUntil && now < draft.autoPanUntil;

    if (mqMobile.matches) {
      makeEl.classList.remove('make--anchored', 'make--left', 'make--notail');
      makeEl.style.transform = '';
      // Свободная полоса над панелью: метка должна быть видна целиком.
      const bandTop = pinTopLimit() + PIN_H;
      const bandBottom = vh - makeEl.offsetHeight - 14;
      let dx = 0, dy = 0;
      if (bandBottom > bandTop && (p.y < bandTop || p.y > bandBottom)) dy = (bandTop + bandBottom) / 2 - p.y;
      if (p.x < 24 || p.x > vw - 24) dx = vw / 2 - p.x;
      if (canPan) panByPixels(dx, dy);
      return;
    }

    const leftLimit = 16, rightLimit = vw - 70, bottomLimit = vh - 16;   // справа кнопки масштаба
    const w = makeEl.offsetWidth;
    const h = Math.min(makeEl.offsetHeight, bottomLimit - top);
    const fits = {
      right: p.x + PIN_HALF + GAP + w <= rightLimit,
      left: p.x - PIN_HALF - GAP - w >= leftLimit
    };

    if (canPan) {
      let dx = 0, dy = 0;
      if (!fits.right && !fits.left) {
        // Нигде не помещается — ставим метку левее, чтобы окно легло справа.
        dx = Math.max(leftLimit + 40, Math.min(p.x, rightLimit - w - GAP - PIN_HALF)) - p.x;
      }
      const minY = pinTopLimit() + PIN_H, maxY = bottomLimit - 8;
      if (p.y < minY) dy = minY - p.y;
      else if (p.y > maxY) dy = maxY - p.y;
      panByPixels(dx, dy);
    }

    // Сторона «прилипает», пока окно помещается: без дёрганья при движении карты.
    let side = draft.side || 'right';
    if (!fits[side] && fits[side === 'right' ? 'left' : 'right']) side = side === 'right' ? 'left' : 'right';
    draft.side = side;

    const wanted = side === 'right' ? p.x + PIN_HALF + GAP : p.x - PIN_HALF - GAP - w;
    const x = Math.max(leftLimit, Math.min(wanted, rightLimit - w));
    const y = Math.max(top, Math.min(p.y - PIN_H / 2 - h / 2, bottomLimit - h));

    makeEl.classList.add('make--anchored');
    makeEl.classList.toggle('make--left', side === 'left');
    makeEl.classList.toggle('make--notail', Math.abs(x - wanted) > 1);
    makeEl.style.setProperty('--tail-y', Math.max(22, Math.min(p.y - PIN_H / 2 - y, h - 22)) + 'px');
    makeEl.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
  }

  // Каждый кадр смотрим, не сдвинулась ли метка; перерисовываем окно только при изменении.
  function trackDraft() {
    trackRaf = 0;
    if (!draft) return;
    const p = markerScreen();
    if (p && (makeDirty || Math.abs(p.x - lastPos.x) > 0.5 || Math.abs(p.y - lastPos.y) > 0.5)) {
      lastPos = p;
      positionMake();
    }
    trackRaf = requestAnimationFrame(trackDraft);
  }
  function startTracking() { if (!trackRaf) trackRaf = requestAnimationFrame(trackDraft); }

  window.addEventListener('resize', () => { makeDirty = true; });
  mqMobile.addEventListener('change', () => { makeDirty = true; });
  if ('ResizeObserver' in window) new ResizeObserver(() => { makeDirty = true; }).observe(makeEl);

  function resetMakeForm() {
    $('#make-form').reset();
    $('#make-error').hidden = true;
    $('#make-district-wrap').hidden = true;
    renderFiles();
  }

  function renderMakeCats() {
    $('#make-cats').innerHTML = categories.length
      ? categories.map((c) => checkHTML('radio', 'cat', c.id, c.name, false)).join('')
      : '<p class="flist__empty">Категорий пока нет</p>';
    const sel = $('#make-district');
    sel.innerHTML = '<option value="">Не указывать</option>' + DISTRICTS.map((d) => '<option>' + esc(d) + '</option>').join('');
  }

  function renderFiles() {
    const list = $('#files');
    const files = draft ? draft.files : [];
    list.innerHTML = '';
    files.forEach((f, i) => {
      const li = document.createElement('li');
      if (f.type.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = URL.createObjectURL(f);
        img.alt = '';
        li.append(img);
      } else {
        const ph = document.createElement('span');
        ph.className = 'files__ph';
        ph.textContent = '▶';
        li.append(ph);
      }
      const name = document.createElement('span');
      name.className = 'files__name';
      name.textContent = f.name;
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.dataset.rm = i;
      rm.setAttribute('aria-label', 'Убрать файл ' + f.name);
      rm.textContent = '×';
      li.append(name, rm);
      list.append(li);
    });
  }

  function initMakeEvents() {
    $('#upload-btn').addEventListener('click', () => $('#upload-input').click());
    $('#upload-input').addEventListener('change', (e) => {
      if (!draft) return;
      const errors = [];
      [...e.target.files].forEach((f) => {
        const isImg = f.type.startsWith('image/');
        const isVid = f.type.startsWith('video/');
        if (!isImg && !isVid) { errors.push(f.name + ': нужен файл фото или видео'); return; }
        if (draft.files.length >= MAX_FILES) { errors.push('Не больше ' + MAX_FILES + ' файлов'); return; }
        if (f.size > (isImg ? MAX_IMAGE_MB : MAX_VIDEO_MB) * 1048576) {
          errors.push(f.name + ': больше ' + (isImg ? MAX_IMAGE_MB : MAX_VIDEO_MB) + ' МБ');
          return;
        }
        draft.files.push(f);
      });
      e.target.value = '';
      renderFiles();
      showMakeError(errors.length ? [...new Set(errors)].join('. ') + '.' : '');
    });
    $('#files').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-rm]'); if (!b || !draft) return;
      draft.files.splice(+b.dataset.rm, 1);
      renderFiles();
    });
    $('#make-close').addEventListener('click', cancelDraft);
    $('#make-cancel').addEventListener('click', cancelDraft);
    $('#make-form').addEventListener('submit', submitDraft);
  }

  function showMakeError(msg) {
    const el = $('#make-error');
    el.textContent = msg;
    el.hidden = !msg;
  }

  async function submitDraft(e) {
    e.preventDefault();
    if (!draft) return;
    if (!user) { toastLogin(); return; }
    const form = e.target;
    const catId = form.elements.cat.value;
    const works = form.elements.works.value;
    if (!catId) { showMakeError('Выберите категорию.'); return; }
    if (!works) { showMakeError('Укажите, проводятся ли работы.'); return; }
    showMakeError('');

    const btn = $('#make-submit');
    btn.disabled = true;
    btn.textContent = 'Сохраняем…';
    try {
      const geo = await draft.geo;
      const manualDistrict = $('#make-district').value;
      const media = [];
      for (let i = 0; i < draft.files.length; i++) {
        const f = draft.files[i];
        const ext = (f.name.split('.').pop() || 'bin').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'bin';
        const path = user.id + '/' + Date.now() + '-' + i + '.' + ext;
        const up = await sb.storage.from(BUCKET).upload(path, f, { contentType: f.type, upsert: false });
        if (up.error) throw new Error('Не удалось загрузить файл «' + f.name + '». ' + window.ruError(up.error, ''));
        const url = sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
        media.push({ url, type: f.type.startsWith('video/') ? 'video' : 'image' });
      }
      const row = {
        category_id: isNaN(Number(catId)) ? catId : Number(catId),
        lat: draft.lat,
        lng: draft.lng,
        address: (geo && geo.address) || null,
        district: (geo && geo.district) || manualDistrict || null,
        works_in_progress: works === 'yes',
        comment: $('#make-comment').value.trim() || null,
        media
      };
      const { data, error } = await sb.from('problems').insert(row).select('id').single();
      if (error) throw error;

      const lat = draft.lat, lng = draft.lng;
      cancelDraft();
      await loadProblems();
      flyTo(lat, lng, 15);
      openDetail(data.id);
      toast('Проблема отмечена на карте.');
    } catch (err) {
      console.error(err);
      showMakeError(window.ruError(err, 'Не удалось сохранить метку. Попробуйте ещё раз.'));
    } finally {
      btn.disabled = false;
      btn.textContent = 'Отметить';
    }
  }

  /* ===== Панели и навигация ===== */
  function closePanels() {
    openPanelName = null;
    $('#panel-filter').hidden = true;
    $('#panel-events').hidden = true;
    $('#nav-filter').setAttribute('aria-expanded', 'false');
    $('#nav-events').setAttribute('aria-expanded', 'false');
    syncLayers();
  }
  function openPanel(name) {
    if (openPanelName === name) { closePanels(); return; }
    closePanels();
    closeDetail();
    openPanelName = name;
    if (name === 'events' && feedDirty) renderFeed(true);
    $('#panel-' + name).hidden = false;
    $('#nav-' + name).setAttribute('aria-expanded', 'true');
    syncLayers();
  }

  function updateAccountLink() {
    $('#nav-account').href = user ? 'profile.html' : 'login.html';
  }

  function openFromHash() {
    const m = /^#problem-(\d+)$/.exec(location.hash);
    if (!m) return;
    const id = Number(m[1]);
    if (problems.some((p) => p.id === id)) focusProblem(id);
  }

  function initGlobalEvents() {
    document.querySelectorAll('[data-panel]').forEach((b) => b.addEventListener('click', () => openPanel(b.dataset.panel)));
    document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closePanels));
    $('#detail-close').addEventListener('click', closeDetail);
    $('#media-close').addEventListener('click', () => $('#media').close());
    $('#media').addEventListener('click', (e) => { if (e.target === $('#media')) $('#media').close(); });
    $('#media').addEventListener('close', () => { $('#media-grid').innerHTML = ''; });

    document.addEventListener('click', (e) => {
      const v = e.target.closest('[data-vote]');
      if (v) { vote(Number(v.dataset.id), v.dataset.vote === 'yes'); return; }
      const f = e.target.closest('[data-focus]');
      if (f) { closePanels(); focusProblem(Number(f.dataset.focus)); return; }
      const m = e.target.closest('[data-media]');
      if (m) openMedia(Number(m.dataset.media));
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (openPanelName) closePanels();
      else if (openDetailId) closeDetail();
      else if (draft) cancelDraft();
    });

    $('#locate').addEventListener('click', () => {
      if (!navigator.geolocation) { toast('Браузер не умеет определять местоположение.', { error: true }); return; }
      navigator.geolocation.getCurrentPosition((pos) => {
        const { latitude, longitude } = pos.coords;
        flyTo(latitude, longitude, 16);
        if (map) {
          if (meMarker) meMarker.destroy();
          meMarker = new mapgl.Marker(map, { coordinates: [longitude, latitude], icon: ME_ICON, size: [26, 26], anchor: [13, 13] });
        }
      }, () => toast('Не удалось определить, где вы. Разрешите доступ к геолокации.', { error: true }),
      { enableHighAccuracy: true, timeout: 10000 });
    });

    $('#agent').addEventListener('click', () => toast('AI-агент скоро появится.'));
    window.addEventListener('hashchange', openFromHash);
  }

  /* ===== Старт ===== */
  async function init() {
    if (!sb) {
      toast('Не загрузилась библиотека Supabase. Проверьте подключение к интернету.', { error: true });
    }
    initMap();
    initGlobalEvents();
    initFilterEvents();
    initSearch();
    initMakeEvents();
    renderFilter();
    renderFeed(true);
    if (!sb) return;

    const { data } = await sb.auth.getSession();
    user = data.session ? data.session.user : null;
    updateAccountLink();
    sb.auth.onAuthStateChange((_event, session) => {
      // Без await внутри колбэка, чтобы не заблокировать клиент Supabase.
      setTimeout(async () => {
        user = session ? session.user : null;
        updateAccountLink();
        await loadMyVotes();
        renderFeed();
        if (openDetailId) renderDetail();
      }, 0);
    });

    await loadCategories();            // сначала категории и их картинки меток
    await Promise.all([loadProblems(), loadMyVotes()]);
    renderFeed();
    openFromHash();
    // Чужие метки появляются без перезагрузки; пока вкладка скрыта, не обновляем.
    setInterval(() => { if (!document.hidden) loadProblems(); }, 60000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && Date.now() - lastLoad > 30000) loadProblems();
    });
  }

  init();
})();
