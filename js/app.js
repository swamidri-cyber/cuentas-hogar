/* Cuentas del hogar — lógica principal */
(function () {
  'use strict';
  const { money, parseMoney, moneyInput, today, monthKey, addMonths, monthsBetween, lastDay,
    monthName, dmy, dayLabel, pct, daysSince, norm, esc, pad } = window.F;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];

  const BACKUP_DAYS = 14;

  /* ---------------- Valores iniciales ---------------- */
  const DEF_FUENTES = [
    { id: 'f-peluqueria', nombre: 'Peluquería' },
    { id: 'f-insumos', nombre: 'Venta de insumos' },
    { id: 'f-cursos', nombre: 'Cursos' },
    { id: 'f-feria', nombre: 'Sahumerios en la feria' }
  ];
  const DEF_CATEGORIAS = [
    { id: 'c-alquiler', nombre: 'Alquiler', ambito: 'hogar' },
    { id: 'c-servicios', nombre: 'Servicios (luz, gas, agua, internet)', ambito: 'hogar' },
    { id: 'c-super', nombre: 'Supermercado', ambito: 'hogar' },
    { id: 'c-transporte', nombre: 'Transporte', ambito: 'hogar' },
    { id: 'c-salud', nombre: 'Salud', ambito: 'hogar' },
    { id: 'c-educacion', nombre: 'Educación', ambito: 'hogar' },
    { id: 'c-materiales', nombre: 'Materiales de trabajo', ambito: 'emprendimiento' },
    { id: 'c-impuestos', nombre: 'Impuestos / monotributo', ambito: 'emprendimiento' },
    { id: 'c-ocio', nombre: 'Ocio', ambito: 'hogar' },
    { id: 'c-otros', nombre: 'Otros', ambito: 'hogar' }
  ];
  const DEF_MEDIOS = [
    { id: 'm-efectivo', nombre: 'Efectivo' },
    { id: 'm-transferencia', nombre: 'Transferencia' },
    { id: 'm-mp', nombre: 'Mercado Pago' },
    { id: 'm-tarjeta', nombre: 'Tarjeta' }
  ];

  /* ---------------- Estado ---------------- */
  const S = {
    movs: [], fuentes: [], categorias: [], medios: [], fijos: [],
    inflacion: {}, saldoInicial: 0,
    settings: { tema: 'auto', autoCopia: true, ultimaCopia: null, primerUso: null, salteados: {}, ultimoTipo: 'gasto', ultimoMedio: {} },
    view: 'inicio',
    mesInicio: monthKey(), mesResumen: monthKey(),
    ajustarInfl: false,
    filtros: { tipo: '', periodo: 'mes', mes: monthKey(), desde: '', hasta: '', fuente: '', categoria: '', ambito: '', medio: '', q: '' }
  };

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const saveKV = (k) => DB.set(k, S[k]);
  const saveSettings = () => DB.set('settings', S.settings);

  /* ---------------- Utilidades de datos ---------------- */
  const listFor = tipo => tipo === 'ingreso' ? S.fuentes : S.categorias;
  function catName(tipo, id) {
    const c = listFor(tipo).find(x => x.id === id);
    return c ? c.nombre : '(sin categoría)';
  }
  function medioName(id) {
    const m = S.medios.find(x => x.id === id);
    return m ? m.nombre : '';
  }
  const signed = m => m.tipo === 'ingreso' ? m.monto : -m.monto;
  const movsOfMonth = mk => S.movs.filter(m => m.fecha.slice(0, 7) === mk);
  function sumBy(list, tipo) { return list.reduce((a, m) => a + (m.tipo === tipo ? m.monto : 0), 0); }

  function saldoHasta(mk, adj) {
    const end = mk + '-31';
    let s = S.saldoInicial * (adj ? inflFactor(S.settings.primerUso ? monthKey(S.settings.primerUso) : mk) : 1);
    for (const m of S.movs) if (m.fecha <= end) s += signed(m) * (adj ? inflFactor(m.fecha.slice(0, 7)) : 1);
    return Math.round(s);
  }

  /* Inflación: % mensual cargado a mano. Si falta un mes, se usa el último cargado antes. */
  function inflOf(mk) {
    if (S.inflacion[mk] != null) return S.inflacion[mk];
    const keys = Object.keys(S.inflacion).filter(k => k < mk).sort();
    return keys.length ? S.inflacion[keys[keys.length - 1]] : 0;
  }
  /** Multiplicador para llevar pesos del mes mk a pesos del mes actual */
  const factorCache = new Map();
  function inflFactor(mk) {
    const ref = monthKey();
    if (mk >= ref) return 1;
    const key = mk + '|' + ref;
    if (factorCache.has(key)) return factorCache.get(key);
    let f = 1, k = addMonths(mk, 1);
    while (k <= ref) { f *= 1 + inflOf(k) / 100; k = addMonths(k, 1); }
    factorCache.set(key, f);
    return f;
  }
  const hasInfl = () => Object.keys(S.inflacion).length > 0;

  /* ---------------- Fijos (recurrentes) ---------------- */
  function fijoDate(f, mk) { return mk + '-' + pad(Math.min(f.dia || 1, lastDay(mk))); }
  function fijoSugerido(f) {
    const prev = S.movs.filter(m => m.fijoId === f.id).sort((a, b) => b.fecha.localeCompare(a.fecha))[0];
    return prev ? prev.monto : f.monto;
  }
  function pendientes(mk) {
    const salt = S.settings.salteados[mk] || [];
    return S.fijos.filter(f => f.activo !== false && (!f.desde || f.desde <= mk) && !salt.includes(f.id) &&
      !S.movs.some(m => m.fijoId === f.id && m.fecha.slice(0, 7) === mk))
      .sort((a, b) => (a.dia || 1) - (b.dia || 1));
  }

  /* ---------------- Presupuestos ---------------- */
  function budgetState(cat, gastado) {
    if (!cat.tope) return null;
    const r = gastado / cat.tope;
    return { r, level: r >= 1 ? 'bad' : r >= 0.8 ? 'warn' : 'ok' };
  }
  function budgetsOfMonth(mk) {
    const list = movsOfMonth(mk);
    return S.categorias.filter(c => c.tope > 0 && !c.archivada).map(c => {
      const g = list.reduce((a, m) => a + (m.tipo === 'gasto' && m.cat === c.id ? m.monto : 0), 0);
      return { cat: c, gastado: g, st: budgetState(c, g) };
    });
  }

  /* ---------------- Diálogos (con botón "atrás" del celular) ---------------- */
  const dlgStack = [];
  let ignorePop = 0;
  function openDlg(d) {
    if (d.open) return;
    d.showModal();
    dlgStack.push(d);
    history.pushState({ dlg: dlgStack.length }, '');
  }
  function closeDlg(d) { if (d.open) d.close(); }
  $$('dialog').forEach(d => {
    d.addEventListener('close', () => {
      const i = dlgStack.lastIndexOf(d);
      if (i !== -1) {
        dlgStack.splice(i, 1);
        ignorePop++;
        history.back();
      }
    });
    d.addEventListener('cancel', e => { e.preventDefault(); closeDlg(d); });
    d.addEventListener('click', e => {
      if (e.target.closest('[data-close]')) closeDlg(d);
      // tocar el fondo cierra las hojas
      if (e.target === d) {
        const r = d.getBoundingClientRect();
        if (e.clientY < r.top || e.clientY > r.bottom || e.clientX < r.left || e.clientX > r.right) closeDlg(d);
      }
    });
  });
  window.addEventListener('popstate', () => {
    if (ignorePop) { ignorePop--; return; }
    const top = dlgStack.pop();
    if (top && top.open) top.close();
  });

  function confirmBox(title, text, okLabel, danger) {
    const d = $('#dlgConfirm');
    $('#dlgConfirmTitle').textContent = title;
    $('#dlgConfirmText').textContent = text;
    const ok = $('#dlgConfirmOk');
    ok.textContent = okLabel || 'Sí, borrar';
    ok.className = 'btn ' + (danger === false ? 'btn--primary' : 'btn--danger');
    openDlg(d);
    return new Promise(res => {
      let done = false;
      const finish = v => {
        if (done) return;
        done = true;
        ok.onclick = cancel.onclick = null;
        closeDlg(d);
        res(v);
      };
      const cancel = d.querySelector('button[value="cancel"]');
      ok.onclick = e => { e.preventDefault(); finish(true); };
      cancel.onclick = e => { e.preventDefault(); finish(false); };
      d.addEventListener('close', () => finish(false), { once: true });
    });
  }

  /* ---------------- Toast ---------------- */
  let toastT;
  function toast(msg, action) {
    const t = $('#toast');
    t.innerHTML = '<span>' + esc(msg) + '</span>' + (action ? '<button type="button">' + esc(action.label) + '</button>' : '');
    if (action) t.querySelector('button').onclick = () => { t.classList.remove('show'); action.fn(); };
    t.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove('show'), action ? 6000 : 3200);
  }

  /* ---------------- Tema ---------------- */
  function applyTheme() {
    const t = S.settings.tema;
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
  }
  const isDark = () => getComputedStyle(document.documentElement).colorScheme === 'dark';
  $('#btnTheme').addEventListener('click', () => {
    S.settings.tema = isDark() ? 'light' : 'dark';
    applyTheme(); saveSettings();
    if (S.view === 'ajustes') renderAjustes();
  });

  /* ---------------- Navegación ---------------- */
  const VIEWS = ['inicio', 'movs', 'resumen', 'ajustes'];
  function go(view) {
    if (!VIEWS.includes(view)) view = 'inicio';
    S.view = view;
    VIEWS.forEach(v => { $('#view-' + v).hidden = v !== view; });
    $$('.tabs a').forEach(a => a.toggleAttribute('aria-current', a.dataset.view === view));
    $$('.tabs a').forEach(a => { if (a.dataset.view === view) a.setAttribute('aria-current', 'page'); });
    $('#viewTitle').textContent = $('#view-' + view).dataset.title;
    render();
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', () => go(location.hash.slice(1)));

  function render() {
    factorCache.clear();
    renderBanners();
    if (S.view === 'inicio') renderInicio();
    else if (S.view === 'movs') renderMovs();
    else if (S.view === 'resumen') renderResumen();
    else renderAjustes();
  }

  function monthNav(el, mk, onChange) {
    const cur = monthKey();
    el.innerHTML = `
      <button class="icon-btn" type="button" data-d="-1" aria-label="Mes anterior"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg></button>
      <p class="month-nav__label" aria-live="polite">${esc(monthName(mk))}</p>
      <button class="icon-btn" type="button" data-d="1" aria-label="Mes siguiente" ${mk >= cur ? 'disabled style="opacity:.35"' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></button>`;
    el.querySelectorAll('button').forEach(b => b.onclick = () => {
      const n = addMonths(mk, +b.dataset.d);
      if (n > cur) return;
      onChange(n);
    });
  }

  /* ---------------- Avisos (copia de seguridad, almacenamiento) ---------------- */
  function backupDue() {
    if (!S.movs.length) return false;
    return daysSince(S.settings.ultimaCopia || S.settings.primerUso) >= BACKUP_DAYS;
  }
  function renderBanners() {
    const box = $('#banners');
    let h = '';
    if (DB.isMemory()) {
      h += `<div class="banner banner--bad" role="alert">
        <svg class="banner__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>
        <div class="banner__body"><strong>Este navegador no deja guardar datos.</strong>
        Lo que cargues se pierde al cerrar. Abrí la app desde Chrome (no en modo incógnito).</div></div>`;
    }
    if (backupDue() && S.view !== 'ajustes') {
      const d = S.settings.ultimaCopia ? `Tu última copia es del ${dmy(S.settings.ultimaCopia.slice(0, 10))}.` : 'Todavía no guardaste ninguna copia.';
      h += `<div class="banner" role="status">
        <svg class="banner__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 10l5 5 5-5M4 19h16"/></svg>
        <div class="banner__body"><strong>Es momento de guardar una copia</strong>${d}
        <div class="row-actions">
          <button type="button" class="btn btn--primary" data-act="backup-dl">Guardar copia</button>
          ${canShareFiles() ? '<button type="button" class="btn btn--ghost" data-act="backup-share">Mandar a Drive / WhatsApp</button>' : ''}
        </div></div></div>`;
    }
    box.innerHTML = h;
  }

  /* ================= INICIO ================= */
  function renderInicio() {
    const mk = S.mesInicio;
    monthNav($('[data-month-nav="inicio"]'), mk, n => { S.mesInicio = n; renderInicio(); });
    const body = $('#inicioBody');

    if (!S.movs.length && !pendientes(monthKey()).length) {
      body.innerHTML = `
        <div class="hero">
          <span class="mark m-espiral hero__deco" aria-hidden="true"></span>
          <p class="eyebrow">Bienvenida</p>
          <p class="hero__value">Tus cuentas, a mano</p>
          <p class="hero__sub">Tocá el botón <b>+</b> para cargar tu primer ingreso o gasto. Todo queda guardado sólo en este celular.</p>
        </div>
        <div class="card">
          <h3>Para arrancar</h3>
          <ol class="small" style="padding-left:20px;margin:10px 0 0;line-height:1.8">
            <li>Cargá tus gastos fijos (alquiler, monotributo…) desde <a href="#ajustes">Ajustes</a>, así cada mes te los sugiero.</li>
            <li>Si querés, poné un tope por categoría para que te avise cuando te acerques.</li>
            <li>Cada 2 semanas te voy a recordar guardar una copia de seguridad.</li>
          </ol>
        </div>`;
      return;
    }

    const list = movsOfMonth(mk);
    const ing = sumBy(list, 'ingreso'), gas = sumBy(list, 'gasto'), bal = ing - gas;
    const gasHogar = list.reduce((a, m) => a + (m.tipo === 'gasto' && m.ambito !== 'emprendimiento' ? m.monto : 0), 0);
    const gasEmp = gas - gasHogar;
    let h = `
      <div class="hero">
        <span class="mark m-espiral hero__deco" aria-hidden="true"></span>
        <p class="eyebrow">Balance del mes</p>
        <p class="hero__value num">${money(bal)}</p>
        <p class="hero__sub">Saldo acumulado: <b class="num">${money(saldoHasta(mk))}</b></p>
        <div class="hero__split">
          <div><span class="lbl"><i class="dot" style="background:var(--c-ing)"></i>Ingresos</span><span class="val num">${money(ing)}</span></div>
          <div><span class="lbl"><i class="dot" style="background:var(--c-gas)"></i>Gastos</span><span class="val num">${money(gas)}</span></div>
        </div>
      </div>`;

    // Fijos pendientes (sólo mes actual)
    if (mk === monthKey()) {
      const pend = pendientes(mk);
      if (pend.length) {
        const hoy = new Date().getDate();
        h += `<div class="card"><div class="card__head"><h3>Fijos de ${esc(F.MESES[+mk.slice(5) - 1])}</h3><span class="muted small">${pend.length} pendiente${pend.length > 1 ? 's' : ''}</span></div>` +
          pend.map(f => {
            const venc = (f.dia || 1) <= hoy;
            return `<div class="pend">
              <div class="pend__main">
                <p class="pend__title">${esc(f.desc || catName(f.tipo, f.cat))}</p>
                <p class="pend__meta"><span class="num ${f.tipo === 'ingreso' ? 'pos' : 'neg'}">${money(fijoSugerido(f))}</span> · día ${f.dia || 1}${venc ? ' · <b>ya pasó</b>' : ''}</p>
              </div>
              <div class="pend__actions">
                <button type="button" class="btn btn--primary btn--sm" data-act="fijo-ok" data-id="${f.id}">Registrar</button>
                <button type="button" class="btn btn--ghost btn--sm" data-act="fijo-edit" data-id="${f.id}" aria-label="Cambiar monto o fecha de ${esc(f.desc || '')}">Cambiar</button>
                <button type="button" class="link small" data-act="fijo-skip" data-id="${f.id}">Saltear</button>
              </div>
            </div>`;
          }).join('') + '</div>';
      }
    }

    // Presupuestos en alerta
    const alerts = budgetsOfMonth(mk).filter(b => b.st.level !== 'ok');
    if (alerts.length) {
      h += `<div class="card"><div class="card__head"><h3>Presupuesto</h3></div>` + alerts.map(budgetRow).join('') + '</div>';
    }

    // Números clave
    h += `<div class="card"><div class="stats">
      <div class="stat"><p class="stat__lbl">Gastos del hogar</p><p class="stat__val num">${money(gasHogar)}</p></div>
      <div class="stat"><p class="stat__lbl">Gastos del emprendimiento</p><p class="stat__val num">${money(gasEmp)}</p></div>
      <div class="stat"><p class="stat__lbl">Ganancia del emprendimiento</p><p class="stat__val num ${ing - gasEmp < 0 ? 'neg' : ''}">${money(ing - gasEmp)}</p></div>
      <div class="stat"><p class="stat__lbl">Ahorraste</p><p class="stat__val num">${ing > 0 ? pct(bal / ing) : '—'}</p></div>
    </div></div>`;

    // Últimos movimientos
    const last = [...list].sort(sortMov).slice(0, 6);
    h += `<div class="card"><div class="card__head"><h3>Últimos movimientos</h3>${list.length > 6 ? '<a class="link small" href="#movs" data-act="ver-mes">Ver todos</a>' : ''}</div>`;
    h += last.length ? last.map(movRow).join('') : `<p class="muted small">No hay movimientos en ${esc(monthName(mk))}.</p>`;
    h += '</div>';
    body.innerHTML = h;
  }

  function budgetRow(b) {
    const w = Math.min(100, b.st.r * 100);
    const lv = b.st.level;
    const msg = lv === 'bad' ? `Te pasaste por ${money(b.gastado - b.cat.tope)}` :
      lv === 'warn' ? `Ojo: usaste el ${pct(b.st.r)}. Te quedan ${money(b.cat.tope - b.gastado)}` :
        `Te quedan ${money(b.cat.tope - b.gastado)}`;
    return `<div class="budget">
      <div class="budget__row"><span>${esc(b.cat.nombre)}</span><span class="num">${money(b.gastado, { noCents: true })} / ${money(b.cat.tope, { noCents: true })}</span></div>
      <div class="budget__bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(b.st.r * 100)}" aria-label="${esc(b.cat.nombre)}"><div class="budget__fill ${lv !== 'ok' ? 'budget__fill--' + lv : ''}" style="width:${w}%"></div></div>
      <p class="budget__state ${lv !== 'ok' ? 'budget__state--' + lv : ''}">${lv === 'bad' ? '⚠ ' : lv === 'warn' ? '◔ ' : ''}${msg}</p>
    </div>`;
  }

  const sortMov = (a, b) => b.fecha.localeCompare(a.fecha) || (b.creado || 0) - (a.creado || 0);

  function movRow(m) {
    const ingreso = m.tipo === 'ingreso';
    const name = catName(m.tipo, m.cat);
    const title = m.desc || name;
    const meta = [m.desc ? name : null, medioName(m.medio)].filter(Boolean).join(' · ');
    const tag = !ingreso && m.ambito === 'emprendimiento' ? ' <span class="tag">emprend.</span>' : '';
    const fijo = m.fijoId ? ' <span class="tag">fijo</span>' : '';
    return `<button type="button" class="mov" data-act="edit-mov" data-id="${m.id}">
      <span class="mov__icon mov__icon--${m.tipo}" aria-hidden="true">${ingreso ? '+' : '−'}</span>
      <span class="mov__main"><span class="mov__title" style="display:block">${esc(title)}</span>
      <span class="mov__meta" style="display:block">${esc(meta)}${tag}${fijo}</span></span>
      <span class="mov__amt num ${ingreso ? 'pos' : 'neg'}">${ingreso ? '+' : '−'}${money(m.monto).replace('−', '')}</span>
    </button>`;
  }

  /* ================= MOVIMIENTOS ================= */
  function fillFilterSelects() {
    const opt = (list, sel, all) => `<option value="">${all}</option>` + list.map(x => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${esc(x.nombre)}${x.archivada ? ' (archivada)' : ''}</option>`).join('');
    $('#fFuente').innerHTML = opt(S.fuentes, S.filtros.fuente, 'Todas');
    $('#fCategoria').innerHTML = opt(S.categorias, S.filtros.categoria, 'Todas');
    $('#fMedio').innerHTML = opt(S.medios, S.filtros.medio, 'Todos');
  }

  function filtered() {
    const f = S.filtros;
    const q = norm(f.q.trim());
    const qNum = q.replace(/[^\d]/g, '');
    const cats = [f.fuente, f.categoria].filter(Boolean);
    return S.movs.filter(m => {
      if (f.tipo && m.tipo !== f.tipo) return false;
      if (f.periodo === 'mes' && f.mes && m.fecha.slice(0, 7) !== f.mes) return false;
      if (f.periodo === 'rango') {
        if (f.desde && m.fecha < f.desde) return false;
        if (f.hasta && m.fecha > f.hasta) return false;
      }
      if (cats.length && !cats.includes(m.cat)) return false;
      if (f.ambito && (m.tipo !== 'gasto' || (m.ambito || 'hogar') !== f.ambito)) return false;
      if (f.medio && m.medio !== f.medio) return false;
      if (q) {
        const hay = norm([m.desc, catName(m.tipo, m.cat), medioName(m.medio), m.tipo, dmy(m.fecha)].join(' '));
        const amt = String(Math.floor(m.monto / 100));
        if (!hay.includes(q) && !(qNum && qNum.length >= 2 && amt.includes(qNum))) return false;
      }
      return true;
    }).sort(sortMov);
  }

  function syncFilterUI() {
    const f = S.filtros;
    $$('#fTipo button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.v === f.tipo)));
    $('#fPeriodo').value = f.periodo;
    $('#fMes').value = f.mes;
    $('#fDesde').value = f.desde;
    $('#fHasta').value = f.hasta;
    $('#fAmbito').value = f.ambito;
    $$('[data-show]').forEach(el => { el.hidden = el.dataset.show !== f.periodo; });
    const n = [f.periodo !== 'mes' || f.mes !== monthKey(), f.fuente, f.categoria, f.ambito, f.medio].filter(Boolean).length;
    $('#filtersCount').textContent = n ? String(n) : '';
  }

  function renderMovs() {
    fillFilterSelects();
    syncFilterUI();
    const list = filtered();
    const ing = sumBy(list, 'ingreso'), gas = sumBy(list, 'gasto');
    $('#movsTotals').innerHTML = `
      <div><p class="lbl">Ingresos</p><p class="val num pos">${money(ing)}</p></div>
      <div><p class="lbl">Gastos</p><p class="val num neg">${money(gas)}</p></div>
      <div><p class="lbl">Balance</p><p class="val num">${money(ing - gas)}</p></div>`;
    if (!list.length) {
      $('#movsList').innerHTML = `<div class="empty"><span class="mark m-flor" aria-hidden="true"></span>
        <p>No encontré movimientos${S.filtros.q ? ' con “' + esc(S.filtros.q) + '”' : ''}.</p>
        <p class="small">Probá cambiar los filtros o el mes.</p></div>`;
      return;
    }
    let h = '', day = null, buf = [];
    const flush = () => {
      if (!day) return;
      const tot = buf.reduce((a, m) => a + signed(m), 0);
      h += `<div class="day"><div class="day__head"><span>${esc(dayLabel(day))}</span><span class="num">${money(tot, { sign: true })}</span></div>${buf.map(movRow).join('')}</div>`;
    };
    for (const m of list) {
      if (m.fecha !== day) { flush(); day = m.fecha; buf = []; }
      buf.push(m);
    }
    flush();
    $('#movsList').innerHTML = h;
  }

  // Eventos de filtros
  let qT;
  $('#q').addEventListener('input', e => { clearTimeout(qT); qT = setTimeout(() => { S.filtros.q = e.target.value; renderMovs(); }, 150); });
  $('#fTipo').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    S.filtros.tipo = b.dataset.v; renderMovs();
  });
  [['#fPeriodo', 'periodo'], ['#fMes', 'mes'], ['#fDesde', 'desde'], ['#fHasta', 'hasta'], ['#fFuente', 'fuente'], ['#fCategoria', 'categoria'], ['#fAmbito', 'ambito'], ['#fMedio', 'medio']]
    .forEach(([sel, k]) => $(sel).addEventListener('change', e => {
      S.filtros[k] = e.target.value;
      if (k === 'periodo' && e.target.value === 'mes' && !S.filtros.mes) S.filtros.mes = monthKey();
      renderMovs();
    }));
  $('#btnClearFilters').addEventListener('click', () => {
    Object.assign(S.filtros, { tipo: '', periodo: 'mes', mes: monthKey(), desde: '', hasta: '', fuente: '', categoria: '', ambito: '', medio: '', q: '' });
    $('#q').value = '';
    renderMovs();
  });
  $('#btnCsvFiltered').addEventListener('click', () => exportCSV(filtered(), 'movimientos-filtrados'));

  /* ================= RESUMEN ================= */
  function colorFuente(id) {
    const active = S.fuentes;
    const i = active.findIndex(f => f.id === id);
    return i >= 0 && i < Charts.SERIES.length ? Charts.SERIES[i] : 'var(--c-otros)';
  }

  function renderResumen() {
    const mk = S.mesResumen;
    monthNav($('[data-month-nav="resumen"]'), mk, n => { S.mesResumen = n; renderResumen(); });
    const chk = $('#chkInfl');
    chk.checked = S.ajustarInfl;
    const adj = S.ajustarInfl;
    const fx = k => adj ? inflFactor(k) : 1;
    const A = (v, k) => Math.round(v * fx(k));
    const body = $('#resumenBody');

    if (!S.movs.length) {
      body.innerHTML = `<div class="empty"><span class="mark m-estrella" aria-hidden="true"></span><p>Cuando cargues movimientos, acá vas a ver gráficos y comparaciones.</p></div>`;
      return;
    }

    let h = '';
    if (adj) {
      h += hasInfl()
        ? `<p class="small muted" style="margin-top:4px">Montos llevados a pesos de ${esc(monthName(monthKey()))} con la inflación que cargaste. Si falta un mes, uso el último % cargado.</p>`
        : `<div class="banner"><svg class="banner__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v5M12 16h.01"/><circle cx="12" cy="12" r="9"/></svg><div class="banner__body"><strong>Falta cargar la inflación</strong>Cargá el % de cada mes en <a href="#ajustes">Ajustes</a> para ver los montos ajustados.</div></div>`;
    }

    const list = movsOfMonth(mk);
    const prevMk = addMonths(mk, -1);
    const prevList = movsOfMonth(prevMk);
    const ing = A(sumBy(list, 'ingreso'), mk), gas = A(sumBy(list, 'gasto'), mk);

    // 1. Balance
    h += `<div class="card"><div class="card__head"><h3>Balance del mes</h3></div>
      <div class="stats">
        <div class="stat"><p class="stat__lbl">Ingresos</p><p class="stat__val num pos">${money(ing)}</p></div>
        <div class="stat"><p class="stat__lbl">Gastos</p><p class="stat__val num neg">${money(gas)}</p></div>
        <div class="stat"><p class="stat__lbl">Balance</p><p class="stat__val num">${money(ing - gas)}</p></div>
        <div class="stat"><p class="stat__lbl">Saldo acumulado</p><p class="stat__val num">${money(saldoHasta(mk, adj))}</p></div>
      </div></div>`;

    // 2. Ingresos por fuente
    const byF = new Map(), byFPrev = new Map();
    list.forEach(m => { if (m.tipo === 'ingreso') byF.set(m.cat, (byF.get(m.cat) || 0) + m.monto); });
    prevList.forEach(m => { if (m.tipo === 'ingreso') byFPrev.set(m.cat, (byFPrev.get(m.cat) || 0) + m.monto); });
    const ids = [...new Set([...byF.keys(), ...byFPrev.keys()])];
    const rows = ids.map(id => ({ id, nombre: catName('ingreso', id), cur: A(byF.get(id) || 0, mk), prev: A(byFPrev.get(id) || 0, prevMk) }))
      .sort((a, b) => b.cur - a.cur || b.prev - a.prev);
    h += `<div class="card"><div class="card__head"><h3>Ingresos por fuente</h3></div>`;
    if (ing > 0) {
      const items = rows.filter(r => r.cur > 0).map(r => ({ label: r.nombre, value: r.cur, color: colorFuente(r.id) }));
      h += `<div class="donut-wrap">${Charts.donut(items, { label: 'INGRESOS', value: money(ing, { noCents: true }), aria: 'Ingresos por fuente en ' + monthName(mk) })}
        <ul class="rank">${rows.filter(r => r.cur > 0).map(r => `<li>
          <i class="dot" style="background:${colorFuente(r.id)};width:12px;height:12px;border-radius:3px"></i>
          <span class="name">${esc(r.nombre)}</span>
          <span class="num" style="text-align:right">${money(r.cur, { noCents: true })} <span class="pct">${pct(r.cur / ing)}</span></span>
        </li>`).join('')}</ul></div>`;
    } else {
      h += `<p class="muted small">No hay ingresos en ${esc(monthName(mk))}.</p>`;
    }
    // Variaciones vs mes anterior
    if (rows.length) {
      h += `<h3 style="font-size:1.1rem;margin-top:18px">Comparado con ${esc(F.MESES[+prevMk.slice(5) - 1])}</h3><ul class="rank" style="margin-top:4px">` +
        rows.map(r => {
          const d = r.cur - r.prev;
          let txt, cls = '';
          if (r.prev === 0 && r.cur > 0) { txt = '★ Nueva este mes (el anterior no tuvo)'; cls = 'pos'; }
          else if (r.cur === 0) { txt = '▼ Este mes no tuvo ingresos (antes ' + money(r.prev, { noCents: true }) + ')'; cls = 'neg'; }
          else if (Math.abs(d) < 100) { txt = '＝ Igual que el mes anterior'; }
          else if (d > 0) { txt = '▲ Creció ' + pct(d / r.prev) + ' (' + money(d, { sign: true, noCents: true }) + ')'; cls = 'pos'; }
          else { txt = '▼ Bajó ' + pct(-d / r.prev) + ' (' + money(d, { noCents: true }) + ')'; cls = 'neg'; }
          return `<li><i class="dot" style="background:${colorFuente(r.id)};width:12px;height:12px;border-radius:3px"></i><span class="name">${esc(r.nombre)}</span><span></span><span class="delta ${cls}">${txt}</span></li>`;
        }).join('') + '</ul>';
    }
    h += '</div>';

    // 3. Gastos por categoría
    const byC = new Map();
    let gHog = 0, gEmp = 0;
    list.forEach(m => {
      if (m.tipo !== 'gasto') return;
      byC.set(m.cat, (byC.get(m.cat) || 0) + m.monto);
      if (m.ambito === 'emprendimiento') gEmp += m.monto; else gHog += m.monto;
    });
    const crow = [...byC.entries()].map(([id, v]) => ({ cat: S.categorias.find(c => c.id === id) || { id, nombre: '(sin categoría)' }, raw: v, v: A(v, mk) })).sort((a, b) => b.v - a.v);
    h += `<div class="card"><div class="card__head"><h3>Gastos por categoría</h3></div>`;
    if (crow.length) {
      const maxV = Math.max(...crow.map(r => Math.max(r.v, A(r.cat.tope || 0, mk))));
      h += crow.map(r => {
        const st = budgetState(r.cat, r.raw);
        const cap = r.cat.tope ? `<span class="hbar__cap" style="left:${(A(r.cat.tope, mk) / maxV * 100).toFixed(1)}%" title="Tope"></span>` : '';
        const meta = st ? (st.level === 'bad' ? `<span class="neg"><b>⚠ Pasaste el tope</b> de ${money(r.cat.tope, { noCents: true })}</span>` :
          st.level === 'warn' ? `<span style="color:var(--warn-ink)"><b>◔ ${pct(st.r)} del tope</b> de ${money(r.cat.tope, { noCents: true })}</span>` :
            `${pct(st.r)} del tope de ${money(r.cat.tope, { noCents: true })}`) : '';
        return `<div class="hbar">
          <div class="hbar__row"><span>${esc(r.cat.nombre)}</span><span class="num">${money(r.v, { noCents: true })} <span class="muted small">${pct(r.v / gas)}</span></span></div>
          <div class="hbar__track"><div class="hbar__fill" style="width:${(r.v / maxV * 100).toFixed(1)}%"></div>${cap}</div>
          ${meta ? `<p class="hbar__meta">${meta}</p>` : ''}
        </div>`;
      }).join('');
      h += `<div class="stats" style="margin-top:16px">
        <div class="stat"><p class="stat__lbl">Hogar</p><p class="stat__val num">${money(A(gHog, mk))}</p></div>
        <div class="stat"><p class="stat__lbl">Emprendimiento</p><p class="stat__val num">${money(A(gEmp, mk))}</p></div></div>`;
    } else {
      h += `<p class="muted small">No hay gastos en ${esc(monthName(mk))}.</p>`;
    }
    h += '</div>';

    // 4. Últimos 12 meses
    const first = S.movs.reduce((a, m) => m.fecha < a ? m.fecha : a, '9999').slice(0, 7);
    const months = [];
    for (let i = 11; i >= 0; i--) months.push(addMonths(mk, -i));
    const mrows = months.map(k => {
      const l = movsOfMonth(k);
      return { mk: k, ing: A(sumBy(l, 'ingreso'), k), gas: A(sumBy(l, 'gasto'), k) };
    });
    h += `<div class="card"><div class="card__head"><h3>Mes a mes</h3><span class="muted small">últimos 12 meses</span></div>
      ${Charts.monthBars(mrows, { current: mk, aria: 'Ingresos y gastos de los últimos 12 meses' })}
      <details class="table-toggle"><summary>Ver como tabla</summary><div class="tbl-wrap"><table class="tbl">
        <thead><tr><th>Mes</th><th>Ingresos</th><th>Gastos</th><th>Balance</th></tr></thead>
        <tbody>${mrows.slice().reverse().map(r => `<tr><td>${esc(monthName(r.mk, { short: true, year: true }))}</td><td class="num">${money(r.ing, { noCents: true })}</td><td class="num">${money(r.gas, { noCents: true })}</td><td class="num ${r.ing - r.gas < 0 ? 'neg' : ''}">${money(r.ing - r.gas, { noCents: true })}</td></tr>`).join('')}</tbody>
      </table></div></details></div>`;

    // 5. Promedios (sólo meses desde que hay datos)
    const start = first > months[0] ? first : months[0];
    const n = monthsBetween(start, mk) + 1;
    if (n > 0) {
      const used = mrows.filter(r => r.mk >= start);
      const ti = used.reduce((a, r) => a + r.ing, 0), tg = used.reduce((a, r) => a + r.gas, 0);
      h += `<div class="card"><div class="card__head"><h3>Promedio mensual</h3><span class="muted small">${n} mes${n > 1 ? 'es' : ''}</span></div>
        <div class="stats">
          <div class="stat"><p class="stat__lbl">Ingresos</p><p class="stat__val num">${money(ti / n)}</p></div>
          <div class="stat"><p class="stat__lbl">Gastos</p><p class="stat__val num">${money(tg / n)}</p></div>
          <div class="stat"><p class="stat__lbl">Balance</p><p class="stat__val num">${money((ti - tg) / n)}</p></div>
          <div class="stat"><p class="stat__lbl">Este mes vs promedio</p><p class="stat__val num">${ti > 0 ? (ing >= ti / n ? '▲ ' : '▼ ') + pct(Math.abs(ing - ti / n) / (ti / n)) : '—'}</p></div>
        </div>
        <p class="small muted" style="margin-top:8px">Calculado desde ${esc(monthName(start))} hasta ${esc(monthName(mk))}.</p></div>`;
    }

    // 6. Presupuestos completos
    const bud = budgetsOfMonth(mk);
    if (bud.length) h += `<div class="card"><div class="card__head"><h3>Presupuesto</h3></div>${bud.map(budgetRow).join('')}</div>`;

    body.innerHTML = h;
    Charts.bindTips(body);
  }
  $('#chkInfl').addEventListener('change', e => { S.ajustarInfl = e.target.checked; renderResumen(); });

  /* ================= HOJA DE MOVIMIENTO ================= */
  const M = { tipo: 'gasto', cat: null, medio: null, ambito: 'hogar', editId: null, fijoId: null };

  function setSeg(el, v) { $$('button', el).forEach(b => b.setAttribute('aria-checked', String(b.dataset.v === v))); }

  function renderMovChips() {
    const tipo = M.tipo;
    const list = listFor(tipo).filter(c => !c.archivada || c.id === M.cat);
    $('#mCatLegend').textContent = tipo === 'ingreso' ? 'Fuente' : 'Categoría';
    $('#mCats').innerHTML = list.map(c => `<button type="button" class="chip" data-id="${c.id}" aria-pressed="${c.id === M.cat}">${esc(c.nombre)}</button>`).join('') +
      `<button type="button" class="chip chip--add" data-add>+ Nueva</button>`;
    $('#mMedios').innerHTML = S.medios.filter(m => !m.archivada || m.id === M.medio).map(m => `<button type="button" class="chip" data-id="${m.id}" aria-pressed="${m.id === M.medio}">${esc(m.nombre)}</button>`).join('') +
      `<button type="button" class="chip chip--add" data-add>+ Otro</button>`;
    $('#mAmbitoBox').hidden = tipo !== 'gasto';
    setSeg($('#mAmbito'), M.ambito);
    setSeg($('#mTipo'), tipo);
    // descripciones usadas antes
    const descs = [...new Set(S.movs.filter(m => m.tipo === tipo && m.desc && (!M.cat || m.cat === M.cat)).sort(sortMov).map(m => m.desc))].slice(0, 30);
    $('#descSugeridas').innerHTML = descs.map(d => `<option value="${esc(d)}">`).join('');
  }

  function openMov(opts) {
    opts = opts || {};
    const m = opts.mov;
    const f = opts.fijo;
    M.editId = m ? m.id : null;
    M.fijoId = m ? (m.fijoId || null) : (f ? f.id : null);
    M.tipo = m ? m.tipo : f ? f.tipo : (opts.tipo || S.settings.ultimoTipo || 'gasto');
    M.cat = m ? m.cat : f ? f.cat : null;
    M.medio = m ? m.medio : f ? f.medio : (S.settings.ultimoMedio[M.tipo] || 'm-efectivo');
    M.ambito = m ? (m.ambito || 'hogar') : f ? (f.ambito || 'hogar') : 'hogar';
    $('#sheetMovTitle').textContent = m ? 'Editar movimiento' : f ? 'Registrar fijo' : 'Nuevo movimiento';
    $('#mMonto').value = m ? moneyInput(m.monto) : f ? moneyInput(fijoSugerido(f)) : '';
    $('#mFecha').value = m ? m.fecha : f ? fijoDate(f, monthKey()) : today();
    $('#mDesc').value = m ? (m.desc || '') : f ? (f.desc || '') : '';
    $('#mRepetir').checked = false;
    $('#mRepetirBox').hidden = !!(m || f);
    $('#btnDeleteMov').hidden = !m;
    $('#mMontoHint').textContent = '';
    $('#mMontoHint').classList.remove('err');
    renderMovChips();
    openDlg($('#sheetMov'));
    if (!m && !f) setTimeout(() => $('#mMonto').focus(), 60);
  }

  $('#fab').addEventListener('click', () => openMov());

  $('#mTipo').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || b.dataset.v === M.tipo) return;
    M.tipo = b.dataset.v; M.cat = null;
    M.medio = S.settings.ultimoMedio[M.tipo] || M.medio;
    renderMovChips();
  });
  $('#mAmbito').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    M.ambito = b.dataset.v; setSeg($('#mAmbito'), M.ambito);
  });
  $('#mCats').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.hasAttribute('data-add')) {
      editCatalog(M.tipo === 'ingreso' ? 'fuentes' : 'categorias', null, item => { M.cat = item.id; if (item.ambito) M.ambito = item.ambito; renderMovChips(); });
      return;
    }
    M.cat = b.dataset.id;
    const c = S.categorias.find(x => x.id === M.cat);
    if (M.tipo === 'gasto' && c && c.ambito && !M.editId) M.ambito = c.ambito;
    renderMovChips();
  });
  $('#mMedios').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.hasAttribute('data-add')) {
      editCatalog('medios', null, item => { M.medio = item.id; renderMovChips(); });
      return;
    }
    M.medio = b.dataset.id; renderMovChips();
  });
  $('#mMonto').addEventListener('input', e => {
    const v = parseMoney(e.target.value);
    const hint = $('#mMontoHint');
    hint.classList.remove('err');
    hint.textContent = e.target.value && v != null ? money(v) : (e.target.value ? 'Revisá el número' : '');
  });
  $('#mMonto').addEventListener('blur', e => {
    const v = parseMoney(e.target.value);
    if (v != null && v > 0) e.target.value = moneyInput(v);
  });

  $('#formMov').addEventListener('submit', async e => {
    e.preventDefault();
    const monto = parseMoney($('#mMonto').value);
    const hint = $('#mMontoHint');
    if (monto == null || monto <= 0) {
      hint.textContent = 'Poné un monto mayor a cero'; hint.classList.add('err');
      $('#mMonto').focus(); return;
    }
    if (!M.cat) {
      hint.textContent = M.tipo === 'ingreso' ? 'Elegí de qué fuente vino' : 'Elegí una categoría'; hint.classList.add('err');
      $('#mCats').scrollIntoView({ block: 'center', behavior: 'smooth' }); return;
    }
    const fecha = $('#mFecha').value || today();
    const desc = $('#mDesc').value.trim();
    const old = M.editId ? S.movs.find(x => x.id === M.editId) : null;
    const mov = Object.assign({}, old || { id: uid(), creado: Date.now() }, {
      tipo: M.tipo, fecha, monto, desc, cat: M.cat, medio: M.medio,
      ambito: M.tipo === 'gasto' ? M.ambito : null,
      fijoId: M.fijoId || null
    });
    if (old) mov.editado = Date.now();

    // Crear fijo si se marcó "se repite"
    if (!old && $('#mRepetir').checked) {
      const fijo = { id: uid(), tipo: M.tipo, cat: M.cat, medio: M.medio, ambito: mov.ambito, desc, monto, dia: +fecha.slice(8, 10), activo: true, desde: fecha.slice(0, 7) };
      S.fijos.push(fijo); await saveKV('fijos');
      mov.fijoId = fijo.id;
    }

    const budgetBefore = mov.tipo === 'gasto' ? budgetsOfMonth(fecha.slice(0, 7)).find(b => b.cat.id === mov.cat) : null;
    await DB.putMov(mov);
    if (old) Object.assign(old, mov); else S.movs.push(mov);
    S.settings.ultimoTipo = M.tipo;
    S.settings.ultimoMedio[M.tipo] = M.medio;
    saveSettings();
    closeDlg($('#sheetMov'));
    render();

    // Aviso de presupuesto
    const after = mov.tipo === 'gasto' ? budgetsOfMonth(fecha.slice(0, 7)).find(b => b.cat.id === mov.cat) : null;
    if (after && after.st.level !== 'ok' && (!budgetBefore || budgetBefore.st.level !== after.st.level)) {
      toast(after.st.level === 'bad'
        ? `⚠ Pasaste el tope de ${after.cat.nombre} (${pct(after.st.r)})`
        : `Ojo: ya usaste el ${pct(after.st.r)} del tope de ${after.cat.nombre}`);
    } else if (old) {
      toast('Cambios guardados');
    } else {
      toast((mov.tipo === 'ingreso' ? 'Ingreso' : 'Gasto') + ' guardado: ' + money(mov.monto), {
        label: 'Deshacer', fn: async () => { await removeMov(mov.id); toast('Listo, lo saqué'); }
      });
    }
  });

  async function removeMov(id) {
    await DB.deleteMov(id);
    S.movs = S.movs.filter(m => m.id !== id);
    render();
  }

  $('#btnDeleteMov').addEventListener('click', async () => {
    const m = S.movs.find(x => x.id === M.editId);
    if (!m) return;
    const ok = await confirmBox('¿Borrar este movimiento?', `${m.tipo === 'ingreso' ? 'Ingreso' : 'Gasto'} de ${money(m.monto)} del ${dmy(m.fecha)}${m.desc ? ' (' + m.desc + ')' : ''}.`);
    if (!ok) return;
    closeDlg($('#sheetMov'));
    const copy = Object.assign({}, m);
    await removeMov(m.id);
    toast('Movimiento borrado', { label: 'Deshacer', fn: async () => { await DB.putMov(copy); S.movs.push(copy); render(); } });
  });

  /* ================= Acciones con data-act ================= */
  document.addEventListener('click', async e => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act, id = el.dataset.id;
    if (act === 'edit-mov') openMov({ mov: S.movs.find(m => m.id === id) });
    else if (act === 'ver-mes') { S.filtros.periodo = 'mes'; S.filtros.mes = S.mesInicio; }
    else if (act === 'fijo-ok') {
      const f = S.fijos.find(x => x.id === id); if (!f) return;
      const mov = { id: uid(), creado: Date.now(), tipo: f.tipo, fecha: fijoDate(f, monthKey()), monto: fijoSugerido(f), desc: f.desc || '', cat: f.cat, medio: f.medio, ambito: f.tipo === 'gasto' ? (f.ambito || 'hogar') : null, fijoId: f.id };
      await DB.putMov(mov); S.movs.push(mov); render();
      toast('Registrado: ' + money(mov.monto), { label: 'Deshacer', fn: () => removeMov(mov.id) });
    }
    else if (act === 'fijo-edit') openMov({ fijo: S.fijos.find(x => x.id === id) });
    else if (act === 'fijo-skip') {
      const mk = monthKey();
      (S.settings.salteados[mk] = S.settings.salteados[mk] || []).push(id);
      await saveSettings(); render();
      toast('Salteado este mes', { label: 'Deshacer', fn: async () => { S.settings.salteados[mk] = S.settings.salteados[mk].filter(x => x !== id); await saveSettings(); render(); } });
    }
    else if (act === 'backup-dl') downloadBackup();
    else if (act === 'backup-share') shareBackup();
  });

  /* ================= AJUSTES ================= */
  let installEvt = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; if (S.view === 'ajustes') renderAjustes(); });
  window.addEventListener('appinstalled', () => { installEvt = null; toast('¡App instalada!'); });

  function catalogList(key) {
    const list = S[key];
    const meta = x => {
      if (key === 'categorias') return [x.ambito === 'emprendimiento' ? 'Emprendimiento' : 'Hogar', x.tope ? 'Tope ' + money(x.tope, { noCents: true }) : ''].filter(Boolean).join(' · ');
      return '';
    };
    return `<ul class="set-list">${list.map(x => `<li class="${x.archivada ? 'archived' : ''}">
      <span class="name">${esc(x.nombre)}${meta(x) ? `<br><span class="meta">${esc(meta(x))}</span>` : ''}${x.archivada ? ' <span class="tag">archivada</span>' : ''}</span>
      <button type="button" class="btn btn--ghost btn--sm" data-cat-edit="${key}" data-id="${x.id}">Editar</button>
    </li>`).join('')}</ul>
    <div class="row-actions"><button type="button" class="btn btn--sm" data-cat-add="${key}">+ Agregar</button></div>`;
  }

  function renderAjustes() {
    const body = $('#ajustesBody');
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    const last = S.settings.ultimaCopia;
    const infMonths = [];
    for (let i = 11; i >= 0; i--) infMonths.push(addMonths(monthKey(), -i));

    body.innerHTML = `
      ${!standalone ? `<div class="card"><div class="card__head"><h3>Instalar en el celular</h3></div>
        ${installEvt ? `<p class="small">Instalala para abrirla como una app, con su ícono y sin internet.</p><div class="row-actions"><button type="button" class="btn btn--primary" id="btnInstall">Instalar app</button></div>`
        : `<p class="small muted">En Chrome: tocá el menú <b>⋮</b> y elegí <b>Instalar app</b> o <b>Agregar a la pantalla principal</b>.</p>`}</div>` : ''}

      <div class="card"><div class="card__head"><h3>Copia de seguridad</h3></div>
        <p class="small">${last ? `Última copia: <b>${dmy(last.slice(0, 10))}</b> (hace ${daysSince(last)} día${daysSince(last) === 1 ? '' : 's'}).` : '<b>Todavía no guardaste ninguna copia.</b>'}
        Tus datos viven sólo en este celular: si se rompe o borrás los datos de Chrome, sin copia se pierden.</p>
        <div class="row-actions">
          <button type="button" class="btn btn--primary" data-act="backup-dl">Guardar copia</button>
          ${canShareFiles() ? '<button type="button" class="btn btn--ghost" data-act="backup-share">Mandar a Drive / WhatsApp</button>' : ''}
          <button type="button" class="btn btn--ghost" id="btnImport">Restaurar una copia</button>
          <button type="button" class="btn btn--ghost" id="btnCsvAll">Exportar todo a Excel</button>
        </div>
        <label class="switch" style="margin-top:12px"><input type="checkbox" id="chkAuto" ${S.settings.autoCopia ? 'checked' : ''}><span class="switch__ui" aria-hidden="true"></span>
          <span>Guardar la copia sola cada 2 semanas (al abrir la app, va a Descargas)</span></label>
      </div>

      <div class="card"><div class="card__head"><h3>Gastos e ingresos fijos</h3></div>
        <p class="small muted">Cada mes te los sugiero en Inicio para confirmar con un toque.</p>
        ${S.fijos.length ? `<ul class="set-list" style="margin-top:6px">${S.fijos.map(f => `<li class="${f.activo === false ? 'archived' : ''}">
          <span class="name">${esc(f.desc || catName(f.tipo, f.cat))}<br><span class="meta">${f.tipo === 'ingreso' ? 'Ingreso' : 'Gasto'} · ${money(f.monto, { noCents: true })} · día ${f.dia || 1}${f.activo === false ? ' · pausado' : ''}</span></span>
          <button type="button" class="btn btn--ghost btn--sm" data-fijo-edit="${f.id}">Editar</button></li>`).join('')}</ul>` : ''}
        <div class="row-actions"><button type="button" class="btn btn--sm" id="btnFijoAdd">+ Agregar fijo</button></div>
      </div>

      <div class="card"><div class="card__head"><h3>Fuentes de ingreso</h3></div>${catalogList('fuentes')}</div>
      <div class="card"><div class="card__head"><h3>Categorías y topes</h3></div>
        <p class="small muted">Poné un tope mensual y te aviso al llegar al 80 %.</p>${catalogList('categorias')}</div>
      <div class="card"><div class="card__head"><h3>Medios de cobro y pago</h3></div>${catalogList('medios')}</div>

      <div class="card"><div class="card__head"><h3>Inflación mensual</h3></div>
        <p class="small muted">Cargá el % de cada mes (por ejemplo, el IPC del INDEC). Sirve para ver en Resumen los montos en pesos de hoy.</p>
        <div class="infl-grid" style="margin-top:10px">${infMonths.map(k => `<label class="field"><span>${esc(monthName(k, { short: true, year: true }))}</span>
          <input inputmode="decimal" data-infl="${k}" value="${S.inflacion[k] != null ? String(S.inflacion[k]).replace('.', ',') : ''}" placeholder="${S.inflacion[k] == null && inflOf(k) ? String(inflOf(k)).replace('.', ',') : '%'}" aria-label="Inflación de ${esc(monthName(k))} en %"></label>`).join('')}</div>
      </div>

      <div class="card"><div class="card__head"><h3>Saldo inicial</h3></div>
        <p class="small muted">La plata que tenías cuando empezaste a usar la app. Se suma al saldo acumulado.</p>
        <label class="field" style="margin-top:8px"><span>Monto</span><input inputmode="decimal" id="inSaldo" value="${S.saldoInicial ? (S.saldoInicial < 0 ? '-' : '') + moneyInput(S.saldoInicial) : ''}" placeholder="0"></label>
      </div>

      <div class="card"><div class="card__head"><h3>Apariencia</h3></div>
        <div class="seg" role="radiogroup" aria-label="Tema" id="segTema">
          <button type="button" role="radio" data-v="auto" aria-checked="${S.settings.tema === 'auto'}">Automático</button>
          <button type="button" role="radio" data-v="light" aria-checked="${S.settings.tema === 'light'}">Claro</button>
          <button type="button" role="radio" data-v="dark" aria-checked="${S.settings.tema === 'dark'}">Oscuro</button>
        </div>
      </div>

      <div class="card"><div class="card__head"><h3>Borrar todo</h3></div>
        <p class="small muted">Elimina todos los movimientos y ajustes de este celular. Guardá una copia antes.</p>
        <div class="row-actions"><button type="button" class="btn btn--danger-ghost" id="btnWipe">Borrar todos los datos</button></div>
      </div>

      <div class="about">
        <span class="mark m-wordmark" aria-hidden="true"></span>
        <p style="margin-top:8px">Cuentas del hogar · tus datos no salen de este celular.<br>${S.movs.length} movimientos guardados.</p>
      </div>`;

    const bi = $('#btnInstall');
    if (bi) bi.onclick = async () => { installEvt.prompt(); await installEvt.userChoice; installEvt = null; renderAjustes(); };
    $('#btnImport').onclick = () => $('#fileImport').click();
    $('#btnCsvAll').onclick = () => exportCSV([...S.movs].sort((a, b) => a.fecha.localeCompare(b.fecha)), 'movimientos');
    $('#chkAuto').onchange = e => { S.settings.autoCopia = e.target.checked; saveSettings(); };
    $('#btnFijoAdd').onclick = () => editFijo(null);
    $$('[data-fijo-edit]').forEach(b => b.onclick = () => editFijo(S.fijos.find(f => f.id === b.dataset.fijoEdit)));
    $$('[data-cat-edit]').forEach(b => b.onclick = () => editCatalog(b.dataset.catEdit, S[b.dataset.catEdit].find(x => x.id === b.dataset.id), () => renderAjustes()));
    $$('[data-cat-add]').forEach(b => b.onclick = () => editCatalog(b.dataset.catAdd, null, () => renderAjustes()));
    $$('[data-infl]').forEach(inp => inp.onchange = () => {
      const v = inp.value.trim().replace(',', '.').replace('%', '');
      if (v === '') delete S.inflacion[inp.dataset.infl];
      else if (isFinite(+v) && +v > -50 && +v < 100) S.inflacion[inp.dataset.infl] = +v;
      else { toast('Ese % no parece válido'); return; }
      saveKV('inflacion'); factorCache.clear(); toast('Inflación guardada');
      renderAjustes();
    });
    $('#inSaldo').onchange = e => {
      const raw = e.target.value.trim();
      const neg = raw.startsWith('-');
      const v = parseMoney(raw.replace(/^-/, ''));
      S.saldoInicial = v == null ? 0 : (neg ? -v : v);
      saveKV('saldoInicial'); toast('Saldo inicial guardado');
      e.target.value = S.saldoInicial ? (neg ? '-' : '') + moneyInput(S.saldoInicial) : '';
    };
    $('#segTema').onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      S.settings.tema = b.dataset.v; applyTheme(); saveSettings(); renderAjustes();
    };
    $('#btnWipe').onclick = async () => {
      if (!await confirmBox('¿Borrar TODOS los datos?', `Se eliminan ${S.movs.length} movimientos, tus fijos, categorías y ajustes de este celular. No se puede deshacer.`, 'Seguir')) return;
      if (!await confirmBox('Última confirmación', '¿Guardaste una copia de seguridad? Si borrás, no hay vuelta atrás.', 'Sí, borrar todo')) return;
      await DB.replaceAll([], []);
      await load(); render();
      toast('Se borraron todos los datos');
    };
  }

  /* ---------- Editor genérico (fuentes, categorías, medios) ---------- */
  const CAT_TXT = {
    fuentes: { uno: 'fuente de ingreso', nueva: 'Nueva fuente', tipo: 'ingreso' },
    categorias: { uno: 'categoría', nueva: 'Nueva categoría', tipo: 'gasto' },
    medios: { uno: 'medio', nueva: 'Nuevo medio' }
  };
  function editCatalog(key, item, done) {
    const T = CAT_TXT[key];
    const d = $('#dlgEdit');
    $('#dlgEditTitle').textContent = item ? 'Editar ' + T.uno : T.nueva;
    const used = item ? S.movs.filter(m => m.cat === item.id || m.medio === item.id).length : 0;
    $('#dlgEditBody').innerHTML = `
      <label class="field" style="margin-top:12px"><span>Nombre</span><input id="eNombre" maxlength="60" value="${item ? esc(item.nombre) : ''}" required autocomplete="off"></label>
      ${key === 'categorias' ? `
        <fieldset class="chips-field"><legend>Por defecto es del…</legend>
          <div class="seg" role="radiogroup" id="eAmbito">
            <button type="button" role="radio" data-v="hogar" aria-checked="${!item || item.ambito !== 'emprendimiento'}">Hogar</button>
            <button type="button" role="radio" data-v="emprendimiento" aria-checked="${!!item && item.ambito === 'emprendimiento'}">Emprendimiento</button>
          </div></fieldset>
        <label class="field" style="margin-top:12px"><span>Tope mensual (presupuesto, opcional)</span><input id="eTope" inputmode="decimal" value="${item && item.tope ? moneyInput(item.tope) : ''}" placeholder="Sin tope"></label>` : ''}
      ${item ? `<label class="check"><input type="checkbox" id="eArch" ${item.archivada ? 'checked' : ''}><span>Archivar (no aparece al cargar, pero se conservan sus ${used} movimientos)</span></label>` : ''}
      <p class="hint" id="eErr"></p>`;
    $('#dlgEditActions').innerHTML = `${item && !used ? '<button type="button" class="btn btn--danger-ghost" id="eDel">Borrar</button>' : ''}<button type="submit" class="btn btn--primary btn--wide">Guardar</button>`;
    const seg = $('#eAmbito');
    if (seg) seg.onclick = e => { const b = e.target.closest('button'); if (b) setSeg(seg, b.dataset.v); };
    const del = $('#eDel');
    if (del) del.onclick = async () => {
      if (!await confirmBox('¿Borrar "' + item.nombre + '"?', 'No tiene movimientos, así que se puede borrar sin problema.')) return;
      S[key] = S[key].filter(x => x.id !== item.id);
      await saveKV(key); closeDlg(d); done && done(null);
    };
    $('#formEdit').onsubmit = async e => {
      e.preventDefault();
      const nombre = $('#eNombre').value.trim();
      if (!nombre) { $('#eErr').textContent = 'Poné un nombre'; $('#eErr').classList.add('err'); return; }
      if (S[key].some(x => x !== item && norm(x.nombre) === norm(nombre))) { $('#eErr').textContent = 'Ya existe una con ese nombre'; $('#eErr').classList.add('err'); return; }
      const obj = item || { id: key.slice(0, 1) + '-' + uid() };
      obj.nombre = nombre;
      if (key === 'categorias') {
        obj.ambito = $('[aria-checked="true"]', seg).dataset.v;
        const t = parseMoney($('#eTope').value);
        obj.tope = t && t > 0 ? t : 0;
      }
      if (item) obj.archivada = $('#eArch').checked;
      if (!item) S[key].push(obj);
      await saveKV(key);
      closeDlg(d);
      done && done(obj);
    };
    openDlg(d);
    setTimeout(() => $('#eNombre').focus(), 60);
  }

  /* ---------- Editor de fijos ---------- */
  function editFijo(f) {
    const d = $('#dlgEdit');
    const st = f ? Object.assign({}, f) : { tipo: 'gasto', cat: '', medio: S.settings.ultimoMedio.gasto || 'm-efectivo', ambito: 'hogar', desc: '', monto: 0, dia: 1, activo: true };
    $('#dlgEditTitle').textContent = f ? 'Editar fijo' : 'Nuevo fijo';
    const opts = (list, sel) => list.filter(x => !x.archivada || x.id === sel).map(x => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${esc(x.nombre)}</option>`).join('');
    const draw = () => {
      $('#dlgEditBody').innerHTML = `
        <div class="seg seg--big" role="radiogroup" id="fjTipo">
          <button type="button" role="radio" data-v="ingreso" aria-checked="${st.tipo === 'ingreso'}">Ingreso</button>
          <button type="button" role="radio" data-v="gasto" aria-checked="${st.tipo === 'gasto'}">Gasto</button>
        </div>
        <label class="field" style="margin-top:12px"><span>Descripción</span><input id="fjDesc" maxlength="80" value="${esc(st.desc)}" placeholder="Ej: Alquiler departamento"></label>
        <div class="grid2">
          <label class="field"><span>Monto aproximado</span><input id="fjMonto" inputmode="decimal" value="${st.monto ? moneyInput(st.monto) : ''}" placeholder="0"></label>
          <label class="field"><span>Día del mes</span><input id="fjDia" type="number" min="1" max="31" inputmode="numeric" value="${st.dia}"></label>
        </div>
        <div class="grid2">
          <label class="field"><span>${st.tipo === 'ingreso' ? 'Fuente' : 'Categoría'}</span><select id="fjCat"><option value="">Elegí…</option>${opts(listFor(st.tipo), st.cat)}</select></label>
          <label class="field"><span>Medio</span><select id="fjMedio">${opts(S.medios, st.medio)}</select></label>
        </div>
        ${st.tipo === 'gasto' ? `<div class="seg" role="radiogroup" id="fjAmbito" style="margin-top:14px">
          <button type="button" role="radio" data-v="hogar" aria-checked="${st.ambito !== 'emprendimiento'}">Hogar</button>
          <button type="button" role="radio" data-v="emprendimiento" aria-checked="${st.ambito === 'emprendimiento'}">Emprendimiento</button></div>` : ''}
        ${f ? `<label class="check"><input type="checkbox" id="fjActivo" ${st.activo !== false ? 'checked' : ''}><span>Activo (desmarcalo para pausarlo)</span></label>` : ''}
        <p class="hint" id="fjErr"></p>`;
      const grab = () => {
        st.desc = $('#fjDesc').value; st.monto = parseMoney($('#fjMonto').value) || 0; st.dia = +$('#fjDia').value || 1;
        st.cat = $('#fjCat').value; st.medio = $('#fjMedio').value;
      };
      $('#fjTipo').onclick = e => { const b = e.target.closest('button'); if (!b || b.dataset.v === st.tipo) return; grab(); st.tipo = b.dataset.v; st.cat = ''; draw(); };
      const a = $('#fjAmbito');
      if (a) a.onclick = e => { const b = e.target.closest('button'); if (b) { st.ambito = b.dataset.v; setSeg(a, st.ambito); } };
      $('#fjCat').onchange = e => { const c = S.categorias.find(x => x.id === e.target.value); if (st.tipo === 'gasto' && c && c.ambito && a) { st.ambito = c.ambito; setSeg(a, st.ambito); } };
      d._grab = grab;
    };
    draw();
    $('#dlgEditActions').innerHTML = `${f ? '<button type="button" class="btn btn--danger-ghost" id="fjDel">Borrar</button>' : ''}<button type="submit" class="btn btn--primary btn--wide">Guardar</button>`;
    const del = $('#fjDel');
    if (del) del.onclick = async () => {
      if (!await confirmBox('¿Borrar este fijo?', 'Dejo de sugerirlo cada mes. Los movimientos que ya registraste no se borran.')) return;
      S.fijos = S.fijos.filter(x => x.id !== f.id); await saveKV('fijos'); closeDlg(d); render();
    };
    $('#formEdit').onsubmit = async e => {
      e.preventDefault();
      d._grab();
      const err = $('#fjErr');
      err.classList.add('err');
      if (!st.monto || st.monto <= 0) { err.textContent = 'Poné un monto'; return; }
      if (!st.cat) { err.textContent = 'Elegí ' + (st.tipo === 'ingreso' ? 'la fuente' : 'la categoría'); return; }
      st.dia = Math.max(1, Math.min(31, st.dia));
      if (st.tipo !== 'gasto') st.ambito = null;
      if (f) { st.activo = $('#fjActivo').checked; Object.assign(f, st); }
      else S.fijos.push(Object.assign(st, { id: uid(), desde: monthKey() }));
      await saveKV('fijos'); closeDlg(d); render();
      toast('Fijo guardado');
    };
    openDlg(d);
  }

  /* ================= COPIAS Y EXPORTACIÓN ================= */
  async function backupBlob() {
    const kv = await DB.allKV();
    const data = { app: 'cuentas-lqdemp', version: 1, exportado: new Date().toISOString(), movs: S.movs, kv };
    return new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  }
  const backupName = () => 'cuentas-copia-' + today() + '.json';
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  async function markBackup() {
    S.settings.ultimaCopia = new Date().toISOString();
    await saveSettings();
    render();
  }
  async function downloadBackup(auto) {
    download(await backupBlob(), backupName());
    await markBackup();
    toast(auto ? 'Guardé tu copia quincenal en Descargas' : 'Copia guardada en Descargas');
  }
  function canShareFiles() {
    try { return !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.json', { type: 'application/json' })] })); } catch (e) { return false; }
  }
  async function shareBackup() {
    const file = new File([await backupBlob()], backupName(), { type: 'application/json' });
    try {
      await navigator.share({ files: [file], title: 'Copia de Cuentas del hogar' });
      await markBackup();
      toast('Copia compartida');
    } catch (e) {
      if (e.name !== 'AbortError') downloadBackup();
    }
  }

  $('#fileImport').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let data;
    try { data = JSON.parse(await file.text()); } catch (err) { toast('Ese archivo no es una copia válida'); return; }
    if (!data || data.app !== 'cuentas-lqdemp' || !Array.isArray(data.movs) || !Array.isArray(data.kv)) {
      toast('Ese archivo no es una copia de esta app'); return;
    }
    const fecha = data.exportado ? dmy(data.exportado.slice(0, 10)) : '¿?';
    const ok = await confirmBox('¿Restaurar esta copia?',
      `La copia es del ${fecha} y tiene ${data.movs.length} movimiento${data.movs.length === 1 ? '' : 's'}. Reemplaza lo que hay ahora en el celular (${S.movs.length} movimientos).`, 'Sí, restaurar', false);
    if (!ok) return;
    const movs = data.movs.filter(m => m && m.id && m.fecha && typeof m.monto === 'number' && (m.tipo === 'ingreso' || m.tipo === 'gasto'));
    const kv = data.kv.filter(r => r && typeof r.key === 'string');
    await DB.replaceAll(movs, kv);
    await load();
    render();
    toast('Copia restaurada: ' + movs.length + ' movimiento' + (movs.length === 1 ? '' : 's'));
  });

  function exportCSV(list, base) {
    if (!list.length) { toast('No hay movimientos para exportar'); return; }
    const q = v => {
      const s = String(v == null ? '' : v);
      return /[;"\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const num = c => (c < 0 ? '-' : '') + Math.floor(Math.abs(c) / 100) + ',' + String(Math.abs(c) % 100).padStart(2, '0');
    const head = ['Fecha', 'Tipo', 'Monto', 'Monto con signo', 'Fuente o categoría', 'Descripción', 'Medio', 'Hogar / emprendimiento', 'Fijo'];
    const rows = list.map(m => [
      dmy(m.fecha), m.tipo === 'ingreso' ? 'Ingreso' : 'Gasto', num(m.monto), num(signed(m)),
      catName(m.tipo, m.cat), m.desc || '', medioName(m.medio),
      m.tipo === 'gasto' ? (m.ambito === 'emprendimiento' ? 'Emprendimiento' : 'Hogar') : '', m.fijoId ? 'Sí' : ''
    ]);
    const csv = String.fromCharCode(0xFEFF) + [head, ...rows].map(r => r.map(q).join(';')).join('\r\n');
    download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), base + '-' + today() + '.csv');
    toast('Archivo para Excel descargado');
  }

  /* ================= ARRANQUE ================= */
  async function load() {
    const [movs, fuentes, categorias, medios, fijos, inflacion, saldoInicial, settings] = await Promise.all([
      DB.allMovs(), DB.get('fuentes'), DB.get('categorias'), DB.get('medios'), DB.get('fijos'),
      DB.get('inflacion'), DB.get('saldoInicial'), DB.get('settings')
    ]);
    S.movs = movs || [];
    S.fuentes = fuentes || DEF_FUENTES.map(x => Object.assign({}, x));
    S.categorias = categorias || DEF_CATEGORIAS.map(x => Object.assign({}, x));
    S.medios = medios || DEF_MEDIOS.map(x => Object.assign({}, x));
    S.fijos = fijos || [];
    S.inflacion = inflacion || {};
    S.saldoInicial = saldoInicial || 0;
    S.settings = Object.assign({ tema: 'auto', autoCopia: true, ultimaCopia: null, primerUso: null, salteados: {}, ultimoTipo: 'gasto', ultimoMedio: {} }, settings || {});
    if (!fuentes) await saveKV('fuentes');
    if (!categorias) await saveKV('categorias');
    if (!medios) await saveKV('medios');
    if (!S.settings.primerUso) { S.settings.primerUso = today(); await saveSettings(); }
    applyTheme();
  }

  async function init() {
    await load();
    DB.persist();
    go(location.hash.slice(1) || 'inicio');
    // Atajo del ícono instalado: "Cargar movimiento"
    if (new URLSearchParams(location.search).has('nuevo')) {
      history.replaceState(null, '', location.pathname + location.hash);
      openMov();
    }
    // Copia automática cada 2 semanas
    if (S.settings.autoCopia && backupDue()) {
      setTimeout(() => downloadBackup(true).catch(() => {}), 1200);
    }
    // Service worker: sólo funciona alojado (http/https), no abriendo el archivo
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW:', err));
    }
  }
  init();
})();
