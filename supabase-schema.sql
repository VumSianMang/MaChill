-- ============================================================================
-- MaChill — Supabase schema
-- Run this once in Supabase Dashboard → SQL Editor → New query → Run.
-- Safe to re-run top to bottom on a fresh project (uses IF NOT EXISTS /
-- CREATE OR REPLACE throughout).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- profiles: one row per signed-in user, auto-created by a trigger below.
-- ---------------------------------------------------------------------------
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Guest',
  avatar_url text,
  machill_id text unique not null,
  created_at timestamptz not null default now()
);

-- Generates a short, unique, human-shareable ID like "K3F9" (no 0/O/1/I).
create or replace function generate_machill_id() returns text as $$
declare
  chars text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  candidate text;
  i int;
  tries int := 0;
begin
  loop
    candidate := '';
    for i in 1..5 loop
      candidate := candidate || substr(chars, floor(random() * length(chars) + 1)::int, 1);
    end loop;
    exit when not exists (select 1 from profiles where machill_id = candidate);
    tries := tries + 1;
    exit when tries > 25; -- astronomically unlikely, but don't loop forever
  end loop;
  return candidate;
end;
$$ language plpgsql;

-- Auto-creates a profile (with a fresh MaChill ID) the moment someone signs
-- in for the first time — no client-side race condition to worry about.
create or replace function handle_new_user() returns trigger as $$
begin
  insert into public.profiles (id, display_name, avatar_url, machill_id)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', 'Guest'),
    new.raw_user_meta_data->>'avatar_url',
    generate_machill_id()
  )
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------------------------------------------------------------------------
-- groups + membership
-- ---------------------------------------------------------------------------
create table if not exists groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid not null references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists group_members (
  group_id uuid not null references groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

-- ---------------------------------------------------------------------------
-- saved chat
-- ---------------------------------------------------------------------------
create table if not exists group_messages (
  id bigint generated always as identity primary key,
  group_id uuid not null references groups(id) on delete cascade,
  user_id uuid not null references auth.users(id),
  name text,
  photo_url text,
  text text not null,
  created_at timestamptz not null default now()
);
create index if not exists group_messages_group_idx on group_messages(group_id, created_at);

-- ---------------------------------------------------------------------------
-- who's currently in the watch session's call (separate from group_members,
-- which is permanent)
-- ---------------------------------------------------------------------------
create table if not exists call_members (
  group_id uuid not null references groups(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text,
  avatar_url text,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

-- ---------------------------------------------------------------------------
-- one live watch-session row per group: active flag, what's playing, who's
-- presenting, and the shared playback clock.
-- ---------------------------------------------------------------------------
create table if not exists watch_sessions (
  group_id uuid primary key references groups(id) on delete cascade,
  active boolean not null default false,
  media_mode text,
  presenter_id uuid references auth.users(id),
  started_by uuid references auth.users(id),
  started_at timestamptz,
  playback jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Atomically merges a partial patch into playback (like Firestore's dotted-
-- path merge) instead of a read-modify-write race from the client.
create or replace function merge_playback(p_group_id uuid, p_patch jsonb, p_updated_by uuid)
returns void as $$
begin
  insert into watch_sessions (group_id, playback)
  values (p_group_id, '{}'::jsonb)
  on conflict (group_id) do nothing;

  update watch_sessions
  set playback = coalesce(playback, '{}'::jsonb)
                 || p_patch
                 || jsonb_build_object('updatedBy', p_updated_by, 'updatedAt', extract(epoch from now())),
      updated_at = now()
  where group_id = p_group_id;
end;
$$ language plpgsql security definer set search_path = public;

-- ---------------------------------------------------------------------------
-- WebRTC signaling (offer/answer/ICE), one row per (group, pair, kind).
-- channel_key exists purely so Realtime — which only filters on a single
-- column — can subscribe to exactly one pair's signaling.
-- ---------------------------------------------------------------------------
create table if not exists signals (
  group_id uuid not null references groups(id) on delete cascade,
  pair_key text not null,       -- sorted "uidA_uidB"
  kind text not null,           -- "cam" | "screen"
  channel_key text generated always as (group_id::text || '_' || pair_key || '_' || kind) stored,
  offer jsonb,
  answer jsonb,
  candidates_a jsonb not null default '[]'::jsonb,
  candidates_b jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (group_id, pair_key, kind)
);
create unique index if not exists signals_channel_key_idx on signals(channel_key);

-- Atomic ICE candidate append — avoids a read-modify-write race when both
-- sides are trickling candidates at once.
create or replace function append_candidate(
  p_group_id uuid, p_pair_key text, p_kind text, p_field text, p_candidate jsonb
) returns void as $$
begin
  insert into signals (group_id, pair_key, kind)
  values (p_group_id, p_pair_key, p_kind)
  on conflict (group_id, pair_key, kind) do nothing;

  if p_field = 'candidates_a' then
    update signals set candidates_a = candidates_a || jsonb_build_array(p_candidate), updated_at = now()
    where group_id = p_group_id and pair_key = p_pair_key and kind = p_kind;
  else
    update signals set candidates_b = candidates_b || jsonb_build_array(p_candidate), updated_at = now()
    where group_id = p_group_id and pair_key = p_pair_key and kind = p_kind;
  end if;
end;
$$ language plpgsql security definer set search_path = public;

-- ============================================================================
-- Row Level Security — same "permissive-but-authenticated" posture as the
-- Firebase version: any signed-in user can read most things (that's what
-- makes search, invite links, and shared playback control work), but people
-- can only ever write their own rows, except group owners can also add
-- members when creating a group.
-- ============================================================================

alter table profiles enable row level security;
alter table groups enable row level security;
alter table group_members enable row level security;
alter table group_messages enable row level security;
alter table call_members enable row level security;
alter table watch_sessions enable row level security;
alter table signals enable row level security;

drop policy if exists "profiles read" on profiles;
create policy "profiles read" on profiles for select using (auth.role() = 'authenticated');
drop policy if exists "profiles update own" on profiles;
create policy "profiles update own" on profiles for update using (auth.uid() = id);

drop policy if exists "groups read" on groups;
create policy "groups read" on groups for select using (auth.role() = 'authenticated');
drop policy if exists "groups insert own" on groups;
create policy "groups insert own" on groups for insert with check (auth.uid() = owner_id);
drop policy if exists "groups update owner" on groups;
create policy "groups update owner" on groups for update using (auth.uid() = owner_id);

drop policy if exists "members read" on group_members;
create policy "members read" on group_members for select using (auth.role() = 'authenticated');
drop policy if exists "members insert self or owner" on group_members;
create policy "members insert self or owner" on group_members for insert with check (
  auth.uid() = user_id
  or exists (select 1 from groups g where g.id = group_id and g.owner_id = auth.uid())
);
drop policy if exists "members update self" on group_members;
create policy "members update self" on group_members for update using (auth.uid() = user_id);
drop policy if exists "members delete self" on group_members;
create policy "members delete self" on group_members for delete using (auth.uid() = user_id);

drop policy if exists "messages read" on group_messages;
create policy "messages read" on group_messages for select using (auth.role() = 'authenticated');
drop policy if exists "messages insert own" on group_messages;
create policy "messages insert own" on group_messages for insert with check (auth.uid() = user_id);

drop policy if exists "callmembers read" on call_members;
create policy "callmembers read" on call_members for select using (auth.role() = 'authenticated');
drop policy if exists "callmembers write own" on call_members;
create policy "callmembers write own" on call_members for insert with check (auth.uid() = user_id);
drop policy if exists "callmembers update own" on call_members;
create policy "callmembers update own" on call_members for update using (auth.uid() = user_id);
drop policy if exists "callmembers delete own" on call_members;
create policy "callmembers delete own" on call_members for delete using (auth.uid() = user_id);

drop policy if exists "session read" on watch_sessions;
create policy "session read" on watch_sessions for select using (auth.role() = 'authenticated');
drop policy if exists "session write" on watch_sessions;
create policy "session write" on watch_sessions for insert with check (auth.role() = 'authenticated');
drop policy if exists "session update" on watch_sessions;
create policy "session update" on watch_sessions for update using (auth.role() = 'authenticated');

drop policy if exists "signals read" on signals;
create policy "signals read" on signals for select using (auth.role() = 'authenticated');
drop policy if exists "signals write" on signals;
create policy "signals write" on signals for insert with check (auth.role() = 'authenticated');
drop policy if exists "signals update" on signals;
create policy "signals update" on signals for update using (auth.role() = 'authenticated');

-- ============================================================================
-- Realtime: tell Supabase to stream changes on these tables.
-- (Dashboard → Database → Replication also works instead of this block.)
-- ============================================================================
alter publication supabase_realtime add table group_messages;
alter publication supabase_realtime add table watch_sessions;
alter publication supabase_realtime add table call_members;
alter publication supabase_realtime add table group_members;
alter publication supabase_realtime add table signals;
