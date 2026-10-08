-- Rushcast schema for Neon Postgres (free plan). Idempotent; applied by server/migrate.mjs.

create table if not exists reports (
  id          bigint generated always as identity primary key,
  facility_id text        not null check (facility_id ~ '^[a-z0-9-]{2,32}$'),
  level       smallint    not null check (level between 0 and 2), -- 0 empty, 1 moderate, 2 crowded
  device_id   uuid        not null,                               -- random per install, never returned
  created_at  timestamptz not null default now()
);
create index if not exists reports_facility_time on reports (facility_id, created_at desc);
create index if not exists reports_device_time on reports (device_id, created_at desc);

create table if not exists readings (
  facility_id text        not null check (facility_id ~ '^[a-z0-9-]{2,32}$'),
  ts          timestamptz not null,
  devices     integer     not null check (devices >= 0),
  people      integer     not null check (people >= 0),
  primary key (facility_id, ts)
);

-- Abuse guard: one report per device per place every 3 minutes, 40 per hour.
create or replace function guard_report() returns trigger language plpgsql as $$
begin
  new.created_at := now();
  if exists (select 1 from reports where device_id = new.device_id and facility_id = new.facility_id and created_at > now() - interval '3 minutes') then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
  if (select count(*) from reports where device_id = new.device_id and created_at > now() - interval '1 hour') >= 40 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists reports_guard on reports;
create trigger reports_guard before insert on reports for each row execute function guard_report();
