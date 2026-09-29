-- Un solo falso positivo encontrado en la auditoria manual del 2026-09-23:
-- "Paris FC" (target, se reduce a un solo token "paris" al quitar el
-- sufijo FC) calzaba por contencion de subconjunto contra "Paris Saint
-- Germain" -- son clubes distintos, PSG no tiene nada que ver con Paris FC.
-- Se bloquea explicitamente en vez de inventar una regla general que
-- podria romper coincidencias buenas (ej. "Servette"->"Servette Chenois W",
-- "Osasuna"<-"CA Osasuna"), siguiendo el mismo criterio de este proyecto:
-- nunca adivinar, corregir casos concretos encontrados de verdad.
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
    and (target <@ normalize_team_tokens(team) or normalize_team_tokens(team) <@ target)
    and not (p_team_name = 'Paris FC' and team = 'Paris Saint Germain');

  if array_length(subset_matches,1) = 1 then return subset_matches[1]; end if;
  return null;
end;
$$;
