-- Suscriptores Pro: cada uno tiene su propia llave de acceso, con fecha de vencimiento.
-- El administrador (owner_key) los gestiona desde el panel de la pagina (funcion pro-admin).
create extension if not exists pgcrypto;

create table if not exists public.pro_members (
  id bigserial primary key,
  tg_user_id bigint unique,
  name text,
  username text,
  access_key text not null unique default encode(gen_random_bytes(24), 'hex'),
  price integer,
  paid_until date,
  status text not null default 'active',   -- active | revoked
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.pro_members enable row level security;
revoke all on public.pro_members from anon, authenticated;

-- 'owner' (administrador), 'member' (suscriptor activo y al dia) o null (sin acceso)
create or replace function public.pro_role(p_key text)
returns text language sql stable security definer set search_path to 'public' as $$
  select case
    when length(coalesce(p_key, '')) < 32 then null
    when exists (select 1 from app_settings where key = 'owner_key' and value = p_key) then 'owner'
    when exists (select 1 from pro_members where access_key = p_key and status = 'active'
                 and paid_until >= (now() at time zone 'America/Bogota')::date) then 'member'
  end;
$$;
revoke execute on function public.pro_role(text) from public, anon, authenticated;

-- las funciones Pro aceptan dueno o suscriptor al dia; owner_board ademas devuelve el rol
do $$
declare fn text; src text;
  old_gate text := $g$with ok as (select 1 from app_settings where key='owner_key' and value = p_key and length(coalesce(p_key,''))>=32)$g$;
  new_gate text := $g$with ok as (select 1 where public.pro_role(p_key) is not null)$g$;
begin
  foreach fn in array array['owner_board(text)', 'owner_bp_value(text)', 'owner_selection(text)'] loop
    src := pg_get_functiondef(('public.' || fn)::regprocedure);
    src := replace(src, old_gate, new_gate);
    if fn = 'owner_board(text)' and position('''role''' in src) = 0 then
      src := replace(src, 'jsonb_build_object(' || chr(10) || '    ''upcoming'',', 'jsonb_build_object(' || chr(10) || '    ''role'', public.pro_role(p_key),' || chr(10) || '    ''upcoming'',');
    end if;
    execute src;
  end loop;
end $$;
