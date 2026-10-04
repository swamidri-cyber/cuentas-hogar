/* Movimiento y gestos: transiciones entre pantallas, deslizar con el dedo,
   números que cuentan, indicadores que se deslizan. Respeta "reducir movimiento". */
(function () {
  'use strict';
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const $ = (s, r) => (r || document).querySelector(s);

  /* ---------- Entrada de pantallas y contenido ---------- */
  function play(el, cls) {
    if (!el || reduced()) return;
    el.classList.remove(cls);
    void el.offsetWidth; // reinicia la animación
    el.classList.add(cls);
    el.addEventListener('animationend', function off(e) {
      if (e.target !== el) return;
      el.classList.remove(cls);
      el.removeEventListener('animationend', off);
    });
  }
  /** dir: 1 = viene de la derecha, -1 = de la izquierda, 0 = aparece */
  function enter(el, dir) {
    play(el, dir > 0 ? 'in-right' : dir < 0 ? 'in-left' : 'in-fade');
  }
  /** Los hijos aparecen uno detrás del otro */
  function stagger(el) {
    if (!el || reduced()) return;
    [...el.children].forEach((c, i) => {
      c.style.setProperty('--i', Math.min(i, 8));
      c.classList.remove('rise'); void c.offsetWidth; c.classList.add('rise');
      c.addEventListener('animationend', function off(e) {
        if (e.target !== c) return;
        c.classList.remove('rise');
        c.removeEventListener('animationend', off);
      });
    });
  }

  /* ---------- Números que cuentan hasta su valor ---------- */
  const shown = new Map();
  function counters(root) {
    root.querySelectorAll('[data-count]').forEach(el => {
      const to = +el.dataset.count, key = el.dataset.key;
      const from = shown.has(key) ? shown.get(key) : 0;
      shown.set(key, to);
      if (reduced() || from === to) return;
      const t0 = performance.now(), dur = 700;
      const fmt = el.dataset.fmt === 'short' ? v => F.money(v, { noCents: true }) : v => F.money(v);
      const tick = now => {
        const p = Math.min(1, (now - t0) / dur);
        const e = 1 - Math.pow(1 - p, 4);
        el.textContent = fmt(Math.round(from + (to - from) * e));
        if (p < 1 && el.isConnected) requestAnimationFrame(tick);
      };
      el.textContent = fmt(from);
      requestAnimationFrame(tick);
    });
  }

  /* ---------- Controles segmentados: la "pastilla" se desliza ---------- */
  function updateSegs() {
    document.querySelectorAll('.seg').forEach(seg => {
      const btns = [...seg.querySelectorAll(':scope > button')];
      const i = btns.findIndex(b => b.getAttribute('aria-checked') === 'true');
      seg.style.setProperty('--n', btns.length);
      seg.style.setProperty('--idx', Math.max(0, i));
      seg.dataset.on = i >= 0 ? btns[i].dataset.v : '';
      seg.classList.toggle('seg--none', i < 0);
      if (!seg.classList.contains('seg--ready')) setTimeout(() => seg.classList.add('seg--ready'), 50);
    });
  }
  let segQueued = false;
  const segObserver = new MutationObserver(() => {
    if (segQueued) return;
    segQueued = true;
    queueMicrotask(() => { segQueued = false; updateSegs(); });
  });

  /* ---------- Gestos ---------- */
  function init(opts) {
    updateSegs();
    segObserver.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-checked'] });

    // Botón "+" se esconde al bajar y vuelve al subir
    const fab = $('#fab'), top = $('.top');
    let lastY = scrollY;
    addEventListener('scroll', () => {
      const y = scrollY;
      if (y > lastY + 6 && y > 140) fab.classList.add('fab--hide');
      else if (y < lastY - 6 || y < 140) fab.classList.remove('fab--hide');
      top.classList.toggle('top--scrolled', y > 4);
      lastY = y;
    }, { passive: true });

    const main = $('#main');
    let g = null;              // gesto en curso
    let suppressClick = false; // evita el "toque" al terminar de arrastrar

    main.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' || g) return;
      if (e.target.closest('input, select, textarea, .chart, .no-swipe')) return;
      g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), dx: 0, mode: null, row: e.target.closest('.mov-wrap') };
    });

    main.addEventListener('pointermove', e => {
      if (!g || e.pointerId !== g.id) return;
      const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
      g.dx = dx;
      if (!g.mode) {
        if (Math.hypot(dx, dy) < 10) return;
        if (Math.abs(dx) < Math.abs(dy) * 1.2) { g = null; return; }
        g.mode = g.row && dx < 0 ? 'row' : 'tab';
        if (g.mode === 'row') g.btn = g.row.querySelector('.mov');
        main.classList.add('dragging');
      }
      if (g.mode === 'tab') {
        const edge = !opts.canSwipe(dx < 0 ? 1 : -1);
        const f = edge ? 0.12 : 0.35;
        main.style.transform = `translateX(${dx * f}px)`;
        main.style.opacity = String(1 - Math.min(0.35, Math.abs(dx) / 900));
      } else {
        const w = g.row.offsetWidth;
        const x = Math.max(-w * 0.7, Math.min(0, dx));
        g.btn.style.transform = `translateX(${x}px)`;
        g.row.style.setProperty('--reveal', Math.min(1, -x / (w * 0.3)));
        g.row.classList.toggle('mov-wrap--armed', -x > w * 0.3);
      }
    });

    const end = e => {
      if (!g || e.pointerId !== g.id) return;
      const cur = g; g = null;
      main.classList.remove('dragging');
      if (!cur.mode) return;
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 60);
      const dt = performance.now() - cur.t0;
      const v = Math.abs(cur.dx) / dt;
      const cancelled = e.type === 'pointercancel';

      if (cur.mode === 'tab') {
        const dir = cur.dx < 0 ? 1 : -1;
        main.style.transition = 'transform .32s var(--ease-out), opacity .32s var(--ease-out)';
        main.style.transform = ''; main.style.opacity = '';
        setTimeout(() => { main.style.transition = ''; }, 340);
        if (!cancelled && (Math.abs(cur.dx) > 80 || v > 0.5) && opts.canSwipe(dir)) {
          main.style.transition = '';
          opts.onSwipeTab(dir);
        }
      } else {
        const w = cur.row.offsetWidth;
        const snapBack = () => {
          cur.btn.style.transition = 'transform .38s var(--ease-spring)';
          cur.btn.style.transform = '';
          cur.row.style.setProperty('--reveal', 0);
          cur.row.classList.remove('mov-wrap--armed');
          setTimeout(() => { cur.btn.style.transition = ''; }, 400);
        };
        if (!cancelled && (-cur.dx > w * 0.3 || (v > 0.6 && cur.dx < -40))) {
          cur.btn.style.transition = 'transform .25s var(--ease-out)';
          cur.btn.style.transform = `translateX(${-w * 0.35}px)`;
          cur.row.style.setProperty('--reveal', 1);
          opts.onRowDelete(cur.btn.dataset.id, cur.row).then(deleted => { if (!deleted) snapBack(); });
        } else snapBack();
      }
    };
    main.addEventListener('pointerup', end);
    main.addEventListener('pointercancel', end);
    document.addEventListener('click', e => {
      if (suppressClick) { e.stopPropagation(); e.preventDefault(); suppressClick = false; }
    }, true);

    // Hojas: arrastrar hacia abajo para cerrar
    document.querySelectorAll('dialog.sheet').forEach(d => {
      const handle = d.querySelector('.sheet__head');
      let s = null;
      handle.addEventListener('pointerdown', e => {
        if (e.target.closest('button')) return;
        s = { id: e.pointerId, y0: e.clientY, t0: performance.now(), dy: 0 };
        handle.setPointerCapture(e.pointerId);
        d.style.transition = 'none';
      });
      handle.addEventListener('pointermove', e => {
        if (!s || e.pointerId !== s.id) return;
        s.dy = e.clientY - s.y0;
        const y = s.dy > 0 ? s.dy : s.dy * 0.15;
        d.style.transform = `translateY(${y}px)`;
      });
      const up = e => {
        if (!s || e.pointerId !== s.id) return;
        const cur = s; s = null;
        const v = cur.dy / (performance.now() - cur.t0);
        if (cur.dy > 110 || (v > 0.6 && cur.dy > 30)) {
          d.style.transition = '';
          opts.onSheetClose(d);
        } else {
          d.style.transition = 'transform .38s var(--ease-spring)';
          d.style.transform = '';
          setTimeout(() => { d.style.transition = ''; }, 400);
        }
      };
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  /** Cierra un diálogo con animación y después llama a close() */
  function closeAnimated(d) {
    if (!d.open || d.classList.contains('closing')) return;
    if (reduced()) { d.style.transform = ''; d.close(); return; }
    d.classList.add('closing');
    let done = false;
    const fin = () => {
      if (done) return;
      done = true;
      d.classList.remove('closing');
      d.style.transform = '';
      d.close();
    };
    d.addEventListener('animationend', function off(e) {
      if (e.target !== d) return;
      d.removeEventListener('animationend', off);
      fin();
    });
    setTimeout(fin, 420);
  }

  /** Fila que se va hacia la izquierda y se pliega */
  function collapseOut(el) {
    return new Promise(res => {
      if (reduced()) { res(); return; }
      const h = el.offsetHeight;
      el.style.height = h + 'px';
      el.style.overflow = 'hidden';
      void el.offsetHeight; // fija la altura inicial antes de animar
      el.style.transition = 'height .28s var(--ease-out), opacity .2s, margin .28s var(--ease-out)';
      el.style.height = '0px'; el.style.opacity = '0'; el.style.marginTop = '0px';
      setTimeout(res, 290);
    });
  }

  window.Motion = { init, enter, stagger, counters, updateSegs, closeAnimated, collapseOut, reduced };
})();
