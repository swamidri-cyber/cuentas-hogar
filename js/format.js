/* Formatos argentinos: montos, fechas y meses.
   Los montos se guardan en CENTAVOS (enteros) para evitar errores de redondeo. */
(function () {
  'use strict';

  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
    'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

  function miles(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  /** 123456789 centavos -> "$ 1.234.567,89" */
  function money(cents, opts) {
    opts = opts || {};
    const c = Math.round(cents || 0);
    const neg = c < 0;
    const abs = Math.abs(c);
    const ent = Math.floor(abs / 100);
    const dec = String(abs % 100).padStart(2, '0');
    let s = '$ ' + miles(ent) + (opts.noCents ? '' : ',' + dec);
    if (neg) s = '−' + s;
    else if (opts.sign && c > 0) s = '+' + s;
    return s;
  }

  /** Versión corta para ejes: $ 1,2 M, $ 850 mil */
  function moneyShort(cents) {
    const v = Math.round(cents / 100);
    const a = Math.abs(v);
    const sg = v < 0 ? '−' : '';
    if (a >= 1e6) return sg + '$ ' + (a / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace('.', ',') + ' M';
    if (a >= 1e3) return sg + '$ ' + Math.round(a / 1e3) + ' mil';
    return sg + '$ ' + a;
  }

  /** Interpreta lo que se tipea: "1.234,56", "1234,5", "1234.56", "1.500" -> centavos (o null) */
  function parseMoney(str) {
    if (str == null) return null;
    let s = String(str).trim().replace(/[$\s ]/g, '');
    if (!s) return null;
    if (!/^-?[\d.,]+$/.test(s)) return null;
    const hasComma = s.includes(',');
    if (hasComma) {
      // coma decimal, puntos de miles
      s = s.replace(/\./g, '');
      const parts = s.split(',');
      if (parts.length > 2) return null;
      s = parts[0] + '.' + (parts[1] || '0');
    } else {
      const dots = s.split('.');
      if (dots.length > 2) {
        s = dots.join(''); // 1.234.567 -> miles
      } else if (dots.length === 2) {
        // "1.500" -> mil quinientos ; "1500.5" o "12.75" -> decimal
        s = dots[1].length === 3 ? dots.join('') : dots[0] + '.' + dots[1];
      }
    }
    const n = Number(s);
    if (!isFinite(n)) return null;
    return Math.round(n * 100);
  }

  /** Centavos -> texto para editar en un input: 123450 -> "1.234,50" */
  function moneyInput(cents) {
    if (cents == null) return '';
    const abs = Math.abs(Math.round(cents));
    const ent = Math.floor(abs / 100);
    const dec = abs % 100;
    return miles(ent) + (dec ? ',' + String(dec).padStart(2, '0') : '');
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  /** Fecha local -> "AAAA-MM-DD" (sin problemas de huso horario) */
  function isoDate(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function today() { return isoDate(new Date()); }
  function monthKey(iso) { return (iso || today()).slice(0, 7); }

  function parseISO(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d || 1);
  }

  /** "2026-10" + n meses */
  function addMonths(mk, n) {
    let [y, m] = mk.split('-').map(Number);
    m += n;
    y += Math.floor((m - 1) / 12);
    m = ((m - 1) % 12 + 12) % 12 + 1;
    return y + '-' + pad(m);
  }
  function monthsBetween(a, b) {
    const [ya, ma] = a.split('-').map(Number);
    const [yb, mb] = b.split('-').map(Number);
    return (yb - ya) * 12 + (mb - ma);
  }
  function lastDay(mk) {
    const [y, m] = mk.split('-').map(Number);
    return new Date(y, m, 0).getDate();
  }

  function monthName(mk, opts) {
    const [y, m] = mk.split('-').map(Number);
    if (opts && opts.short) return MESES_CORTOS[m - 1] + (opts.year ? ' ' + String(y).slice(2) : '');
    return MESES[m - 1] + ' ' + y;
  }

  /** "2026-10-02" -> "02/10/2026" */
  function dmy(iso) {
    const [y, m, d] = iso.split('-');
    return d + '/' + m + '/' + y;
  }

  /** Encabezado de día: "Hoy", "Ayer" o "jueves 2 de octubre" */
  function dayLabel(iso) {
    const t = today();
    if (iso === t) return 'Hoy';
    const ay = new Date(); ay.setDate(ay.getDate() - 1);
    if (iso === isoDate(ay)) return 'Ayer';
    const d = parseISO(iso);
    const s = DIAS[d.getDay()] + ' ' + d.getDate() + ' de ' + MESES[d.getMonth()];
    return d.getFullYear() !== new Date().getFullYear() ? s + ' ' + d.getFullYear() : s;
  }

  function pct(x, digits) {
    if (!isFinite(x)) return '—';
    return (x * 100).toFixed(digits == null ? 0 : digits).replace('.', ',') + ' %';
  }

  function daysSince(iso) {
    if (!iso) return Infinity;
    const a = parseISO(iso.slice(0, 10));
    const b = parseISO(today());
    return Math.round((b - a) / 86400000);
  }

  /** Para búsquedas sin acentos ni mayúsculas */
  function norm(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  window.F = {
    money, moneyShort, parseMoney, moneyInput, isoDate, today, monthKey, parseISO,
    addMonths, monthsBetween, lastDay, monthName, dmy, dayLabel, pct, daysSince, norm, esc, pad,
    MESES
  };
})();
