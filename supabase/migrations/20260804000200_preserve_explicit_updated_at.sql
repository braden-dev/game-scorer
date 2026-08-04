-- Keep server-managed timestamps for updates that do not provide an
-- application version, while preserving explicit versions used by sync.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  if new.updated_at is null or new.updated_at = old.updated_at then
    new.updated_at = now();
  end if;
  return new;
end;
$$;
