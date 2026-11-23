// Datumshilfen und Auswertung. Gerechnet wird nur mit lokalen 'YYYY-MM-DD'-Strings, nie mit UTC.
const pad = n => String(n).padStart(2, '0');

export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayStr = () => ymd(new Date());
export function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
export function addDays(s, n) {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}
export const weekday = s => parseYmd(s).getDay();                    // 0 = So
export const weekStart = s => addDays(s, -((weekday(s) + 6) % 7));  // Montag

export const doneWorkouts = ws => ws.filter(w => !w.deleted && w.data?.status === 'done')
  .sort((a, b) => a.workout_date.localeCompare(b.workout_date) || String(a.data.finished_at).localeCompare(String(b.data.finished_at)));

const total = ex => ex.sets.filter(s => s.done).reduce((a, s) => a + (Number(s.value) || 0), 0);

// ---------- Training ----------
export function trainingStats(workouts, settings, today = todayStr()) {
  const done = doneWorkouts(workouts);
  const target = Math.max(1, settings.days.length);
  const perWeek = new Map();
  for (const w of done) perWeek.set(weekStart(w.workout_date), (perWeek.get(weekStart(w.workout_date)) || 0) + 1);
  const thisWeek = weekStart(today);
  const month = today.slice(0, 7);

  // Planerfüllung der letzten 4 Wochen: nur geplante Tage bis heute zählen (heute erst, wenn trainiert),
  // und keine Tage vor dem ersten Training.
  const trainedToday = done.some(w => w.workout_date === today);
  let from = addDays(thisWeek, -21);
  if (done.length && done[0].workout_date > from) from = done[0].workout_date;
  let expected = 0;
  if (done.length) for (let d = from; d <= today; d = addDays(d, 1)) {
    if (settings.days.includes(weekday(d)) && (d < today || trainedToday)) expected++;
  }
  const inWindow = done.filter(w => w.workout_date >= from && w.workout_date <= today).length;
  const fulfilment = expected ? Math.round(Math.min(inWindow, expected) / expected * 100) : null;

  // Serie in Wochen: Wochen in Folge mit erfülltem Plan. Die laufende Woche zählt erst, wenn sie erfüllt ist.
  let streak = (perWeek.get(thisWeek) || 0) >= target ? 1 : 0;
  for (let wk = addDays(thisWeek, -7); (perWeek.get(wk) || 0) >= target; wk = addDays(wk, -7)) streak++;

  return {
    total: done.length,
    week: perWeek.get(thisWeek) || 0,
    month: done.filter(w => w.workout_date.startsWith(month)).length,
    target, fulfilment, streak,
    levelUps: levelUps(done),
  };
}

// Stufenaufstiege: jedes Mal, wenn eine Leiter mit höherer Stufe ausgeführt wurde als zuvor.
export function levelUps(done) {
  const best = {};
  let n = 0;
  for (const w of done) for (const ex of w.data.exercises || []) {
    if (!ex.sets.some(s => s.done)) continue;
    if (ex.ladder in best && ex.step > best[ex.ladder]) n++;
    best[ex.ladder] = Math.max(best[ex.ladder] ?? -1, ex.step);
  }
  return n;
}

// Verlauf einer Leiter: Summe pro Einheit (alle Sätze) und Stufe.
export function ladderSeries(workouts, ladder) {
  const out = [];
  for (const w of doneWorkouts(workouts)) for (const ex of w.data.exercises || []) {
    if (ex.ladder === ladder && ex.sets.some(s => s.done)) {
      const sets = ex.sets.filter(s => s.done).map(s => Number(s.value) || 0);
      out.push({ date: w.workout_date, total: total(ex), best: Math.max(...sets), sets, step: ex.step, name: ex.name, unit: ex.unit });
    }
  }
  return out;
}

// Wöchentliches Volumen: Wiederholungen (und gehaltene Sekunden) pro Woche.
export function weeklyVolume(workouts, weeks = 12, today = todayStr()) {
  const start = addDays(weekStart(today), -7 * (weeks - 1));
  const rows = Array.from({ length: weeks }, (_, i) => ({ week: addDays(start, 7 * i), reps: 0, secs: 0, sessions: 0 }));
  for (const w of doneWorkouts(workouts)) {
    const i = Math.round((parseYmd(weekStart(w.workout_date)) - parseYmd(start)) / (7 * 86400000));
    if (i < 0 || i >= weeks) continue;
    rows[i].sessions++;
    for (const ex of w.data.exercises || []) rows[i][ex.unit === 'sec' ? 'secs' : 'reps'] += total(ex);
  }
  return rows;
}

// ---------- Körper ----------
export function weightSeries(body, days = 120, today = todayStr()) {
  const from = addDays(today, -days + 1);
  const byDate = new Map();
  for (const b of body) if (!b.deleted && b.weight_kg != null && b.entry_date >= from && b.entry_date <= today) {
    const prev = byDate.get(b.entry_date);
    if (!prev || String(b.updated_at) > String(prev.updated_at)) byDate.set(b.entry_date, b);
  }
  const pts = [...byDate.values()].sort((a, b) => a.entry_date.localeCompare(b.entry_date))
    .map(b => ({ date: b.entry_date, v: Number(b.weight_kg) }));
  // Gleitender Durchschnitt über die letzten 7 Kalendertage (nur vorhandene Messungen).
  for (const p of pts) {
    const lo = addDays(p.date, -6);
    const win = pts.filter(q => q.date >= lo && q.date <= p.date);
    p.avg = win.reduce((a, q) => a + q.v, 0) / win.length;
  }
  return { from, to: today, pts };
}

// ---------- Gewohnheiten ----------
export function habitStats(habits, logs, today = todayStr()) {
  const active = habits.filter(h => !h.deleted && !h.archived);
  const ids = new Set(active.map(h => h.id));
  const doneOn = new Map(); // Datum → Anzahl erledigter aktiver Gewohnheiten
  const perHabit = new Map(active.map(h => [h.id, 0]));
  let from30 = addDays(today, -29);
  const firstLog = logs.filter(l => !l.deleted && l.done && ids.has(l.habit_id)).map(l => l.log_date).sort()[0];
  if (firstLog && firstLog > from30) from30 = firstLog;
  for (const l of logs) {
    if (l.deleted || !l.done || !ids.has(l.habit_id)) continue;
    doneOn.set(l.log_date, (doneOn.get(l.log_date) || 0) + 1);
    if (l.log_date >= from30 && l.log_date <= today) perHabit.set(l.habit_id, perHabit.get(l.habit_id) + 1);
  }
  const n = active.length;
  const level = d => {
    const c = doneOn.get(d) || 0;
    if (!n || !c) return 0;
    if (c >= n) return 3;
    return c / n >= 0.5 ? 2 : 1;
  };
  // Heatmap: 12 Wochen, Spalten = Wochen (Mo–So)
  const start = addDays(weekStart(today), -7 * 11);
  const heat = Array.from({ length: 84 }, (_, i) => {
    const d = addDays(start, i);
    return { date: d, level: level(d), count: doneOn.get(d) || 0, future: d > today };
  });
  // Serie: Tage in Folge, an denen alle Gewohnheiten erledigt wurden (heute zählt, sobald erfüllt).
  let cur = level(today) === 3 ? today : addDays(today, -1), streak = 0;
  while (n && level(cur) === 3) { streak++; cur = addDays(cur, -1); }
  let sum30 = 0;
  for (const v of perHabit.values()) sum30 += v;
  // Zeitraum: höchstens 30 Tage, frühestens ab dem ersten Häkchen; heute zählt erst mit einem Häkchen.
  let days30 = 0;
  for (let d = from30; d <= today; d = addDays(d, 1)) if (d < today || doneOn.has(today)) days30++;
  return {
    n, heat, streak, days30,
    rate30: n && firstLog && days30 ? Math.min(100, Math.round(sum30 / (n * days30) * 100)) : null,
    perHabit: active.map(h => ({ ...h, days30: perHabit.get(h.id) })),
  };
}
