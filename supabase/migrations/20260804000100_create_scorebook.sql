create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table public.people (
  id text primary key,
  name text not null check (char_length(btrim(name)) between 1 and 80),
  normalized_name text not null check (char_length(normalized_name) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index people_name_search_idx
  on public.people (normalized_name)
  where deleted_at is null;

create table public.games (
  id text primary key,
  game_id text not null check (game_id in ('farkle', 'dutch-blitz', 'three-thirteen')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  settings jsonb not null default '{}'::jsonb,
  deleted_at timestamptz
);

create index games_updated_idx on public.games (updated_at);
create index games_finished_idx on public.games (finished_at) where deleted_at is null;

create table public.game_players (
  game_id text not null references public.games(id) on delete restrict,
  person_id text not null references public.people(id) on delete restrict,
  seat_order integer not null check (seat_order >= 0),
  name_snapshot text not null check (char_length(btrim(name_snapshot)) between 1 and 80),
  primary key (game_id, person_id)
);

create index game_players_person_idx on public.game_players (person_id);

create table public.rounds (
  id text primary key,
  game_id text not null references public.games(id) on delete restrict,
  round_index integer not null check (round_index >= 0),
  entries jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (game_id, round_index)
);

create index rounds_game_idx on public.rounds (game_id, round_index);

create trigger people_set_updated_at
before update on public.people
for each row execute function public.set_updated_at();

create trigger games_set_updated_at
before update on public.games
for each row execute function public.set_updated_at();

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

create policy people_public_select on public.people for select to anon, authenticated using (true);
create policy people_public_insert on public.people for insert to anon, authenticated with check (true);
create policy people_public_update on public.people for update to anon, authenticated using (true) with check (true);
create policy people_public_delete on public.people for delete to anon, authenticated using (true);

create policy games_public_select on public.games for select to anon, authenticated using (true);
create policy games_public_insert on public.games for insert to anon, authenticated with check (true);
create policy games_public_update on public.games for update to anon, authenticated using (true) with check (true);
create policy games_public_delete on public.games for delete to anon, authenticated using (true);

create policy game_players_public_select on public.game_players for select to anon, authenticated using (true);
create policy game_players_public_insert on public.game_players for insert to anon, authenticated with check (true);
create policy game_players_public_update on public.game_players for update to anon, authenticated using (true) with check (true);
create policy game_players_public_delete on public.game_players for delete to anon, authenticated using (true);

create policy rounds_public_select on public.rounds for select to anon, authenticated using (true);
create policy rounds_public_insert on public.rounds for insert to anon, authenticated with check (true);
create policy rounds_public_update on public.rounds for update to anon, authenticated using (true) with check (true);
create policy rounds_public_delete on public.rounds for delete to anon, authenticated using (true);
