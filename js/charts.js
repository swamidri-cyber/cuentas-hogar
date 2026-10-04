/* Gráficos en SVG hechos a mano (sin librerías).
   Cada marca lleva data-tip con HTML seguro; un único manejador muestra el tooltip. */
(function () {
  'use strict';
  const { money, moneyShort, esc, monthName } = window.F;

  const SERIES = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)'];

  /** Arco de anillo entre ángulos a0 y a1 (radianes, 0 = arriba) */
  function arc(cx, cy, r0, r1, a0, a1) {
    const p = (r, a) => [cx + r * Math.sin(a), cy - r * Math.cos(a)];
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const [x0, y0] = p(r1, a0), [x1, y1] = p(r1, a1);
    const [x2, y2] = p(r0, a1), [x3, y3] = p(r0, a0);
    return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r1} ${r1} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}` +
      `L${x2.toFixed(2)} ${y2.toFixed(2)}A${r0} ${r0} 0 ${large} 0 ${x3.toFixed(2)} ${y3.toFixed(2)}Z`;
  }

  /** Torta (anillo). items: [{label, value(centavos), color}] */
  function donut(items, center) {
    const total = items.reduce((a, b) => a + b.value, 0);
    const size = 150, c = size / 2, r1 = 72, r0 = 46;
    let a = 0;
    const segs = items.filter(i => i.value > 0).map(i => {
      const frac = i.value / total;
      const a0 = a, a1 = a + frac * Math.PI * 2;
      a = a1;
      const tip = `<b>${esc(i.label)}</b><br>${money(i.value)} · ${(frac * 100).toFixed(1).replace('.', ',')} %`;
      if (frac >= 0.9999) {
        return `<g data-tip="${esc(tip)}"><circle cx="${c}" cy="${c}" r="${(r0 + r1) / 2}" fill="none" stroke="${i.color}" stroke-width="${r1 - r0}"/></g>`;
      }
      return `<path d="${arc(c, c, r0, r1, a0, a1)}" fill="${i.color}" stroke="var(--card)" stroke-width="2" stroke-linejoin="round" data-tip="${esc(tip)}"/>`;
    }).join('');
    return `<div class="chart"><svg viewBox="0 0 ${size} ${size}" role="img" aria-label="${esc(center.aria || '')}">
      ${segs}
      <text x="${c}" y="${c - 4}" text-anchor="middle" style="font-size:10px;letter-spacing:.1em">${esc(center.label)}</text>
      <text x="${c}" y="${c + 14}" text-anchor="middle" class="donut-center" style="font-size:15px;fill:var(--ink)">${esc(center.value)}</text>
    </svg><div class="tip" hidden></div></div>`;
  }

  /** Escala "linda" para el eje Y */
  function niceMax(v) {
    if (v <= 0) return 100;
    const exp = Math.pow(10, Math.floor(Math.log10(v)));
    const f = v / exp;
    const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return nf * exp;
  }

  /** Barras agrupadas ingresos vs gastos por mes. rows: [{mk, ing, gas}] */
  function monthBars(rows, opts) {
    opts = opts || {};
    const W = 340, H = 210, padL = 46, padR = 4, padT = 10, padB = 26;
    const iw = W - padL - padR, ih = H - padT - padB;
    const max = niceMax(Math.max(1, ...rows.map(r => Math.max(r.ing, r.gas))));
    const y = v => padT + ih - (v / max) * ih;
    const step = iw / rows.length;
    const bw = Math.max(4, Math.min(12, (step - 6) / 2));
    const ticks = [0, 0.5, 1].map(t => t * max);

    const grid = ticks.map(t => `<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(t)}" y2="${y(t)}"/>` +
      `<text x="${padL - 6}" y="${y(t) + 4}" text-anchor="end">${esc(moneyShort(t))}</text>`).join('');

    // Barra con extremo superior redondeado (4px) anclada a la base
    const bar = (x, v, color) => {
      if (v <= 0) return '';
      const top = y(v), h = padT + ih - top, r = Math.min(4, h, bw / 2);
      return `<path d="M${x} ${padT + ih}V${top + r}Q${x} ${top} ${x + r} ${top}H${x + bw - r}Q${x + bw} ${top} ${x + bw} ${top + r}V${padT + ih}Z" fill="${color}"/>`;
    };

    const bars = rows.map((r, i) => {
      const cx = padL + step * i + step / 2;
      const x1 = cx - bw - 1, x2 = cx + 1;
      const bal = r.ing - r.gas;
      const tip = `<b>${esc(monthName(r.mk))}</b><br>Ingresos: ${money(r.ing)}<br>Gastos: ${money(r.gas)}<br>Balance: ${money(bal, { sign: true })}`;
      const lbl = monthName(r.mk, { short: true });
      const showLbl = rows.length <= 6 || i % 2 === (rows.length - 1) % 2;
      return `<g data-tip="${esc(tip)}" data-i="${i}">
        <rect class="hit" x="${padL + step * i}" y="${padT}" width="${step}" height="${ih + padB}"/>
        ${bar(x1, r.ing, 'var(--c-ing)')}${bar(x2, r.gas, 'var(--c-gas)')}
        ${showLbl ? `<text x="${cx}" y="${H - 8}" text-anchor="middle"${r.mk === opts.current ? ' style="fill:var(--ink);font-weight:700"' : ''}>${esc(lbl)}</text>` : ''}
      </g>`;
    }).join('');

    return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.aria || 'Ingresos y gastos por mes')}">
      ${grid}<line class="axis" x1="${padL}" x2="${W - padR}" y1="${padT + ih}" y2="${padT + ih}"/>
      ${bars}
    </svg><div class="tip" hidden></div></div>
    <div class="legend"><span><i style="background:var(--c-ing)"></i>Ingresos</span><span><i style="background:var(--c-gas)"></i>Gastos</span></div>`;
  }

  /** Tooltips: tocar/pasar el dedo o el mouse sobre una marca */
  function bindTips(root) {
    root.querySelectorAll('.chart').forEach(ch => {
      const tip = ch.querySelector('.tip');
      if (!tip) return;
      let active = null;
      const show = (el, ev) => {
        const rect = ch.getBoundingClientRect();
        const er = el.getBoundingClientRect();
        tip.innerHTML = el.getAttribute('data-tip');
        tip.hidden = false;
        let x = (ev && ev.clientX != null ? ev.clientX : er.left + er.width / 2) - rect.left;
        const y = er.top - rect.top;
        const tw = tip.offsetWidth;
        x = Math.max(tw / 2, Math.min(rect.width - tw / 2, x));
        tip.style.left = x + 'px';
        tip.style.top = Math.max(y, tip.offsetHeight + 14) + 'px';
        ch.querySelectorAll('[data-tip]').forEach(o => o.classList.toggle('is-dim', o !== el));
        active = el;
      };
      const hide = () => {
        tip.hidden = true; active = null;
        ch.querySelectorAll('.is-dim').forEach(o => o.classList.remove('is-dim'));
      };
      let lastType = 'touch';
      ch.addEventListener('pointerdown', e => { lastType = e.pointerType; });
      ch.addEventListener('pointermove', e => {
        if (e.pointerType !== 'mouse') return;
        const el = e.target.closest('[data-tip]');
        if (el) show(el, e); else hide();
      });
      ch.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') hide(); });
      ch.addEventListener('click', e => {
        if (lastType === 'mouse') return;
        const el = e.target.closest('[data-tip]');
        if (!el || el === active) hide(); else show(el, e);
      });
    });
  }

  window.Charts = { donut, monthBars, bindTips, SERIES };
})();
