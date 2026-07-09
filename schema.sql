-- Contract Tracker schema — Supabase (Postgres)
-- Already applied to the live project. Kept here as source of truth for future changes.

create extension if not exists pgcrypto;

-- Categories: admin-managed spend categories, editable in-app
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

-- Tailored to Sandbox VR's business (VR entertainment venues), not generic spend buckets —
-- rename/add/remove anytime from Admin > Categories.
insert into public.categories (name) values
  ('VR & Content Development'),
  ('Venue Operations & Facilities'),
  ('People, Payroll & Talent'),
  ('Finance, Legal & Compliance'),
  ('Marketing & Guest Engagement'),
  ('IT & Network Infrastructure'),
  ('Engineering & Product Tools'),
  ('Business Productivity & AI Tools'),
  ('Other');

-- Contracts
create table public.contracts (
  id uuid primary key default gen_random_uuid(),
  contract_ref text unique not null,
  supplier text,
  category_id uuid references public.categories(id) on delete set null,
  total_value numeric,
  -- Manual classification fallback for contracts not sourced from a Vendr export
  value_type text check (value_type in ('annual', 'multi_year', 'one_time')),
  contract_term_years numeric,
  -- Fields sourced directly from Vendr's "All agreements" export
  type text check (type in ('Subscription', 'Contract')),
  term_months integer,
  annualized_value numeric,
  billing_amount numeric,
  billing_frequency text,
  date_signed date,
  product text,
  renewal_deadline date,
  auto_renew boolean,
  renewal_stage text default 'Not started',
  negotiated_savings numeric,
  negotiated_savings_pct numeric,
  notice_period_days integer,
  notes text,
  status text not null default 'active'
    check (status in ('active', 'pending', 'cancelled', 'expired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Owners (deduped by email)
create table public.owners (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique
);

-- Contract <-> owner join (many-to-many)
create table public.contract_owners (
  contract_id uuid not null references public.contracts(id) on delete cascade,
  owner_id uuid not null references public.owners(id) on delete cascade,
  primary key (contract_id, owner_id)
);

-- Access control (editable in-app, no code deploys to add people)
create table public.user_roles (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  role text not null check (role in ('admin', 'editor', 'viewer')),
  created_at timestamptz not null default now()
);

insert into public.user_roles (email, role) values
  ('danielle.beram1@gmail.com', 'admin');

-- Alert thresholds (configurable, no code deploy to change timing)
create table public.alert_thresholds (
  id uuid primary key default gen_random_uuid(),
  days_before integer not null unique,
  enabled boolean not null default true
);

insert into public.alert_thresholds (days_before) values (60), (14);

-- Prevents duplicate Slack/email sends across daily cron runs
create table public.alert_log (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contracts(id) on delete cascade,
  threshold_days integer not null,
  channel text not null check (channel in ('slack', 'email')),
  sent_at timestamptz not null default now(),
  unique (contract_id, threshold_days, channel)
);

-- Keep updated_at current
create or replace function public.set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger contracts_set_updated_at
  before update on public.contracts
  for each row execute function public.set_updated_at();

-- RLS: security-definer helper avoids recursive policy checks on user_roles itself
create or replace function public.current_user_role()
returns text
language sql
security definer
set search_path = public
as $$
  select role from public.user_roles where email = auth.jwt() ->> 'email';
$$;

alter table public.contracts enable row level security;
alter table public.owners enable row level security;
alter table public.contract_owners enable row level security;
alter table public.categories enable row level security;
alter table public.user_roles enable row level security;
alter table public.alert_thresholds enable row level security;
alter table public.alert_log enable row level security;

create policy "read for known users" on public.contracts
  for select using (public.current_user_role() is not null);
create policy "read for known users" on public.owners
  for select using (public.current_user_role() is not null);
create policy "read for known users" on public.contract_owners
  for select using (public.current_user_role() is not null);
create policy "read for known users" on public.categories
  for select using (public.current_user_role() is not null);
create policy "read own row or admin" on public.user_roles
  for select using (email = auth.jwt() ->> 'email' or public.current_user_role() = 'admin');
create policy "read for known users" on public.alert_thresholds
  for select using (public.current_user_role() is not null);
create policy "read for known users" on public.alert_log
  for select using (public.current_user_role() is not null);

create policy "write for admin/editor" on public.contracts
  for all using (public.current_user_role() in ('admin', 'editor'))
  with check (public.current_user_role() in ('admin', 'editor'));
create policy "write for admin/editor" on public.owners
  for all using (public.current_user_role() in ('admin', 'editor'))
  with check (public.current_user_role() in ('admin', 'editor'));
create policy "write for admin/editor" on public.contract_owners
  for all using (public.current_user_role() in ('admin', 'editor'))
  with check (public.current_user_role() in ('admin', 'editor'));

create policy "admin manages roles" on public.user_roles
  for insert with check (public.current_user_role() = 'admin');
create policy "admin updates roles" on public.user_roles
  for update using (public.current_user_role() = 'admin');
create policy "admin deletes roles" on public.user_roles
  for delete using (public.current_user_role() = 'admin');
create policy "admin manages thresholds" on public.alert_thresholds
  for all using (public.current_user_role() = 'admin')
  with check (public.current_user_role() = 'admin');
create policy "admin manages categories" on public.categories
  for all using (public.current_user_role() = 'admin')
  with check (public.current_user_role() = 'admin');

create policy "no client writes to alert_log" on public.alert_log
  for all using (false) with check (false);

-- Contract files: metadata table; bytes live in the private "contract-files" Storage bucket
-- (created via Storage API, not SQL — see README).
create table public.contract_files (
  id uuid primary key default gen_random_uuid(),
  contract_id uuid not null references public.contracts(id) on delete cascade,
  file_name text not null,
  storage_path text not null,
  file_type text,
  file_size integer,
  created_at timestamptz not null default now()
);

alter table public.contract_files enable row level security;

create policy "read for known users" on public.contract_files
  for select using (public.current_user_role() is not null);

create policy "write for admin/editor" on public.contract_files
  for all using (public.current_user_role() in ('admin', 'editor'))
  with check (public.current_user_role() in ('admin', 'editor'));

-- Gates the actual file bytes in Storage to the same roles (the bucket itself is private)
create policy "read contract files for known users" on storage.objects
  for select using (
    bucket_id = 'contract-files' and public.current_user_role() is not null
  );

create policy "write contract files for admin/editor" on storage.objects
  for insert with check (
    bucket_id = 'contract-files' and public.current_user_role() in ('admin', 'editor')
  );

create policy "update contract files for admin/editor" on storage.objects
  for update using (
    bucket_id = 'contract-files' and public.current_user_role() in ('admin', 'editor')
  );

create policy "delete contract files for admin/editor" on storage.objects
  for delete using (
    bucket_id = 'contract-files' and public.current_user_role() in ('admin', 'editor')
  );

-- Last login tracking, shown on Admin > Access Control
alter table public.user_roles
  add column last_login_at timestamptz;

-- security definer so a user can update only their own last_login_at,
-- without needing broad UPDATE access to user_roles (which could let them touch their own role)
create or replace function public.update_last_login()
returns void
language sql
security definer
set search_path = public
as $$
  update public.user_roles
  set last_login_at = now()
  where email = auth.jwt() ->> 'email';
$$;

grant execute on function public.update_last_login() to authenticated;
