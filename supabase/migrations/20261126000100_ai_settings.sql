-- On/off switch for automatic AI evidence checks, set by the Learning Team in
-- Settings. checks_enabled null = nobody has set it yet, so the server's
-- AI_VERIFICATION_ENABLED default applies. The AI key stays in the server's .env.

create table if not exists ai_settings (
  id             smallint primary key default 1 check (id = 1),
  checks_enabled boolean,
  updated_by     uuid references profiles (id) on delete set null,
  updated_at     timestamptz
);

insert into ai_settings (id) values (1) on conflict (id) do nothing;

alter table ai_settings enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on ai_settings from anon, authenticated';
  end if;
end;
$$;
