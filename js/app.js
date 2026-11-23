import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import * as db from './db.js';
import * as auth from './auth.js';
import { Sync } from './sync.js';
import { quoteForDate } from './quotes.js';
import { LADDERS, DEFAULT_SETTINGS, buildWorkout, nextDayKey, suggest, stepName, unitLabel } from './plan.js';
import {
  todayStr, addDays, parseYmd, weekday, weekStart, doneWorkouts,
  trainingStats, ladderSeries, weeklyVolume, weightSeries, habitStats,
} from './stats.js';
import { lineChart, barChart, heatmap } from './charts.js';

// Lokaler Modus: ohne Supabase-Werte – oder zum Ausprobieren auf localhost mit ?lokal.
const DEV_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname) && new URLSearchParams(location.search).has('lokal');
const LOCAL_MODE = !SUPABASE_URL || !SUPABASE_ANON_KEY || DEV_LOCAL;
if (DEV_LOCAL) db.useName('stoic-fitness-dev');

const DEFAULT_HABITS = [
  ['h-training', 'Training oder Bewegung'],
  ['h-steps', '10.000 Schritte'],
  ['h-cold', 'Kalte Dusche'],
  ['h-stretch', 'Dehnen (10 Minuten)'],
  ['h-sleep', '7 Stunden Schlaf'],
  ['h-sugar', 'Kein Zucker'],
];
const WEEKDAYS = [[1, 'Mo'], [2, 'Di'], [3, 'Mi'], [4, 'Do'], [5, 'Fr'], [6, 'Sa'], [0, 'So']];
const PART = { yes: 'Ja', partly: 'Teilweise', no: 'Nein' };
const PART_BADGE = { yes: 'erfüllt', partly: 'teils', no: 'nicht erfüllt' };

const $view = document.getElementById('view');
const $tabs = document.getElementById('tabs');
const $sync = document.getElementById('sync-status');
const $rest = document.getElementById('rest');
const $tip = document.getElementById('tip');

const state = {
  client: null, user: null, sync: null, status: '',
  settings: structuredClone(DEFAULT_SETTINGS),
  reflect: false, justDone: null, hold: null, rest: null, wakeLock: null,
  statLadder: null, weightDays: 90, editHist: null, openHist: new Set(),
};

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
const fmtLong = s => parseYmd(s).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtShort = s => parseYmd(s).toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric' });
const fmtNum = (v, d = 0) => Number(v).toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmtSec = s => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
const minutes = d => d?.started_at && d?.finished_at ? Math.max(1, Math.round((Date.parse(d.finished_at) - Date.parse(d.started_at)) / 60000)) : null;
const route0 = () => location.hash.slice(1) || 'heute';

// ---------- Daten ----------
function mergeSettings(d) {
  return { ...DEFAULT_SETTINGS, ...(d || {}), level: { ...DEFAULT_SETTINGS.level, ...(d?.level || {}) } };
}
async function loadAll() {
  const [workouts, body, habits, logs, settings] = await Promise.all([
    db.all('fit_workouts'), db.live('fit_body'), db.live('fit_habits'), db.live('fit_habit_log'), db.get('fit_settings', 'settings'),
  ]);
  state.settings = mergeSettings(settings?.data);
  habits.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name));
  return { workouts: workouts.filter(w => !w.deleted), body, habits: habits.filter(h => !h.archived), logs };
}
async function saveSettings(patch) {
  state.settings = mergeSettings({ ...state.settings, ...patch });
  await db.save('fit_settings', { id: 'settings', data: state.settings, deleted: false });
}
const activeWorkout = ws => ws.filter(w => w.data?.status === 'active').sort((a, b) => String(b.data.started_at).localeCompare(String(a.data.started_at)))[0] || null;

// Standard-Gewohnheiten einmalig anlegen – im Sync-Modus erst nach dem ersten erfolgreichen Abgleich,
// damit ein neues Gerät nichts überschreibt, was auf einem anderen schon geändert oder gelöscht wurde.
async function ensureDefaults() {
  if (await db.getMeta('seeded')) return false;
  const existing = new Set((await db.all('fit_habits')).map(h => h.id));
  let i = 0;
  for (const [id, name] of DEFAULT_HABITS) {
    if (!existing.has(id)) await db.save('fit_habits', { id, name, sort: i, archived: false, deleted: false });
    i++;
  }
  await db.setMeta('seeded', true);
  return true;
}

window.addEventListener('local-change', () => state.sync?.schedule());

// ---------- Sync-Status ----------
const STATUS_TEXT = {
  synced: 'Synchronisiert', pending: 'Ausstehend', syncing: 'Synchronisiere …',
  offline: 'Offline', error: 'Sync-Fehler', local: 'Nur lokal',
};
function setStatus(s) {
  state.status = s;
  $sync.dataset.state = s;
  $sync.textContent = STATUS_TEXT[s] || '';
}
$sync.addEventListener('click', () => state.sync?.run());

window.addEventListener('db-blocked', () => {
  $view.innerHTML = `<div class="auth"><h1>Update</h1><p class="sub">Die App ist noch an anderer Stelle geöffnet. Bitte alle anderen Fenster der App schließen – danach geht es hier automatisch weiter.</p></div>`;
});

// ---------- Start ----------
async function boot() {
  registerServiceWorker();
  if (LOCAL_MODE) {
    setStatus('local');
    await ensureDefaults();
    return startApp();
  }
  state.client = auth.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  if (!state.client) {
    const lastUser = await db.getMeta('userId');
    if (lastUser) { state.user = { id: lastUser, email: await db.getMeta('email') }; setStatus('offline'); return startApp(); }
    $view.innerHTML = `<div class="auth"><h1>Askesis</h1><p class="sub">Für den ersten Start wird eine Internetverbindung gebraucht.</p></div>`;
    return;
  }
  state.client.auth.onAuthStateChange(event => {
    if (event === 'SIGNED_OUT') { state.user = null; renderLogin(); }
  });
  let user = null;
  try { user = await auth.currentUser(state.client); } catch { /* offline */ }
  if (!user && !navigator.onLine) {
    const lastUser = await db.getMeta('userId');
    if (lastUser) user = { id: lastUser, email: await db.getMeta('email') };
  }
  if (user) await onSignedIn(user);
  else renderLogin();
}

async function onSignedIn(user) {
  const previous = await db.getMeta('userId');
  if (previous && previous !== user.id) await db.clearAll(); // anderes Konto → lokale Daten verwerfen
  await db.setMeta('userId', user.id);
  if (user.email) await db.setMeta('email', user.email);
  state.user = user;
  state.sync = new Sync(state.client, user.id, {
    onStatus: setStatus,
    onRemoteChange: async (changed, ok) => {
      if (ok && await ensureDefaults()) changed.add('fit_habits');
      const typing = ['TEXTAREA', 'INPUT', 'SELECT'].includes(document.activeElement?.tagName);
      if (!changed.size || typing || state.hold) return;
      const r = route0();
      if (r === 'training' && !changed.has('fit_workouts') && !changed.has('fit_settings')) return;
      route();
    },
  });
  startApp();
  state.sync.run();
  window.addEventListener('online', () => state.sync.run());
  window.addEventListener('offline', () => setStatus('offline'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') state.sync.run();
  });
}

function startApp() {
  $tabs.hidden = false;
  window.addEventListener('hashchange', route);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (route0() === 'heute' && state.renderedDate !== todayStr()) renderToday();
    if (state.wantWake) requestWake();
  });
  let t;
  window.addEventListener('resize', () => {
    clearTimeout(t);
    t = setTimeout(() => { if (route0() === 'auswertung') renderStats(); }, 200);
  });
  if (!location.hash) history.replaceState(null, '', location.pathname + location.search + '#heute');
  route();
}

function route() {
  hideTip();
  const r = route0();
  for (const a of $tabs.querySelectorAll('a')) {
    if (a.dataset.tab === r) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  $view.classList.toggle('wide', r === 'auswertung');
  $view.onclick = $view.oninput = $view.onchange = null;
  if (r !== 'training') { state.reflect = false; setWake(false); }
  const views = { heute: renderToday, training: renderTraining, auswertung: renderStats, verlauf: renderHistory, mehr: renderMore };
  (views[r] || renderToday)();
}

// ---------- Login ----------
function renderLogin() {
  $tabs.hidden = true;
  $sync.textContent = '';
  $view.innerHTML = `
    <div class="auth">
      <h1>Askesis</h1>
      <p class="sub">Übung für Körper und Charakter.</p>
      <form id="login" novalidate>
        <input type="email" name="email" placeholder="E-Mail" autocomplete="email" required>
        <input type="password" name="password" placeholder="Passwort (mind. 6 Zeichen)" autocomplete="current-password" required minlength="6">
        <p class="msg" id="msg"></p>
        <div class="btn-row">
          <button class="btn" type="submit" data-action="in">Anmelden</button>
          <button class="btn ghost" type="submit" data-action="up">Konto erstellen</button>
        </div>
        <p class="note">Dasselbe Konto wie im Stoischen Journal.</p>
      </form>
    </div>`;
  const form = document.getElementById('login');
  const msg = document.getElementById('msg');
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    const action = ev.submitter?.dataset.action || 'in';
    const email = form.email.value.trim();
    const password = form.password.value;
    if (!email || password.length < 6) { msg.className = 'msg err'; msg.textContent = 'Bitte E-Mail und ein Passwort mit mindestens 6 Zeichen eingeben.'; return; }
    for (const b of form.querySelectorAll('button')) b.disabled = true;
    msg.className = 'msg'; msg.textContent = 'Einen Moment …';
    try {
      if (action === 'up') {
        const { user, session } = await auth.signUp(state.client, email, password);
        if (!session) { msg.className = 'msg ok'; msg.textContent = 'Fast geschafft: Bestätige deine E-Mail über den Link im Postfach und melde dich dann an.'; return; }
        await onSignedIn(user);
      } else {
        await onSignedIn(await auth.signIn(state.client, email, password));
      }
    } catch (err) {
      msg.className = 'msg err'; msg.textContent = auth.translateError(err);
    } finally {
      for (const b of form.querySelectorAll('button')) b.disabled = false;
    }
  });
}

// ---------- Bausteine ----------
const targetsText = (sets, unit) => {
  const v = sets.map(s => s.value ?? s);
  const u = unitLabel(unit);
  return v.every(x => x === v[0]) ? `${v.length} × ${v[0]} ${u}` : `${v.join(' · ')} ${u}`;
};
function nextTrainingDate(from) {
  for (let i = 1; i <= 7; i++) {
    const d = addDays(from, i);
    if (state.settings.days.includes(weekday(d))) return d;
  }
  return null;
}
function quoteHtml(date) {
  const q = quoteForDate(date);
  return `<figure class="quote"><blockquote>„${esc(q.text)}“</blockquote><figcaption>${esc(q.author)} · ${esc(q.source)}</figcaption></figure>`;
}

// Karte „Training heute“ (auch auf der Training-Seite, wenn nichts läuft).
function heroHtml(data, today) {
  const { workouts } = data;
  const active = activeWorkout(workouts);
  const t = trainingStats(workouts, state.settings, today);
  const weekLine = `Woche ${t.week}/${t.target}`;
  if (active) {
    const d = active.data, all = d.exercises.flatMap(e => e.sets), done = all.filter(s => s.done).length;
    return `<section class="hero"><span class="day-letter">${active.day_key}</span>
      <span class="kicker">Läuft · ${weekLine}</span><h2>Ganzkörper ${active.day_key}</h2>
      <div class="progress-line"><div class="bar"><i style="width:${Math.round(done / all.length * 100)}%"></i></div>${done}/${all.length} Sätze</div>
      <div style="margin-top:14px"><a class="btn block" href="#training" style="display:block;text-align:center;text-decoration:none;line-height:24px">Fortsetzen</a></div></section>`;
  }
  const doneToday = doneWorkouts(workouts).filter(w => w.workout_date === today).pop();
  if (doneToday) {
    const d = doneToday.data, reps = d.exercises.filter(e => e.unit === 'reps').flatMap(e => e.sets).filter(s => s.done).reduce((a, s) => a + s.value, 0);
    return `<section class="hero"><span class="day-letter">${doneToday.day_key}</span>
      <span class="kicker">Vollbracht · ${weekLine}</span><h2>Ganzkörper ${doneToday.day_key}</h2>
      <p class="note">${minutes(d) ? `${minutes(d)} ${minutes(d) === 1 ? 'Minute' : 'Minuten'} · ` : ''}${reps} Wiederholungen. Was getan ist, kann dir niemand mehr nehmen.</p>
      <a class="link" href="#verlauf">Im Verlauf ansehen</a></section>`;
  }
  const key = nextDayKey(workouts);
  const isDay = state.settings.days.includes(weekday(today));
  const preview = buildWorkout(key, state.settings, workouts);
  const list = `<ul class="ex-list">${preview.map(e => `<li><span>${esc(e.name)}${e.ready ? ' <span class="up" title="Bereit für die nächste Stufe">↑</span>' : ''}</span><span>${targetsText(e.sets, e.unit)}${e.perSide ? ' je Seite' : ''}</span></li>`).join('')}</ul>`;
  if (isDay) {
    return `<section class="hero"><span class="day-letter">${key}</span>
      <span class="kicker">Heute · ${weekLine}</span><h2>Ganzkörper ${key}</h2>${list}
      <button class="btn block" data-act="start" data-day="${key}">Training beginnen</button></section>`;
  }
  const next = nextTrainingDate(today);
  return `<section class="hero"><span class="day-letter">${key}</span>
    <span class="kicker">Ruhetag · ${weekLine}</span><h2>Auch Ruhe ist Übung</h2>
    <p class="note">Der Körper wächst in der Pause. Halte heute deine Gewohnheiten.${next ? ` Nächstes Training: ${fmtShort(next)}, Tag ${key}.` : ''}</p>
    <details class="table-toggle"><summary>Tag ${key} ansehen</summary>${list}</details>
    <button class="btn ghost block" data-act="start" data-day="${key}" style="margin-top:12px">Trotzdem trainieren</button></section>`;
}

async function startWorkout(dayKey) {
  const { workouts } = await loadAll();
  if (activeWorkout(workouts)) { location.hash = '#training'; return; }
  const w = {
    id: db.uuid(), workout_date: todayStr(), day_key: dayKey, deleted: false,
    data: { status: 'active', started_at: new Date().toISOString(), intention: '', intention_done: false, exercises: buildWorkout(dayKey, state.settings, workouts) },
  };
  await db.save('fit_workouts', w);
  state.justDone = null;
  if (location.hash === '#training') renderTraining(); else location.hash = '#training';
}

// ---------- Heute ----------
async function renderToday() {
  const today = todayStr();
  state.renderedDate = today;
  const data = await loadAll();
  const done = new Set(data.logs.filter(l => l.log_date === today && l.done).map(l => l.habit_id));
  const nDone = data.habits.filter(h => done.has(h.id)).length;
  const lastWeight = data.body.filter(b => b.weight_kg != null).sort((a, b) => b.entry_date.localeCompare(a.entry_date))[0];
  const todayWeight = lastWeight?.entry_date === today ? lastWeight : null;

  $view.innerHTML = `
    <span class="kicker">${esc(fmtLong(today))}</span>
    <h1>Heute</h1>
    ${quoteHtml(today)}
    ${heroHtml(data, today)}
    <section class="panel">
      <div class="panel-head"><div><h2>Gewohnheiten</h2><p class="sub">${nDone} von ${data.habits.length} gehalten</p></div><a class="link" href="#mehr">Bearbeiten</a></div>
      ${data.habits.length ? `<ul class="habits">${data.habits.map(h => `<li><button class="habit" data-act="habit" data-id="${esc(h.id)}" aria-pressed="${done.has(h.id)}"><span class="check">${CHECK}</span><span class="habit-name">${esc(h.name)}</span></button></li>`).join('')}</ul>`
        : '<p class="empty">Noch keine Gewohnheiten. Lege unter „Mehr“ welche an.</p>'}
    </section>
    <section class="panel">
      <h2>Körpergewicht</h2>
      <p class="sub">${lastWeight ? `Zuletzt ${fmtNum(lastWeight.weight_kg, 1)} kg am ${fmtShort(lastWeight.entry_date)}` : 'Noch kein Eintrag.'}</p>
      <form class="inline" id="weight-form" style="margin-top:10px">
        <input type="number" name="w" inputmode="decimal" step="0.1" min="20" max="300" placeholder="kg" value="${todayWeight ? todayWeight.weight_kg : ''}" aria-label="Gewicht heute in kg">
        <button class="btn" type="submit">${todayWeight ? 'Ändern' : 'Eintragen'}</button>
      </form>
      <p class="msg" id="weight-msg"></p>
    </section>`;

  $view.onclick = async ev => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    if (b.dataset.act === 'start') startWorkout(b.dataset.day);
    if (b.dataset.act === 'habit') {
      await toggleHabit(b.dataset.id, today);
      renderToday();
    }
  };
  document.getElementById('weight-form').onsubmit = async ev => {
    ev.preventDefault();
    const v = parseFloat(String(ev.target.w.value).replace(',', '.'));
    const msg = document.getElementById('weight-msg');
    if (!(v >= 20 && v <= 300)) { msg.className = 'msg err'; msg.textContent = 'Bitte ein Gewicht zwischen 20 und 300 kg eingeben.'; return; }
    await db.save('fit_body', { ...(todayWeight || { id: db.uuid(), entry_date: today, body_fat: null, waist_cm: null, note: null, deleted: false }), weight_kg: Math.round(v * 10) / 10 });
    renderToday();
  };
}

async function toggleHabit(habitId, date) {
  const id = `${habitId}|${date}`;
  const cur = await db.get('fit_habit_log', id);
  const on = !(cur && cur.done && !cur.deleted);
  await db.save('fit_habit_log', { id, habit_id: habitId, log_date: date, done: on, deleted: false });
}

// ---------- Training ----------
let saveTimer = null, curWorkout = null;
function queueSave(w, delay = 400) {
  curWorkout = w;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, delay);
}
async function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (curWorkout) { const w = curWorkout; curWorkout = null; await db.save('fit_workouts', w); }
}
window.addEventListener('pagehide', flushSave);

async function renderTraining() {
  await flushSave();
  const data = await loadAll();
  const w = activeWorkout(data.workouts);
  if (!w) {
    setWake(false);
    if (state.justDone) return renderCompletion(data);
    $view.innerHTML = `<span class="kicker">${esc(fmtLong(todayStr()))}</span><h1>Training</h1>
      <p class="sub" style="margin-bottom:14px">Ganzkörper mit dem eigenen Körpergewicht, Tag A und B im Wechsel.</p>
      ${heroHtml(data, todayStr())}
      <p class="note">Fortschritt entsteht über die Wiederholungen: Schaffst du in allen Sätzen den oberen Rand des Zielbereichs, schlägt dir die App die nächste Stufe vor.</p>`;
    $view.onclick = ev => { const b = ev.target.closest('[data-act="start"]'); if (b) startWorkout(b.dataset.day); };
    return;
  }
  setWake(true);
  drawTraining(w, data.workouts);
}

function drawTraining(w, workouts) {
  const d = w.data, exs = d.exercises;
  const all = exs.flatMap(e => e.sets), done = all.filter(s => s.done).length;
  const started = new Date(d.started_at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

  const setRow = (ex, i, s, j) => {
    const running = state.hold && state.hold.e === i && state.hold.s === j;
    const u = unitLabel(ex.unit);
    return `<div class="set ${s.done ? 'is-done' : ''}">
      <span class="set-label">Satz ${j + 1}</span>
      <div><div class="stepper">
        <button type="button" data-act="inc" data-e="${i}" data-s="${j}" data-d="-1" aria-label="weniger">−</button>
        <span class="val num" id="val-${i}-${j}">${s.value}<small>${u}${ex.perSide ? ' je Seite' : ''}</small></span>
        <button type="button" data-act="inc" data-e="${i}" data-s="${j}" data-d="1" aria-label="mehr">+</button>
      </div>${ex.unit === 'sec' ? `<button type="button" class="timer-btn ${running ? 'running' : ''}" data-act="hold" data-e="${i}" data-s="${j}">${running ? 'Stopp' : 'Stoppuhr starten'}</button>` : ''}</div>
      <button type="button" class="set-done" data-act="toggle" data-e="${i}" data-s="${j}" aria-pressed="${s.done}" aria-label="Satz ${j + 1} erledigt">${CHECK}</button>
    </div>`;
  };
  const exCard = (ex, i) => {
    const L = LADDERS[ex.ladder], n = L.steps.length;
    const complete = ex.sets.every(s => s.done);
    return `<article class="ex ${complete ? 'complete' : ''}">
      <div class="ex-head"><div>
        <span class="kicker">${i + 1}/${exs.length} · ${esc(L.name)} · Stufe ${ex.step + 1}/${n}</span>
        <h3>${esc(ex.name)}</h3>
        <div class="ex-meta">Ziel ${ex.sets.length} × ${ex.range[0]}–${ex.range[1]} ${unitLabel(ex.unit)}${ex.perSide ? ' je Seite' : ''}${ex.last ? ` · zuletzt ${ex.last.join(' · ')}` : ''}</div>
      </div></div>
      <div class="ex-step">
        <button type="button" class="link" data-act="step" data-e="${i}" data-d="-1" ${ex.step <= 0 ? 'disabled' : ''}>‹ leichter</button>
        <button type="button" class="link" data-act="step" data-e="${i}" data-d="1" ${ex.step >= n - 1 ? 'disabled' : ''}>schwerer ›</button>
      </div>
      ${ex.ready && ex.step < n - 1 ? `<div class="ready"><span>Alle Sätze oben im Zielbereich. Bereit für <b>${esc(L.steps[ex.step + 1])}</b>?</span>
        <button type="button" class="btn ghost" data-act="step" data-e="${i}" data-d="1" style="min-height:38px;padding:6px 14px">Aufsteigen</button></div>` : ''}
      <div class="sets">${ex.sets.map((s, j) => setRow(ex, i, s, j)).join('')}</div>
    </article>`;
  };

  const intention = !d.intention_done ? `
    <section class="panel">
      <span class="kicker">Praemeditatio</span>
      <h2>Bevor du beginnst</h2>
      <p class="note">Stell dir vor, was schwer wird: die letzte Wiederholung, die Unlust, die Ausrede. Wie willst du antworten?</p>
      <textarea data-in="intention" placeholder="z. B. Beim letzten Satz nicht verhandeln.">${esc(d.intention)}</textarea>
      <div class="btn-row" style="margin-top:12px"><button class="btn" data-act="begin">Beginnen</button></div>
    </section>
    <ul class="ex-list panel" style="padding:6px 18px">${exs.map(e => `<li><span>${esc(e.name)}</span><span>${targetsText(e.sets, e.unit)}</span></li>`).join('')}</ul>` : '';

  const finish = state.reflect ? `
    <section class="panel" id="reflect">
      <span class="kicker">Prüfung</span>
      <h2>Habe ich getan, was in meiner Macht stand?</h2>
      <div class="chips even" style="margin-top:12px">${Object.entries(PART).map(([k, v]) => `<button type="button" class="chip" data-act="part" data-v="${k}" aria-pressed="${d.reflection?.part === k}">${v}</button>`).join('')}</div>
      <div class="field"><span class="label">Anstrengung <span class="hint">1 = leicht · 5 = an der Grenze</span></span>
        <div class="chips even">${[1, 2, 3, 4, 5].map(v => `<button type="button" class="chip" data-act="effort" data-v="${v}" aria-pressed="${d.reflection?.effort === v}">${v}</button>`).join('')}</div></div>
      <div class="field"><label for="r-note">Was nehme ich mit?</label><textarea id="r-note" data-in="note">${esc(d.reflection?.note || '')}</textarea></div>
      <div class="btn-row" style="margin-top:14px"><button type="button" class="btn quiet" data-act="back">Zurück</button><button type="button" class="btn" data-act="complete">Abschließen</button></div>
    </section>` : `
    <div class="btn-row" style="margin-top:6px"><button type="button" class="btn block" data-act="finish">Training abschließen</button></div>
    <p style="text-align:center;margin-top:14px"><button type="button" class="link danger" data-act="discard">Training verwerfen</button></p>`;

  $view.innerHTML = `
    <div class="progress-top">
      <span class="kicker">Tag ${w.day_key} · seit ${started} Uhr</span>
      <div class="progress-line" style="margin-top:4px"><div class="bar"><i style="width:${Math.round(done / all.length * 100)}%"></i></div>${done}/${all.length} Sätze</div>
    </div>
    ${d.intention_done && d.intention ? `<p class="note" style="font-style:italic;margin:0 0 12px">Vorsatz: ${esc(d.intention)}</p>` : ''}
    ${intention || exs.map(exCard).join('') + finish}`;

  const ex = el => exs[+el.dataset.e];
  $view.onclick = async ev => {
    const b = ev.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    if (act === 'begin') {
      d.intention = $view.querySelector('[data-in="intention"]').value.trim();
      d.intention_done = true;
      await db.save('fit_workouts', w);
      window.scrollTo(0, 0);
    } else if (act === 'inc') {
      const e = ex(b), s = e.sets[+b.dataset.s];
      if (state.hold?.e === +b.dataset.e && state.hold?.s === +b.dataset.s) stopHold(false);
      s.value = Math.max(0, s.value + (+b.dataset.d) * (e.unit === 'sec' ? 5 : 1));
      queueSave(w);
    } else if (act === 'toggle') {
      const i = +b.dataset.e, j = +b.dataset.s, s = exs[i].sets[j];
      if (state.hold?.e === i && state.hold?.s === j) stopHold(false);
      s.done = !s.done;
      if (s.done && all.some(x => !x.done)) startRest(state.settings.rest);
      queueSave(w);
    } else if (act === 'hold') {
      const i = +b.dataset.e, j = +b.dataset.s;
      if (state.hold?.e === i && state.hold?.s === j) {
        const secs = stopHold(true);
        exs[i].sets[j].value = secs;
        exs[i].sets[j].done = true;
        if (all.some(x => !x.done)) startRest(state.settings.rest);
        queueSave(w, 0);
      } else {
        if (state.hold) stopHold(false);
        startHold(i, j);
      }
    } else if (act === 'step') {
      const e = ex(b), n = LADDERS[e.ladder].steps.length;
      const step = Math.max(0, Math.min(n - 1, e.step + (+b.dataset.d)));
      if (step === e.step) return;
      e.step = step;
      e.name = stepName(e.ladder, step);
      const sg = suggest(workouts, e.ladder, step, e.sets.length);
      e.sets = sg.targets.map(v => ({ value: v, done: false }));
      e.last = sg.last; e.ready = sg.ready;
      await saveSettings({ level: { ...state.settings.level, [e.ladder]: step } });
      queueSave(w, 0);
    } else if (act === 'finish') {
      if (all.some(x => !x.done) && !confirm('Noch nicht alle Sätze sind abgehakt. Trotzdem abschließen?')) return;
      state.reflect = true;
    } else if (act === 'back') {
      state.reflect = false;
    } else if (act === 'part') {
      d.reflection = { ...(d.reflection || {}), part: b.dataset.v };
      queueSave(w);
    } else if (act === 'effort') {
      d.reflection = { ...(d.reflection || {}), effort: +b.dataset.v };
      queueSave(w);
    } else if (act === 'complete') {
      d.reflection = { ...(d.reflection || {}), note: $view.querySelector('[data-in="note"]')?.value.trim() || '' };
      d.status = 'done';
      d.finished_at = new Date().toISOString();
      if (state.hold) stopHold(false);
      stopRest();
      clearTimeout(saveTimer); curWorkout = null;
      await db.save('fit_workouts', w);
      // Gewohnheit „Training oder Bewegung“ automatisch abhaken.
      const h = await db.get('fit_habits', 'h-training');
      const log = await db.get('fit_habit_log', `h-training|${w.workout_date}`);
      if (h && !h.deleted && !(log?.done && !log.deleted)) await toggleHabit('h-training', w.workout_date);
      state.reflect = false;
      state.justDone = w.id;
      window.scrollTo(0, 0);
      return renderTraining();
    } else if (act === 'discard') {
      if (!confirm('Dieses Training verwerfen? Die eingetragenen Sätze gehen verloren.')) return;
      if (state.hold) stopHold(false);
      stopRest();
      clearTimeout(saveTimer); curWorkout = null;
      await db.remove('fit_workouts', w);
      return renderTraining();
    } else return;
    const y = window.scrollY;
    drawTraining(w, workouts);
    window.scrollTo(0, y);
    if (act === 'finish') document.getElementById('reflect')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  $view.oninput = ev => {
    const k = ev.target.dataset.in;
    if (k === 'intention') { d.intention = ev.target.value; queueSave(w, 800); }
    if (k === 'note') { d.reflection = { ...(d.reflection || {}), note: ev.target.value }; queueSave(w, 800); }
  };
}

function renderCompletion(data) {
  const w = data.workouts.find(x => x.id === state.justDone);
  if (!w) { state.justDone = null; return renderTraining(); }
  const d = w.data;
  const reps = d.exercises.filter(e => e.unit === 'reps').flatMap(e => e.sets).filter(s => s.done).reduce((a, s) => a + s.value, 0);
  const secs = d.exercises.filter(e => e.unit === 'sec').flatMap(e => e.sets).filter(s => s.done).reduce((a, s) => a + s.value, 0);
  const ups = d.exercises.filter(e => e.sets.every(s => s.value >= e.range[1]) && e.step < LADDERS[e.ladder].steps.length - 1);
  const t = trainingStats(data.workouts, state.settings);
  $view.innerHTML = `
    <span class="kicker">Tag ${w.day_key} · ${esc(fmtLong(w.workout_date))}</span>
    <h1>Vollbracht.</h1>
    ${quoteHtml(addDays(w.workout_date, 7))}
    <section class="panel">
      <div class="kpis grid4">
        <div class="kpi"><div class="num">${minutes(d) ?? '–'}</div><div class="lbl">Minuten</div></div>
        <div class="kpi"><div class="num">${reps}</div><div class="lbl">Wiederholungen</div></div>
        <div class="kpi"><div class="num">${fmtSec(secs)}</div><div class="lbl">gehalten</div></div>
        <div class="kpi"><div class="num">${t.week}/${t.target}</div><div class="lbl">diese Woche</div></div>
      </div>
      ${ups.length ? `<p class="note" style="margin-top:12px">Beim nächsten Mal bereit für eine neue Stufe: ${ups.map(e => `<b>${esc(LADDERS[e.ladder].steps[e.step + 1])}</b>`).join(', ')}.</p>` : ''}
    </section>
    <div class="btn-row"><a class="btn ghost" href="#heute" style="text-align:center;text-decoration:none;line-height:24px">Zu Heute</a><a class="btn" href="#auswertung" style="text-align:center;text-decoration:none;line-height:24px">Zur Auswertung</a></div>`;
  $view.onclick = ev => { if (ev.target.closest('a')) state.justDone = null; };
}

// Stoppuhr für Halteübungen
function startHold(e, s) {
  const start = Date.now();
  state.hold = { e, s, start, iv: setInterval(() => {
    const el = document.getElementById(`val-${e}-${s}`);
    if (el) el.firstChild.textContent = Math.floor((Date.now() - start) / 1000);
  }, 250) };
  const btn = $view.querySelector(`[data-act="hold"][data-e="${e}"][data-s="${s}"]`);
  if (btn) { btn.textContent = 'Stopp'; btn.classList.add('running'); }
  const el = document.getElementById(`val-${e}-${s}`);
  if (el) el.firstChild.textContent = '0';
}
function stopHold(keep) {
  const h = state.hold;
  if (!h) return 0;
  clearInterval(h.iv);
  state.hold = null;
  return keep ? Math.floor((Date.now() - h.start) / 1000) : 0;
}

// Pausentimer
function startRest(sec) {
  stopRest();
  const end = Date.now() + sec * 1000;
  const bar = $rest.querySelector('.rest-bar i');
  const time = document.getElementById('rest-time');
  $rest.hidden = false;
  bar.style.transition = 'none'; bar.style.width = '100%';
  const tick = () => {
    const left = Math.max(0, (end - Date.now()) / 1000);
    time.textContent = left > 0 ? fmtSec(Math.ceil(left)) : 'Weiter.';
    bar.style.transition = 'width .25s linear';
    bar.style.width = `${left / sec * 100}%`;
    if (left <= 0) {
      clearInterval(state.rest);
      state.rest = null;
      navigator.vibrate?.([180, 90, 180]);
      setTimeout(() => { if (!state.rest) $rest.hidden = true; }, 2500);
    }
  };
  tick();
  state.rest = setInterval(tick, 250);
}
function stopRest() {
  clearInterval(state.rest);
  state.rest = null;
  $rest.hidden = true;
}
document.getElementById('rest-skip').onclick = stopRest;

// Bildschirm während des Trainings anlassen
async function requestWake() {
  try { if ('wakeLock' in navigator && !state.wakeLock) { state.wakeLock = await navigator.wakeLock.request('screen'); state.wakeLock.addEventListener('release', () => { state.wakeLock = null; }); } } catch { /* nicht erlaubt */ }
}
function setWake(on) {
  state.wantWake = on;
  if (on) requestWake();
  else if (state.wakeLock) { state.wakeLock.release().catch(() => {}); state.wakeLock = null; }
}

// ---------- Verlauf ----------
async function renderHistory() {
  const data = await loadAll();
  const done = doneWorkouts(data.workouts).reverse();
  const byMonth = new Map();
  for (const w of done) {
    const m = parseYmd(w.workout_date).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
    if (!byMonth.has(m)) byMonth.set(m, []);
    byMonth.get(m).push(w);
  }
  const card = w => {
    const d = w.data, editing = state.editHist === w.id;
    const reps = d.exercises.filter(e => e.unit === 'reps').flatMap(e => e.sets).filter(s => s.done).reduce((a, s) => a + s.value, 0);
    const meta = [minutes(d) ? `${minutes(d)} min` : null, `${reps} Wdh.`, d.reflection?.effort ? `Anstrengung ${d.reflection.effort}/5` : null].filter(Boolean).join(' · ');
    const dt = parseYmd(w.workout_date);
    return `<details class="hist" data-id="${w.id}" ${state.openHist.has(w.id) ? 'open' : ''}>
      <summary>
        <div class="hist-day"><span class="num">${dt.getDate()}</span><small>${dt.toLocaleDateString('de-DE', { weekday: 'short' })}</small></div>
        <div class="hist-main"><strong>Ganzkörper ${w.day_key}</strong><p class="sub">${meta}</p></div>
        ${d.reflection?.part ? `<span class="badge" title="Getan, was in meiner Macht stand?">${PART_BADGE[d.reflection.part]}</span>` : ''}
      </summary>
      <div class="hist-body">
        ${d.exercises.map((e, i) => `<div class="hist-ex"><strong>${esc(e.name)}</strong> <span class="note">Stufe ${e.step + 1}</span>
          <div class="sets-inline">${e.sets.map((s, j) => editing
            ? `<input type="number" inputmode="numeric" min="0" value="${s.done ? s.value : ''}" data-e="${i}" data-s="${j}" aria-label="Satz ${j + 1}">`
            : `<span class="pill">${s.done ? `${s.value} ${unitLabel(e.unit)}` : '–'}</span>`).join('')}</div></div>`).join('')}
        ${d.intention ? `<div class="reflection"><span class="kicker">Vorsatz</span>${esc(d.intention)}</div>` : ''}
        ${d.reflection?.note ? `<div class="reflection"><span class="kicker">Mitgenommen</span>${esc(d.reflection.note)}</div>` : ''}
        <div class="btn-row" style="margin-top:12px;justify-content:space-between">
          <button type="button" class="link" data-act="edit" data-id="${w.id}">${editing ? 'Fertig' : 'Bearbeiten'}</button>
          <button type="button" class="link danger" data-act="del" data-id="${w.id}">Löschen</button>
        </div>
      </div></details>`;
  };
  $view.innerHTML = `<h1>Verlauf</h1><p class="sub">${done.length} abgeschlossene Trainings</p>
    ${done.length ? [...byMonth].map(([m, ws]) => `<h2 class="month">${esc(m)}</h2>${ws.map(card).join('')}`).join('')
      : '<p class="empty" style="margin-top:16px">Noch kein Training abgeschlossen. Der erste Schritt ist der wichtigste.</p>'}`;

  $view.onclick = async ev => {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    const w = data.workouts.find(x => x.id === b.dataset.id);
    if (b.dataset.act === 'edit') { state.editHist = state.editHist === w.id ? null : w.id; renderHistory(); }
    if (b.dataset.act === 'del' && confirm(`Training vom ${fmtLong(w.workout_date)} löschen?`)) { await db.remove('fit_workouts', w); renderHistory(); }
  };
  $view.onchange = async ev => {
    const inp = ev.target;
    if (inp.tagName !== 'INPUT') return;
    const w = data.workouts.find(x => x.id === inp.closest('.hist').dataset.id);
    const s = w.data.exercises[+inp.dataset.e].sets[+inp.dataset.s];
    const v = parseInt(inp.value, 10);
    if (Number.isFinite(v) && v >= 0) { s.value = v; s.done = true; } else { s.done = false; }
    await db.save('fit_workouts', w);
  };
}

// Aufgeklappte Einträge merken (toggle blubbert nicht, daher capture).
$view.addEventListener('toggle', ev => {
  const el = ev.target.closest?.('.hist');
  if (!el) return;
  if (el.open) state.openHist.add(el.dataset.id); else state.openHist.delete(el.dataset.id);
}, true);

// ---------- Auswertung ----------
function dataTable(head, rows) {
  return `<details class="table-toggle"><summary>Als Tabelle</summary><table class="data"><thead><tr>${head.map((h, i) => `<th class="${i ? 'r' : ''}">${h}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(r => `<tr>${r.map((c, i) => `<td class="${i ? 'r' : ''}">${c}</td>`).join('')}</tr>`).join('')}</tbody></table></details>`;
}

async function renderStats() {
  const data = await loadAll();
  const today = todayStr();
  const t = trainingStats(data.workouts, state.settings, today);
  const hs = habitStats(data.habits, data.logs, today);
  const used = Object.keys(LADDERS).filter(k => ladderSeries(data.workouts, k).length);
  if (!used.includes(state.statLadder)) state.statLadder = used[0] || null;

  const virtue = (name, value, unit, lbl, pct) => `<div class="virtue"><span class="kicker">${name}</span>
    <div class="num">${value ?? '–'}${value != null ? `<small>${unit}</small>` : ''}</div><div class="lbl">${lbl}</div>
    ${pct != null ? `<div class="meter"><i style="width:${Math.min(100, pct)}%"></i></div>` : ''}</div>`;

  $view.innerHTML = `
    <h1>Auswertung</h1>
    <p class="sub">Nicht um dich zu messen, sondern um zu sehen, ob du dir treu bleibst.</p>
    <div class="virtues">
      ${virtue('Disziplin', t.fulfilment, '%', 'Planerfüllung der letzten 4 Wochen', t.fulfilment ?? 0)}
      ${virtue('Ausdauer', t.streak, t.streak === 1 ? ' Woche' : ' Wochen', 'in Folge mit erfülltem Plan', null)}
      ${virtue('Mäßigung', hs.rate30, '%', `Gewohnheiten gehalten, ${hs.days30 && hs.days30 < 30 ? `${hs.days30} Tage` : '30 Tage'}`, hs.rate30 ?? 0)}
      ${virtue('Tapferkeit', t.levelUps, '', t.levelUps === 1 ? 'Stufe gewagt' : 'Stufen gewagt', null)}
    </div>
    <div class="dash">
      <section class="panel span-2">
        <div class="panel-head"><div><h2>Fortschritt pro Übung</h2><p class="sub">Summe aller Sätze pro Training; gestrichelt = neue Stufe</p></div></div>
        ${used.length ? `<div class="chips" id="ladder-chips">${used.map(k => `<button type="button" class="chip" data-ladder="${k}" aria-pressed="${k === state.statLadder}">${esc(LADDERS[k].name)}</button>`).join('')}</div>
          <div class="chart-wrap" data-chart="progress" style="margin-top:12px"></div><div id="progress-extra"></div>`
          : '<p class="empty">Nach dem ersten Training siehst du hier, wie deine Wiederholungen wachsen.</p>'}
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>Körpergewicht</h2><p class="sub" id="weight-sub"></p></div>
          <div class="chips">${[30, 90, 365].map(n => `<button type="button" class="chip" data-days="${n}" aria-pressed="${n === state.weightDays}">${n === 365 ? '1 J.' : `${n} T.`}</button>`).join('')}</div></div>
        <div class="chart-wrap" data-chart="weight"></div><div id="weight-extra"></div>
      </section>
      <section class="panel span-2">
        <div class="panel-head"><div><h2>Training</h2><p class="sub">Wiederholungen pro Woche, die letzten 12 Wochen</p></div>
          <div class="kpis">
            <div class="kpi"><div class="num">${t.week}/${t.target}</div><div class="lbl">diese Woche</div></div>
            <div class="kpi"><div class="num">${t.month}</div><div class="lbl">diesen Monat</div></div>
            <div class="kpi"><div class="num">${t.total}</div><div class="lbl">insgesamt</div></div>
          </div></div>
        <div class="chart-wrap" data-chart="volume"></div>
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>Gewohnheiten</h2><p class="sub">12 Wochen · ${hs.streak} ${hs.streak === 1 ? 'Tag' : 'Tage'} in Folge alles gehalten</p></div></div>
        ${hs.n ? `${heatmap(hs.heat.map(c => ({ ...c, tip: `${fmtShort(c.date)}: ${c.count}/${hs.n} gehalten` })))}
          <div class="legend"><span>weniger</span><span><i style="background:var(--heat-0)"></i>keine</span><span><i style="background:var(--heat-1)"></i>einige</span><span><i style="background:var(--heat-2)"></i>die meisten</span><span><i style="background:var(--heat-3)"></i>alle</span></div>
          <div class="habit-rates">${hs.perHabit.map(h => `<div class="row"><span>${esc(h.name)}</span><div class="bar"><i style="width:${Math.round(h.days30 / (hs.days30 || 30) * 100)}%"></i></div><span>${h.days30}/${hs.days30 || 30}</span></div>`).join('')}</div>`
          : '<p class="empty">Noch keine Gewohnheiten angelegt.</p>'}
      </section>
    </div>`;

  drawStatCharts(data, today);

  $view.onclick = ev => {
    const c = ev.target.closest('[data-ladder]');
    if (c) { state.statLadder = c.dataset.ladder; for (const x of $view.querySelectorAll('[data-ladder]')) x.setAttribute('aria-pressed', x === c); drawStatCharts(data, today); return; }
    const d = ev.target.closest('[data-days]');
    if (d) { state.weightDays = +d.dataset.days; for (const x of $view.querySelectorAll('[data-days]')) x.setAttribute('aria-pressed', x === d); drawStatCharts(data, today); }
  };
}

function drawStatCharts(data, today) {
  const box = name => $view.querySelector(`[data-chart="${name}"]`);

  // Fortschritt
  const pb = box('progress');
  if (pb && state.statLadder) {
    const L = LADDERS[state.statLadder], u = unitLabel(L.unit);
    const s = ladderSeries(data.workouts, state.statLadder);
    const markers = [];
    s.forEach((p, i) => { if (i && p.step !== s[i - 1].step) markers.push({ date: p.date, label: `St. ${p.step + 1}`, tip: `${p.step > s[i - 1].step ? 'Aufstieg' : 'Wechsel'}: ${p.name}` }); });
    const from = s.length > 1 ? s[0].date : addDays(s[0].date, -7);
    pb.innerHTML = lineChart(s.map(p => ({ date: p.date, y: p.total, tip: `${fmtShort(p.date)} · ${p.name}\n${p.sets.join(' · ')} = ${p.total} ${u}` })),
      { from, to: today, toLabel: 'heute', width: pb.clientWidth, height: 230, markers, label: `Fortschritt ${L.name}` });
    const cur = s[s.length - 1];
    document.getElementById('progress-extra').innerHTML = `
      <div class="legend"><span><i class="ln" style="background:var(--accent)"></i>Summe pro Training (${u})</span>
        <span>Aktuell: <b>${esc(cur.name)}</b>, bester Satz ${cur.best} ${u}</span></div>
      ${dataTable(['Datum', 'Stufe', 'Sätze', 'Summe'], s.slice().reverse().map(p => [fmtShort(p.date), esc(p.name), p.sets.join(' · '), p.total]))}`;
  }

  // Volumen
  const vb = box('volume');
  if (vb) {
    const rows = weeklyVolume(data.workouts, 12, today).map((r, i, a) => ({
      label: parseYmd(r.week).toLocaleDateString('de-DE', { day: 'numeric', month: 'numeric' }),
      value: r.reps, current: i === a.length - 1,
      tip: `Woche ab ${fmtShort(r.week)}\n${r.sessions} ${r.sessions === 1 ? 'Training' : 'Trainings'} · ${r.reps} Wdh. · ${fmtSec(r.secs)} gehalten`,
    }));
    vb.innerHTML = rows.some(r => r.value) ? barChart(rows, { width: vb.clientWidth, height: 200, label: 'Wiederholungen pro Woche' })
      : '<p class="empty">Noch keine Wiederholungen in den letzten 12 Wochen.</p>';
  }

  // Gewicht
  const wb = box('weight');
  if (wb) {
    const ws = weightSeries(data.body, state.weightDays, today);
    const sub = document.getElementById('weight-sub');
    const extra = document.getElementById('weight-extra');
    if (ws.pts.length < 2) {
      wb.innerHTML = '<p class="empty">Ab zwei Messungen erscheint hier der Verlauf. Trag dein Gewicht unter „Heute“ ein.</p>';
      sub.textContent = ws.pts.length ? `${fmtNum(ws.pts[0].v, 1)} kg` : '';
      extra.innerHTML = '';
      return;
    }
    const first = ws.pts[0], last = ws.pts[ws.pts.length - 1];
    const diff = last.avg - first.avg;
    sub.textContent = `Ø ${fmtNum(last.avg, 1)} kg · ${diff >= 0 ? '+' : '−'}${fmtNum(Math.abs(diff), 1)} kg im Zeitraum`;
    wb.innerHTML = lineChart(ws.pts.map(p => ({ date: p.date, y: p.v, tip: `${fmtShort(p.date)}\n${fmtNum(p.v, 1)} kg · Ø 7 Tage ${fmtNum(p.avg, 1)} kg` })),
      { from: ws.from, to: today, toLabel: 'heute', width: wb.clientWidth, height: 210, avg: ws.pts.map(p => ({ date: p.date, y: p.avg })), decimals: 1, label: 'Körpergewicht' });
    extra.innerHTML = `<div class="legend"><span><i class="dot" style="background:var(--ink-mute)"></i>Messung</span><span><i class="ln" style="background:var(--accent)"></i>Ø 7 Tage</span></div>
      ${dataTable(['Datum', 'kg', 'Ø 7 Tage'], ws.pts.slice().reverse().map(p => [fmtShort(p.date), fmtNum(p.v, 1), fmtNum(p.avg, 1)]))}`;
  }
}

// ---------- Tooltip ----------
function hideTip() {
  $tip.hidden = true;
  for (const el of document.querySelectorAll('.xhair, .xdot')) el.setAttribute('visibility', 'hidden');
}
function showTip(t, x, y) {
  $tip.textContent = t.dataset.tip;
  $tip.hidden = false;
  const r = $tip.getBoundingClientRect();
  let left = Math.min(x + 14, innerWidth - r.width - 8);
  let top = y - r.height - 14;
  if (top < 8) top = y + 18;
  $tip.style.left = `${Math.max(8, left)}px`;
  $tip.style.top = `${top}px`;
  const svg = t.closest('svg');
  for (const el of document.querySelectorAll('.xhair, .xdot')) if (!svg?.contains(el)) el.setAttribute('visibility', 'hidden');
  if (svg && t.dataset.cx) {
    const xh = svg.querySelector('.xhair'), xd = svg.querySelector('.xdot');
    xh.setAttribute('x1', t.dataset.cx); xh.setAttribute('x2', t.dataset.cx); xh.setAttribute('visibility', 'visible');
    xd.setAttribute('cx', t.dataset.cx); xd.setAttribute('cy', t.dataset.cy); xd.setAttribute('visibility', 'visible');
  }
}
const onPointer = ev => {
  const t = ev.target.closest?.('[data-tip]');
  if (t) showTip(t, ev.clientX, ev.clientY); else if (!$tip.hidden) hideTip();
};
document.addEventListener('pointermove', onPointer);
document.addEventListener('pointerdown', onPointer);
document.addEventListener('scroll', hideTip, { passive: true });

// ---------- Mehr ----------
async function renderMore() {
  const data = await loadAll();
  const S = state.settings;
  const lastSync = await db.getMeta('lastSync');
  const lastError = await db.getMeta('lastError');
  const pending = await db.pendingCount();
  const fmt = iso => iso ? new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '–';
  const body = data.body.slice().sort((a, b) => b.entry_date.localeCompare(a.entry_date));
  const ladders = Object.entries(LADDERS).filter(([k]) => S.bar || k !== 'vpull');

  $view.innerHTML = `
    <h1>Mehr</h1>
    <section class="panel" style="margin-top:16px">
      <h2>Trainingsplan</h2>
      <p class="sub">Ganzkörper A/B im Wechsel</p>
      <div class="field"><span class="label">Trainingstage</span>
        <div class="chips even">${WEEKDAYS.map(([d, n]) => `<button type="button" class="chip" data-day="${d}" aria-pressed="${S.days.includes(d)}">${n}</button>`).join('')}</div></div>
      <div class="field"><label class="switch"><span>Klimmzugstange vorhanden<span class="hint">Tag B nutzt dann Klimmzüge statt Rudern</span></span><input type="checkbox" id="bar" ${S.bar ? 'checked' : ''}></label></div>
      <div class="field"><span class="label">Pause zwischen Sätzen</span>
        <div class="chips even">${[60, 90, 120, 180].map(s => `<button type="button" class="chip" data-rest="${s}" aria-pressed="${S.rest === s}">${fmtSec(s)}</button>`).join('')}</div></div>
      <div class="field"><span class="label">Aktuelle Stufen <span class="hint">Werden beim Aufsteigen im Training automatisch angepasst.</span></span>
        ${ladders.map(([k, L]) => `<div class="ladder-row"><span>${esc(L.name)}</span><select data-ladder="${k}">${L.steps.map((s, i) => `<option value="${i}" ${i === (S.level[k] ?? 0) ? 'selected' : ''}>${i + 1}. ${esc(s)}</option>`).join('')}</select></div>`).join('')}
      </div>
    </section>

    <section class="panel">
      <h2>Gewohnheiten</h2>
      <ul class="edit-list">${data.habits.map((h, i) => `<li data-id="${esc(h.id)}">
        <input type="text" value="${esc(h.name)}" data-rename aria-label="Name">
        <button type="button" class="icon-btn" data-move="-1" ${i === 0 ? 'disabled' : ''} aria-label="nach oben">↑</button>
        <button type="button" class="icon-btn" data-move="1" ${i === data.habits.length - 1 ? 'disabled' : ''} aria-label="nach unten">↓</button>
        <button type="button" class="icon-btn" data-hdel aria-label="löschen">✕</button></li>`).join('')}</ul>
      <form class="inline" id="habit-add" style="margin-top:12px"><input type="text" name="n" placeholder="Neue Gewohnheit" maxlength="60"><button class="btn" type="submit">Hinzufügen</button></form>
    </section>

    <section class="panel">
      <h2>Körperwerte</h2>
      <form id="body-form" class="grid-form" style="margin-top:12px">
        <label>Datum<input type="date" name="d" value="${todayStr()}" max="${todayStr()}"></label>
        <label>Gewicht (kg)<input type="number" name="w" inputmode="decimal" step="0.1" min="20" max="300"></label>
        <label>Körperfett (%)<input type="number" name="f" inputmode="decimal" step="0.1" min="2" max="70"></label>
        <label>Bauchumfang (cm)<input type="number" name="c" inputmode="decimal" step="0.5" min="30" max="250"></label>
        <button class="btn" type="submit" style="grid-column:span 2">Speichern</button>
      </form>
      <p class="msg" id="body-msg"></p>
      ${body.length ? `<table class="data"><thead><tr><th>Datum</th><th class="r">kg</th><th class="r">KFA</th><th class="r">Bauch</th><th></th></tr></thead><tbody>
        ${body.slice(0, 12).map(b => `<tr><td>${fmtShort(b.entry_date)}</td><td class="r">${b.weight_kg != null ? fmtNum(b.weight_kg, 1) : '–'}</td><td class="r">${b.body_fat != null ? fmtNum(b.body_fat, 1) + ' %' : '–'}</td><td class="r">${b.waist_cm != null ? fmtNum(b.waist_cm, 1) : '–'}</td>
        <td class="r"><button type="button" class="link danger" data-bdel="${b.id}">Löschen</button></td></tr>`).join('')}</tbody></table>` : ''}
    </section>

    <section class="panel">
      <h2>Konto</h2>
      ${LOCAL_MODE
        ? `<p class="note">Lokaler Modus: Einträge bleiben nur auf diesem Gerät.</p>`
        : `<div class="kv"><span>Angemeldet als</span><span>${esc(state.user?.email || '')}</span></div>
           <div class="kv"><span>Letzter Sync</span><span>${fmt(lastSync)}</span></div>
           <div class="kv"><span>Ausstehende Änderungen</span><span>${pending}</span></div>
           ${lastError ? `<div class="kv"><span>Letzter Fehler</span><span>${fmt(lastError.at)}: ${esc(lastError.msg)}</span></div>` : ''}`}
      <div class="btn-row" style="margin-top:12px">
        ${LOCAL_MODE ? '' : '<button class="btn" id="sync-now">Jetzt synchronisieren</button>'}
        <button class="btn ghost" id="export">Backup exportieren</button>
      </div>
      ${LOCAL_MODE ? '' : `<div class="btn-row" style="margin-top:10px"><button class="btn quiet" id="logout">Abmelden</button></div>
        <p class="note">Askesis und das Stoische Journal teilen sich die Anmeldung: Abmelden hier meldet dich auch im Journal ab.</p>`}
    </section>
    <section class="panel">
      <h2>Als App installieren</h2>
      <p class="note">Android (Chrome): Menü ⋮ → „App installieren“.<br>Computer (Chrome/Edge): Installieren-Symbol rechts in der Adressleiste.</p>
    </section>`;

  $view.onclick = async ev => {
    const day = ev.target.closest('[data-day]');
    if (day) {
      const d = +day.dataset.day;
      const days = S.days.includes(d) ? S.days.filter(x => x !== d) : [...S.days, d];
      await saveSettings({ days: days.sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)) });
      return renderMore();
    }
    const rest = ev.target.closest('[data-rest]');
    if (rest) { await saveSettings({ rest: +rest.dataset.rest }); return renderMore(); }
    const li = ev.target.closest('.edit-list li');
    const mv = ev.target.closest('[data-move]');
    if (li && mv) {
      const list = data.habits.slice(), i = list.findIndex(h => h.id === li.dataset.id), j = i + (+mv.dataset.move);
      [list[i], list[j]] = [list[j], list[i]];
      for (let k = 0; k < list.length; k++) if (list[k].sort !== k) await db.save('fit_habits', { ...list[k], sort: k });
      return renderMore();
    }
    if (li && ev.target.closest('[data-hdel]')) {
      const h = data.habits.find(x => x.id === li.dataset.id);
      if (confirm(`„${h.name}“ löschen? Die bisherigen Häkchen zählen dann nicht mehr in der Auswertung.`)) { await db.remove('fit_habits', h); renderMore(); }
      return;
    }
    const bdel = ev.target.closest('[data-bdel]');
    if (bdel) {
      const b = data.body.find(x => x.id === bdel.dataset.bdel);
      if (confirm(`Eintrag vom ${fmtLong(b.entry_date)} löschen?`)) { await db.remove('fit_body', b); renderMore(); }
    }
  };
  $view.onchange = async ev => {
    const el = ev.target;
    if (el.id === 'bar') { await saveSettings({ bar: el.checked }); return renderMore(); }
    if (el.dataset.ladder) { await saveSettings({ level: { ...S.level, [el.dataset.ladder]: +el.value } }); return; }
    if ('rename' in el.dataset) {
      const h = data.habits.find(x => x.id === el.closest('li').dataset.id);
      const name = el.value.trim();
      if (name && name !== h.name) await db.save('fit_habits', { ...h, name });
      else el.value = h.name;
    }
  };
  document.getElementById('habit-add').onsubmit = async ev => {
    ev.preventDefault();
    const name = ev.target.n.value.trim();
    if (!name) return;
    await db.save('fit_habits', { id: db.uuid(), name, sort: data.habits.length, archived: false, deleted: false });
    renderMore();
  };
  document.getElementById('body-form').onsubmit = async ev => {
    ev.preventDefault();
    const f = ev.target, msg = document.getElementById('body-msg');
    const num = v => { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };
    const rec = { entry_date: f.d.value || todayStr(), weight_kg: num(f.w.value), body_fat: num(f.f.value), waist_cm: num(f.c.value) };
    if (rec.weight_kg == null && rec.body_fat == null && rec.waist_cm == null) { msg.className = 'msg err'; msg.textContent = 'Bitte mindestens einen Wert eintragen.'; return; }
    const same = data.body.find(b => b.entry_date === rec.entry_date);
    const merged = same ? { ...same, ...Object.fromEntries(Object.entries(rec).filter(([, v]) => v != null)) } : { id: db.uuid(), note: null, deleted: false, ...rec };
    await db.save('fit_body', merged);
    renderMore();
  };
  document.getElementById('export').onclick = async () => {
    const out = { exported_at: new Date().toISOString() };
    for (const s of db.STORES) out[s] = (await db.live(s)).map(({ dirty, deleted, ...x }) => x);
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `askesis-${todayStr()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const syncBtn = document.getElementById('sync-now');
  if (syncBtn) syncBtn.onclick = async () => { await state.sync?.run(); renderMore(); };
  const logout = document.getElementById('logout');
  if (logout) logout.onclick = async () => {
    if (await db.pendingCount() && !confirm('Es gibt noch nicht synchronisierte Änderungen. Trotzdem abmelden? Sie gehen dann verloren.')) return;
    if (!confirm('Abmelden? Du wirst auch im Stoischen Journal abgemeldet.')) return;
    await db.clearAll();
    await auth.signOut(state.client);
    location.hash = '';
    location.reload();
  };
}

// ---------- Service Worker ----------
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW-Registrierung fehlgeschlagen', err));
}

boot();
