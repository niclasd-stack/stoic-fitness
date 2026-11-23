// Handgebaute SVG-Diagramme. Breite = tatsächliche Breite des Containers, damit Schrift nicht mitskaliert.
// Hover/Tippen: Elemente mit data-tip zeigen einen Tooltip; data-cx bewegt das Fadenkreuz (siehe app.js).
import { parseYmd } from './stats.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dayNum = s => Math.round(parseYmd(s).getTime() / 86400000);
const short = s => parseYmd(s).toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' });
const fmt = (v, d = 0) => Number(v).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });

// „Schöne“ Achsenwerte
function ticks(min, max, count = 4) {
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw);
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const out = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(+v.toFixed(6));
  return out;
}

// Linie über die Zeit. series: [{ date, y, tip }]; opts: { from, to, width, height, dots, avg: [{date,y}], markers: [{date,label,tip}], decimals, label }
export function lineChart(series, opts) {
  const W = Math.max(280, opts.width || 320), H = opts.height || 200;
  const L = 36, R = 12, T = opts.markers?.length ? 22 : 10, B = 24;
  const x0 = dayNum(opts.from), x1 = Math.max(dayNum(opts.to), x0 + 1);
  const vals = [...series.map(p => p.y), ...(opts.avg || []).map(p => p.y)];
  let min = Math.min(...vals), max = Math.max(...vals);
  if (opts.zero) min = 0;
  const pad = (max - min) * 0.08 || 1;
  const yt = ticks(opts.zero ? 0 : min - pad, max + pad);
  const ymin = yt[0], ymax = yt[yt.length - 1];
  const x = d => L + (dayNum(d) - x0) / (x1 - x0) * (W - L - R);
  const y = v => T + (ymax - v) / (ymax - ymin) * (H - T - B);
  const d = opts.decimals ?? 0;

  const grid = yt.map(v => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>
    <text x="${L - 6}" y="${y(v) + 3.5}" text-anchor="end">${fmt(v, Number.isInteger(v) ? 0 : 1)}</text>`).join('');
  const path = pts => pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.date).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ');
  const markers = (opts.markers || []).map(m => `<g class="marker" data-tip="${esc(m.tip)}">
      <line x1="${x(m.date)}" x2="${x(m.date)}" y1="${T - 4}" y2="${H - B}"/>
      <text x="${x(m.date)}" y="${T - 8}" text-anchor="middle">${esc(m.label)}</text></g>`).join('');
  const main = opts.avg
    ? `<path class="line" d="${path(opts.avg)}"/>`
    : `<path class="line" d="${path(series)}"/>`;
  const dots = series.map(p => `<circle class="${opts.avg ? 'pt-soft' : 'pt'}" cx="${x(p.date).toFixed(1)}" cy="${y(p.y).toFixed(1)}" r="${opts.avg ? 3 : 4}"/>`).join('');

  // Trefferflächen: je Messpunkt ein Streifen bis zur Mitte zum Nachbarn.
  const xs = series.map(p => x(p.date));
  const hits = series.map((p, i) => {
    const a = i ? (xs[i - 1] + xs[i]) / 2 : L, b = i < xs.length - 1 ? (xs[i] + xs[i + 1]) / 2 : W - R;
    return `<rect class="hit" x="${a.toFixed(1)}" y="${T}" width="${Math.max(1, b - a).toFixed(1)}" height="${H - T - B}" data-cx="${xs[i].toFixed(1)}" data-cy="${y(p.y).toFixed(1)}" data-tip="${esc(p.tip)}"/>`;
  }).join('');

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(opts.label || '')}">
    ${grid}${markers}${opts.avg ? dots + main : main + dots}
    <line class="xhair" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>
    <circle class="xdot" r="5" cx="0" cy="0" visibility="hidden"/>
    <text x="${L}" y="${H - 6}">${short(opts.from)}</text>
    <text x="${W - R}" y="${H - 6}" text-anchor="end">${opts.toLabel || short(opts.to)}</text>
    ${hits}</svg>`;
}

// Säulen pro Woche. rows: [{ label, value, tip }]
export function barChart(rows, opts) {
  const W = Math.max(280, opts.width || 320), H = opts.height || 190;
  const L = 36, R = 8, T = 10, B = 24;
  const yt = ticks(0, Math.max(1, ...rows.map(r => r.value)));
  const ymax = yt[yt.length - 1];
  const slot = (W - L - R) / rows.length, gap = 2;
  const bw = Math.min(28, slot - gap);
  const y = v => T + (ymax - v) / ymax * (H - T - B);
  const base = y(0);
  const grid = yt.map(v => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/>
    <text x="${L - 6}" y="${y(v) + 3.5}" text-anchor="end">${fmt(v)}</text>`).join('');
  const bars = rows.map((r, i) => {
    const cx = L + slot * i + slot / 2, x = cx - bw / 2, top = y(r.value), h = base - top;
    const rad = Math.min(4, h, bw / 2);
    const shape = h <= 0 ? '' : `<path class="${r.current ? 'bar-cur' : 'bar'}" d="M${x},${base} V${top + rad} Q${x},${top} ${x + rad},${top} H${x + bw - rad} Q${x + bw},${top} ${x + bw},${top + rad} V${base} Z"/>`;
    const lbl = (i % Math.ceil(rows.length / 6) === 0 || i === rows.length - 1) ? `<text x="${cx}" y="${H - 6}" text-anchor="middle">${esc(r.label)}</text>` : '';
    return `${shape}${lbl}<rect class="hit" x="${L + slot * i}" y="${T}" width="${slot}" height="${H - T - B}" data-tip="${esc(r.tip)}"/>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(opts.label || '')}">
    ${grid}<line class="axis" x1="${L}" x2="${W - R}" y1="${base}" y2="${base}"/>${bars}</svg>`;
}

// Heatmap (HTML-Raster): cells: [{ date, level 0–3, future, tip }]
export function heatmap(cells) {
  return `<div class="heat">${cells.map(c =>
    `<span data-l="${c.level}" class="${c.future ? 'future' : ''}" ${c.future ? '' : `data-tip="${esc(c.tip)}"`}></span>`).join('')}</div>`;
}
