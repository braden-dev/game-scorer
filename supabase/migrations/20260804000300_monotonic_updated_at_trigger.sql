-- Prevent direct or client-supplied timestamps from regressing sync versions.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  if new.updated_at is null or new.updated_at <= old.updated_at then
    new.updated_at = greatest(now(), old.updated_at + interval '1 microsecond');
  end if;
  return new;
end;
$$;
