-- Rushcast database schema for Supabase (free plan: 500 MB Postgres, realtime included).
-- Paste this whole file into Supabase -> SQL Editor -> Run. It is idempotent.

-- ---------------------------------------------------------------------------
-- Crowd-sourced reports ("Empty" / "Moderate" / "Crowded" buttons in the app)
-- ---------------------------------------------------------------------------
create table if not exists public.reports (
  id          bigint generated always as identity primary key,
  facility_id text        not null check (facility_id ~ '^[a-z0-9-]{2,32}$'),
  level       smallint    not null check (level between 0 and 2), -- 0 empty, 1 moderate, 2 crowded
  device_id   uuid        not null,                               -- random per install, not tied to a person
  created_at  timestamptz not null default now()
);
create index if not exists reports_facility_time on public.reports (facility_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Sensor readings (Wi-Fi association counts converted to people estimates)
-- Written only by the ingest clients using the service-role key.
-- ---------------------------------------------------------------------------
create table if not exists public.readings (
  facility_id text        not null check (facility_id ~ '^[a-z0-9-]{2,32}$'),
  ts          timestamptz not null,
  devices     integer     not null check (devices >= 0),
  people      integer     not null check (people >= 0),
  primary key (facility_id, ts)
);

-- ---------------------------------------------------------------------------
-- Abuse guard: one report per device per facility every 3 minutes,
-- at most 40 reports per device per hour. Server time is authoritative.
-- ---------------------------------------------------------------------------
create or replace function public.guard_report() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.created_at := now();
  if exists (
    select 1 from public.reports
    where device_id = new.device_id and facility_id = new.facility_id
      and created_at > now() - interval '3 minutes'
  ) then
    raise exception 'rate_limited' using errcode = 'P0001', hint = 'One report per place every 3 minutes';
  end if;
  if (select count(*) from public.reports
      where device_id = new.device_id and created_at > now() - interval '1 hour') >= 40 then
    raise exception 'rate_limited' using errcode = 'P0001', hint = 'Hourly report limit reached';
  end if;
  return new;
end $$;

drop trigger if exists reports_guard on public.reports;
create trigger reports_guard before insert on public.reports
  for each row execute function public.guard_report();

-- ---------------------------------------------------------------------------
-- Row level security: the anon key in the web app can read recent data and
-- insert reports, nothing else. device_id is never exposed back.
-- ---------------------------------------------------------------------------
alter table public.reports  enable row level security;
alter table public.readings enable row level security;

drop policy if exists "insert reports" on public.reports;
create policy "insert reports" on public.reports
  for insert to anon, authenticated with check (true);

drop policy if exists "read recent readings" on public.readings;
create policy "read recent readings" on public.readings
  for select to anon, authenticated using (ts > now() - interval '2 days');

-- Public view without device ids; reports table itself is not selectable by anon.
create or replace view public.recent_reports with (security_invoker = false) as
  select id, facility_id, level, created_at
  from public.reports
  where created_at > now() - interval '6 hours';
grant select on public.recent_reports to anon, authenticated;

-- Latest reading per facility for the live board.
create or replace view public.latest_readings with (security_invoker = false) as
  select distinct on (facility_id) facility_id, ts, devices, people
  from public.readings
  where ts > now() - interval '30 minutes'
  order by facility_id, ts desc;
grant select on public.latest_readings to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: push new reports and readings to every open app instantly.
-- ---------------------------------------------------------------------------
do $$ begin
  alter publication supabase_realtime add table public.reports;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.readings;
exception when duplicate_object then null; end $$;

-- Realtime respects RLS, so give anon a narrow select on fresh report rows
-- (device_id is a random install id; nothing personal is stored).
drop policy if exists "realtime fresh reports" on public.reports;
create policy "realtime fresh reports" on public.reports
  for select to anon, authenticated using (created_at > now() - interval '10 minutes');

-- ---------------------------------------------------------------------------
-- Housekeeping, called by the scheduled GitHub Action (keeps the free
-- project active, so it never hits the 7-day inactivity pause).
-- ---------------------------------------------------------------------------
create or replace function public.prune_old() returns void
language sql security definer set search_path = public as $$
  delete from public.reports  where created_at < now() - interval '90 days';
  delete from public.readings where ts         < now() - interval '120 days';
$$;
revoke all on function public.prune_old() from public, anon, authenticated;
grant execute on function public.prune_old() to service_role;
