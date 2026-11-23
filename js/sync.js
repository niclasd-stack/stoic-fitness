// Synchronisation mit Supabase: erst holen (pull), dann senden (push).
// Konflikte: der Datensatz mit dem neueren updated_at gewinnt (last-write-wins).
// Gelöschtes bleibt als deleted = true erhalten, damit das Löschen alle Geräte erreicht.
import * as db from './db.js';

const PAGE = 1000;

// Spalten pro Tabelle (ohne user_id, updated_at, server_updated_at – die kommen immer dazu).
const TABLES = {
  fit_workouts:  ['id', 'workout_date', 'day_key', 'data', 'deleted'],
  fit_body:      ['id', 'entry_date', 'weight_kg', 'body_fat', 'waist_cm', 'note', 'deleted'],
  fit_habits:    ['id', 'name', 'sort', 'archived', 'deleted'],
  fit_habit_log: ['id', 'habit_id', 'log_date', 'done', 'deleted'],
  fit_settings:  ['id', 'data', 'deleted'],
};

const pick = (obj, cols) => Object.fromEntries(cols.map(c => [c, obj[c] ?? (c === 'deleted' ? false : null)]));

export class Sync {
  constructor(client, userId, { onStatus = () => {}, onRemoteChange = () => {} } = {}) {
    this.client = client;
    this.userId = userId;
    this.onStatus = onStatus;
    this.onRemoteChange = onRemoteChange;
    this.timer = null;
    this.running = false;
    this.again = false;
  }

  schedule(ms = 2000) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), ms);
  }

  async run() {
    if (this.running) { this.again = true; return; }
    if (!navigator.onLine) { this.onStatus('offline'); return; }
    this.running = true;
    this.onStatus('syncing');
    const changed = new Set();
    const errors = [];
    // Jede Tabelle für sich, damit ein Fehler bei einer die anderen nicht blockiert.
    for (const name of Object.keys(TABLES)) {
      try {
        if (await this.pull(name)) changed.add(name);
        await this.push(name);
      } catch (err) {
        errors.push(`${name}: ${err?.message || err?.code || String(err)}`);
        console.warn(`Sync (${name}) fehlgeschlagen`, err);
      }
    }
    const failed = errors.length > 0;
    try {
      if (!failed) await db.setMeta('lastSync', new Date().toISOString());
      await db.setMeta('lastError', failed ? { at: new Date().toISOString(), msg: errors.join(' · ') } : null);
      const pending = await db.pendingCount();
      this.onStatus(failed ? (navigator.onLine ? 'error' : 'offline') : pending ? 'pending' : 'synced');
      this.onRemoteChange(changed, !failed);
    } finally {
      this.running = false;
      if (this.again) { this.again = false; this.schedule(300); }
    }
  }

  async pull(name) {
    const cols = TABLES[name];
    const cursorKey = `cursor:${name}`;
    let changed = false;
    let last = await db.getMeta(cursorKey);
    for (;;) {
      let q = this.client.from(name).select([...cols, 'updated_at', 'server_updated_at'].join(', '))
        .order('server_updated_at', { ascending: true }).limit(PAGE);
      if (last) q = q.gt('server_updated_at', last);
      const { data, error } = await q;
      if (error) throw error;
      for (const row of data) {
        const local = await db.get(name, row.id);
        if (!local || Date.parse(row.updated_at) > Date.parse(local.updated_at)) {
          await db.put(name, { ...pick(row, cols), updated_at: row.updated_at, dirty: false });
          changed = true;
        }
      }
      if (data.length) {
        last = data[data.length - 1].server_updated_at;
        await db.setMeta(cursorKey, last);
      }
      if (data.length < PAGE) break;
    }
    return changed;
  }

  async push(name) {
    const cols = TABLES[name];
    const dirty = await db.dirty(name);
    if (!dirty.length) return;
    const rows = dirty.map(x => ({ ...pick(x, cols), user_id: this.userId, updated_at: x.updated_at }));
    const { error } = await this.client.from(name).upsert(rows, { onConflict: 'user_id,id' });
    if (error) throw error;
    // Nur als sauber markieren, wenn seitdem nicht weiter geändert wurde.
    for (const x of dirty) {
      const cur = await db.get(name, x.id);
      if (cur && cur.updated_at === x.updated_at) await db.put(name, { ...cur, dirty: false });
    }
  }
}
