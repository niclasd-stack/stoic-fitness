-- Stoische Disziplin (Fitness) – im Supabase SQL-Editor einmal komplett ausführen.
-- Läuft im selben Projekt wie das Stoische Journal; die Tabellen beginnen mit fit_.
-- IDs erzeugt das Gerät. Gelöschtes bleibt mit deleted = true erhalten (für den Sync).

-- Server-Zeitstempel setzen; ältere Änderungen überschreiben keine neueren (last-write-wins).
create or replace function public.fit_touch()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.updated_at < old.updated_at then
    return old;
  end if;
  new.server_updated_at := now();
  return new;
end $$;

create table if not exists public.fit_workouts (
  user_id           uuid not null default auth.uid() references auth.users on delete cascade,
  id                text not null,
  workout_date      date not null,
  day_key           text not null check (day_key in ('A', 'B')),
  data              jsonb not null default '{}'::jsonb,   -- Übungen, Sätze, Intention, Reflexion
  deleted           boolean not null default false,
  updated_at        timestamptz not null default now(),
  server_updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.fit_body (
  user_id           uuid not null default auth.uid() references auth.users on delete cascade,
  id                text not null,
  entry_date        date not null,
  weight_kg         numeric(5,2),
  body_fat          numeric(4,1),
  waist_cm          numeric(5,1),
  note              text,
  deleted           boolean not null default false,
  updated_at        timestamptz not null default now(),
  server_updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.fit_habits (
  user_id           uuid not null default auth.uid() references auth.users on delete cascade,
  id                text not null,
  name              text not null,
  sort              integer not null default 0,
  archived          boolean not null default false,
  deleted           boolean not null default false,
  updated_at        timestamptz not null default now(),
  server_updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.fit_habit_log (
  user_id           uuid not null default auth.uid() references auth.users on delete cascade,
  id                text not null,                         -- '<habit_id>|<YYYY-MM-DD>'
  habit_id          text not null,
  log_date          date not null,
  done              boolean not null default false,
  deleted           boolean not null default false,
  updated_at        timestamptz not null default now(),
  server_updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.fit_settings (
  user_id           uuid not null default auth.uid() references auth.users on delete cascade,
  id                text not null,                         -- immer 'settings'
  data              jsonb not null default '{}'::jsonb,
  deleted           boolean not null default false,
  updated_at        timestamptz not null default now(),
  server_updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

-- Index, Trigger, Rechte und Row Level Security für alle fünf Tabellen.
do $$
declare t text;
begin
  foreach t in array array['fit_workouts', 'fit_body', 'fit_habits', 'fit_habit_log', 'fit_settings'] loop
    execute format('create index if not exists %I on public.%I (user_id, server_updated_at)', t || '_user_server_updated', t);
    execute format('drop trigger if exists %I on public.%I', t || '_touch', t);
    execute format('create trigger %I before insert or update on public.%I for each row execute function public.fit_touch()', t || '_touch', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "eigene lesen" on public.%I', t);
    execute format('drop policy if exists "eigene anlegen" on public.%I', t);
    execute format('drop policy if exists "eigene ändern" on public.%I', t);
    execute format('drop policy if exists "eigene löschen" on public.%I', t);
    execute format('create policy "eigene lesen"   on public.%I for select to authenticated using (user_id = auth.uid())', t);
    execute format('create policy "eigene anlegen" on public.%I for insert to authenticated with check (user_id = auth.uid())', t);
    execute format('create policy "eigene ändern"  on public.%I for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())', t);
    execute format('create policy "eigene löschen" on public.%I for delete to authenticated using (user_id = auth.uid())', t);
  end loop;
end $$;
