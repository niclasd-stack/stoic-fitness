// Fester Ganzkörperplan mit dem eigenen Körpergewicht: Tag A und B im Wechsel.
// Fortschritt über die Wiederholungen (bzw. Sekunden); oben im Zielbereich → nächste Stufe der Leiter.

// Leitern: jede Stufe ist schwerer als die vorige. range = Zielbereich pro Satz.
export const LADDERS = {
  push: {
    name: 'Liegestütz', unit: 'reps', range: [8, 15],
    steps: ['Wand-Liegestütz', 'Liegestütz erhöht (Tisch/Bank)', 'Knie-Liegestütz', 'Liegestütz',
      'Enger Liegestütz (Diamant)', 'Liegestütz Füße erhöht', 'Archer-Liegestütz', 'Einarmiger Liegestütz erhöht'],
  },
  squat: {
    name: 'Kniebeuge', unit: 'reps', range: [12, 25],
    steps: ['Kniebeuge mit Halt (Türrahmen)', 'Kniebeuge', 'Kniebeuge mit 3 s Pause unten',
      'Kosaken-Kniebeuge', 'Pistol Squat auf Erhöhung', 'Pistol Squat'],
  },
  row: {
    name: 'Rudern', unit: 'reps', range: [8, 15],
    steps: ['Rudern am Türrahmen (Handtuch)', 'Tisch-Rudern, Knie gebeugt', 'Tisch-Rudern, Beine gestreckt',
      'Tisch-Rudern, Füße erhöht', 'Archer-Rudern', 'Einarmiges Tisch-Rudern'],
  },
  vpull: {
    name: 'Klimmzug', unit: 'reps', range: [3, 8],
    steps: ['Negativ-Klimmzug (5 s ablassen)', 'Klimmzug im Untergriff (Chin-up)', 'Klimmzug',
      'Klimmzug eng/breit im Wechsel', 'Archer-Klimmzug'],
  },
  pike: {
    name: 'Schulterdrücken', unit: 'reps', range: [6, 12],
    steps: ['Pike Push-up', 'Pike Push-up Füße erhöht', 'Handstand-Liegestütz negativ (Wand)', 'Handstand-Liegestütz an der Wand'],
  },
  lunge: {
    name: 'Ausfallschritt', unit: 'reps', range: [8, 15], perSide: true,
    steps: ['Split Squat statisch', 'Ausfallschritt rückwärts', 'Bulgarischer Split Squat',
      'Bulgarischer Split Squat mit Pause', 'Skater Squat'],
  },
  bridge: {
    name: 'Hüfte', unit: 'reps', range: [12, 20],
    steps: ['Glute Bridge', 'Glute Bridge mit 2 s Halt', 'Einbeinige Glute Bridge', 'Einbeiniger Hip Thrust (Sofa)'],
  },
  plank: {
    name: 'Unterarmstütz', unit: 'sec', range: [20, 60],
    steps: ['Unterarmstütz auf Knien', 'Unterarmstütz', 'Unterarmstütz Füße erhöht', 'Unterarmstütz, ein Bein angehoben'],
  },
  hollow: {
    name: 'Hollow Hold', unit: 'sec', range: [15, 45],
    steps: ['Hollow Hold gehockt', 'Hollow Hold ein Bein gestreckt', 'Hollow Hold', 'Hollow Hold Arme über Kopf'],
  },
  side: {
    name: 'Seitstütz', unit: 'sec', range: [15, 45], perSide: true,
    steps: ['Seitstütz auf Knien', 'Seitstütz', 'Seitstütz mit Beinheben'],
  },
};

// Tag A: Drücken horizontal, Kniebeuge, Rudern, Hüfte, Stütz. Tag B: Drücken vertikal, Ausfallschritt, Ziehen, Rumpf.
export function dayTemplate(dayKey, settings) {
  const pull = settings.bar ? 'vpull' : 'row';
  const A = [['push', 3], ['squat', 3], ['row', 3], ['bridge', 3], ['plank', 3]];
  const B = [['pike', 3], ['lunge', 3], [pull, 3], ['hollow', 3], ['side', 2]];
  return (dayKey === 'A' ? A : B).map(([ladder, sets]) => ({ ladder, sets }));
}

export const DEFAULT_SETTINGS = {
  days: [1, 3, 5],   // Mo, Mi, Fr (0 = So)
  bar: false,        // Klimmzugstange vorhanden?
  rest: 90,          // Pause zwischen Sätzen in Sekunden
  level: { push: 3, squat: 1, row: 1, vpull: 0, pike: 0, lunge: 0, bridge: 0, plank: 1, hollow: 1, side: 1 },
};

export const unitLabel = (unit, short = true) => unit === 'sec' ? (short ? 's' : 'Sekunden') : (short ? 'Wdh.' : 'Wiederholungen');
export const stepName = (ladder, step) => LADDERS[ladder].steps[Math.min(step, LADDERS[ladder].steps.length - 1)];

// Letzte abgeschlossene Ausführung einer Leiter (beliebige Stufe), neueste zuerst.
function lastPerformances(workouts, ladder) {
  const out = [];
  for (const w of workouts) {
    if (w.deleted || w.data?.status !== 'done') continue;
    for (const ex of w.data.exercises || []) {
      if (ex.ladder === ladder && ex.sets.some(s => s.done)) out.push({ date: w.workout_date, at: w.data.finished_at || w.updated_at, ex });
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || String(b.at).localeCompare(String(a.at)));
}

// Vorschlag für die nächste Einheit einer Übung.
// Ergebnis: { targets: [Zahl pro Satz], last: [...]|null, ready: bool (alle Sätze oben → nächste Stufe) }
export function suggest(workouts, ladder, step, sets) {
  const L = LADDERS[ladder];
  const [lo, hi] = L.range;
  const inc = L.unit === 'sec' ? 5 : 1;
  const prev = lastPerformances(workouts, ladder).find(p => p.ex.step === step);
  if (!prev) return { targets: Array(sets).fill(lo), last: null, ready: false };
  const last = prev.ex.sets.filter(s => s.done).map(s => s.value);
  while (last.length < sets) last.push(last[last.length - 1] ?? lo);
  const vals = last.slice(0, sets);
  const ready = vals.every(v => v >= hi);
  if (ready) return { targets: vals.map(() => hi), last: vals, ready: true };
  // Insgesamt etwas mehr als letztes Mal: den schwächsten Satz um eine Wdh. bzw. 5 s anheben.
  const targets = vals.map(v => Math.max(v, lo));
  let k = 0;
  for (let i = 1; i < targets.length; i++) if (targets[i] < targets[k]) k = i;
  targets[k] = Math.min(hi, targets[k] + inc);
  return { targets, last: vals, ready: false };
}

// Welcher Tag ist dran? Abwechselnd A/B nach dem letzten abgeschlossenen Training.
export function nextDayKey(workouts) {
  const done = workouts.filter(w => !w.deleted && w.data?.status === 'done')
    .sort((a, b) => b.workout_date.localeCompare(a.workout_date) || String(b.data.finished_at).localeCompare(String(a.data.finished_at)));
  return done.length && done[0].day_key === 'A' ? 'B' : 'A';
}

export function buildWorkout(dayKey, settings, workouts) {
  return dayTemplate(dayKey, settings).map(({ ladder, sets }) => {
    const L = LADDERS[ladder];
    const step = settings.level[ladder] ?? 0;
    const s = suggest(workouts, ladder, step, sets);
    return {
      ladder, step, name: stepName(ladder, step), unit: L.unit, range: L.range, perSide: !!L.perSide,
      ready: s.ready, last: s.last,
      sets: s.targets.map(v => ({ value: v, done: false })),
    };
  });
}
