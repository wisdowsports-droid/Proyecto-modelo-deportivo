-- Pausa por calendario. Las tareas diarias de historial solo corren si la
-- competicion tuvo partidos en los ultimos 3 dias o tiene en los proximos 10
-- (fuera de temporada o terminada la fecha FIFA no hacen nada y vuelven solas).
-- sync-fixtures ademas consulta /events (gratis) y no gasta el credito de
-- /odds en competiciones sin partidos en los proximos 10 dias.
create or replace function competition_active(p_sport text, p_leagues text[] default null,
                                               days_back int default 3, days_ahead int default 10)
returns boolean language sql stable as $$
  select exists (
    select 1 from fixtures f
    where f.sport = p_sport
      and (p_leagues is null or f.league = any(p_leagues))
      and f.status in ('scheduled', 'finished')
      and f.commence_time between now() - make_interval(days => days_back) and now() + make_interval(days => days_ahead)
  );
$$;

do $$
declare j record; cond text; body text;
begin
  for j in select jobid, jobname, command from cron.job loop
    cond := case j.jobname
      when 'sync-history-football-data-co-uk-daily' then $c$competition_active('soccer', array['EPL','La Liga - Spain','Serie A - Italy','Bundesliga - Germany','Ligue 1 - France'])$c$
      when 'sync-history-football-data-org-daily'   then $c$competition_active('soccer', array['UEFA Champions League'])$c$
      when 'sync-history-international-daily'       then $c$competition_active('soccer', array['UEFA Nations League'])$c$
      when 'sync-history-mlb-daily'                 then $c$competition_active('baseball')$c$
      when 'sync-history-nfl-daily'                 then $c$competition_active('football')$c$
      when 'sync-history-nba-daily'                 then $c$competition_active('basketball', array['NBA'])$c$
      when 'sync-history-wnba-daily'                then $c$competition_active('basketball', array['WNBA'])$c$
      else null end;
    if cond is null or position('competition_active' in j.command) > 0 then continue; end if;
    body := regexp_replace(j.command, '^\s*select\s+net\.http_post', 'perform net.http_post', 'i');
    perform cron.alter_job(j.jobid, command := 'do $job$ begin if ' || cond || ' then ' || body || ' end if; end $job$;');
  end loop;
end $$;
