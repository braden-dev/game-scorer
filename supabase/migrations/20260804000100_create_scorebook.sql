create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.people (
  id text primary key,
  name text not null check (char_length(name) between 1 and 80 and char_length(btrim(name)) >= 1),
  normalized_name text not null check (char_length(normalized_name) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists people_name_search_idx
  on public.people (normalized_name)
  where deleted_at is null;

create table if not exists public.games (
  id text primary key,
  game_id text not null check (game_id in ('farkle', 'dutch-blitz', 'three-thirteen')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  settings jsonb not null default '{}'::jsonb,
  deleted_at timestamptz
);

create index if not exists games_updated_idx on public.games (updated_at);
create index if not exists games_finished_idx on public.games (finished_at) where deleted_at is null;

create table if not exists public.game_players (
  game_id text not null references public.games(id) on delete restrict,
  person_id text not null references public.people(id) on delete restrict,
  seat_order integer not null check (seat_order >= 0),
  name_snapshot text not null check (char_length(name_snapshot) between 1 and 80 and char_length(btrim(name_snapshot)) >= 1),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (game_id, person_id)
);

alter table public.game_players
  add column if not exists updated_at timestamptz not null default now();
alter table public.game_players
  add column if not exists deleted_at timestamptz;

create index if not exists game_players_person_idx on public.game_players (person_id);

create table if not exists public.rounds (
  id text primary key,
  game_id text not null references public.games(id) on delete restrict,
  round_index integer not null check (round_index >= 0),
  entries jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (game_id, round_index)
);

drop index if exists public.rounds_game_idx;

drop trigger if exists people_set_updated_at on public.people;
create trigger people_set_updated_at
before update on public.people
for each row execute function public.set_updated_at();

drop trigger if exists games_set_updated_at on public.games;
create trigger games_set_updated_at
before update on public.games
for each row execute function public.set_updated_at();

drop trigger if exists game_players_set_updated_at on public.game_players;
create trigger game_players_set_updated_at
before update on public.game_players
for each row execute function public.set_updated_at();

drop trigger if exists rounds_set_updated_at on public.rounds;
create trigger rounds_set_updated_at
before update on public.rounds
for each row execute function public.set_updated_at();

grant select, insert, update, delete on public.people to anon, authenticated;
grant select, insert, update, delete on public.games to anon, authenticated;
grant select, insert, update, delete on public.game_players to anon, authenticated;
grant select, insert, update, delete on public.rounds to anon, authenticated;

alter table public.people enable row level security;
alter table public.games enable row level security;
alter table public.game_players enable row level security;
alter table public.rounds enable row level security;

drop policy if exists people_public_select on public.people;
create policy people_public_select on public.people for select to anon, authenticated using (true);
drop policy if exists people_public_insert on public.people;
create policy people_public_insert on public.people for insert to anon, authenticated with check (true);
drop policy if exists people_public_update on public.people;
create policy people_public_update on public.people for update to anon, authenticated using (true) with check (true);
drop policy if exists people_public_delete on public.people;
create policy people_public_delete on public.people for delete to anon, authenticated using (true);

drop policy if exists games_public_select on public.games;
create policy games_public_select on public.games for select to anon, authenticated using (true);
drop policy if exists games_public_insert on public.games;
create policy games_public_insert on public.games for insert to anon, authenticated with check (true);
drop policy if exists games_public_update on public.games;
create policy games_public_update on public.games for update to anon, authenticated using (true) with check (true);
drop policy if exists games_public_delete on public.games;
create policy games_public_delete on public.games for delete to anon, authenticated using (true);

drop policy if exists game_players_public_select on public.game_players;
create policy game_players_public_select on public.game_players for select to anon, authenticated using (true);
drop policy if exists game_players_public_insert on public.game_players;
create policy game_players_public_insert on public.game_players for insert to anon, authenticated with check (true);
drop policy if exists game_players_public_update on public.game_players;
create policy game_players_public_update on public.game_players for update to anon, authenticated using (true) with check (true);
drop policy if exists game_players_public_delete on public.game_players;
create policy game_players_public_delete on public.game_players for delete to anon, authenticated using (true);

drop policy if exists rounds_public_select on public.rounds;
create policy rounds_public_select on public.rounds for select to anon, authenticated using (true);
drop policy if exists rounds_public_insert on public.rounds;
create policy rounds_public_insert on public.rounds for insert to anon, authenticated with check (true);
drop policy if exists rounds_public_update on public.rounds;
create policy rounds_public_update on public.rounds for update to anon, authenticated using (true) with check (true);
drop policy if exists rounds_public_delete on public.rounds;
create policy rounds_public_delete on public.rounds for delete to anon, authenticated using (true);
