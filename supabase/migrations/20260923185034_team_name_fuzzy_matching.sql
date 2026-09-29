create extension if not exists unaccent;

-- Normaliza un nombre de equipo a un arreglo de tokens comparables entre
-- proveedores distintos (api-football vs The Odds API nombran diferente):
-- sin acentos, minusculas, sin puntos/guiones/parentesis, sin sufijos
-- decorativos de tipo de club (FC/CF/SC/AFC) ni la marca de femenino "W".
-- Deliberadamente NO se quitan prefijos como "AS"/"CA"/"Real" -- esos se
-- resuelven solos por contencion de subconjuntos sin arriesgar falsos
-- positivos (ver comentario en match_team_strength mas abajo).
create or replace function normalize_team_tokens(name text)
returns text[] language sql immutable as $$
  select array_remove(
    array(
      select t from unnest(
        string_to_array(
          regexp_replace(
            lower(unaccent(name)), '[.\-()]', ' ', 'g'
          ), ' '
        )
      ) as t
      where t <> '' and t not in ('fc','cf','sc','afc','w')
    ), null
  )
$$;

-- Empareja el nombre de un fixture contra team_strengths de su misma liga.
-- Primero intenta match EXACTO de los tokens normalizados; si no hay,
-- intenta contencion de subconjunto en cualquier direccion (para prefijos
-- decorativos como "AS Roma" -> "Roma W", o sufijos de sede como
-- "CA Osasuna" -> "Osasuna"). Si mas de un equipo de la liga calza, o
-- ninguno, devuelve NULL -- nunca adivina.
create or replace function match_team_strength(p_league text, p_team_name text)
returns text language plpgsql stable as $$
declare
  target text[] := normalize_team_tokens(p_team_name);
  exact_matches text[];
  subset_matches text[];
begin
  if target is null or array_length(target,1) is null then return null; end if;

  select array_agg(team) into exact_matches
  from team_strengths
  where league = p_league and normalize_team_tokens(team) = target;

  if array_length(exact_matches,1) = 1 then return exact_matches[1]; end if;
  if array_length(exact_matches,1) > 1 then return null; end if;

  select array_agg(team) into subset_matches
  from team_strengths
  where league = p_league
    and (target <@ normalize_team_tokens(team) or normalize_team_tokens(team) <@ target);

  if array_length(subset_matches,1) = 1 then return subset_matches[1]; end if;
  return null;
end;
$$;
