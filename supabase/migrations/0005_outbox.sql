-- =====================================================================
-- 0005_outbox.sql
-- Reclamo atomico de eventos del outbox.
--
-- POR QUE HACE FALTA UNA FUNCION Y NO BASTA UN SELECT + UPDATE:
--
-- El worker corre por cron y puede solaparse: una ejecucion que tarda mas de lo
-- previsto se cruza con la siguiente. Con dos consultas separadas (leer los
-- pendientes, luego marcarlos), las dos ejecuciones leen el mismo evento antes de
-- que ninguna lo marque, y el cliente recibe el mismo WhatsApp dos veces.
--
-- `for update skip locked` resuelve exactamente eso: cada worker bloquea las filas
-- que toma y los demas SALTAN las bloqueadas en lugar de esperarlas. Sin
-- `skip locked` el segundo worker se quedaria esperando el bloqueo y acabaria
-- procesando los mismos eventos al liberarse.
--
-- Aplicar DESPUES de 0001_schema.sql.
-- =====================================================================

-- ---------------------------------------------------------------------
-- claim_outbox_events(p_limite)
--
-- Toma hasta `p_limite` eventos pendientes cuyo `procesar_despues_de` ya vencio,
-- los marca como 'procesando' y los devuelve. Atomico: dos llamadas concurrentes
-- nunca devuelven el mismo evento.
-- ---------------------------------------------------------------------

create or replace function claim_outbox_events(p_limite integer default 20)
returns table (
  id      uuid,
  tipo    text,
  payload jsonb,
  intentos integer
)
language plpgsql
security definer
set search_path = public
as $fn$
begin
  return query
  with candidatos as (
    select o.id
    from outbox o
    where o.status = 'pendiente'
      and o.procesar_despues_de <= now()
    -- Orden FIFO: el evento mas antiguo primero. Un cliente que pago hace diez
    -- minutos no puede esperar detras de uno que acaba de pagar.
    order by o.procesar_despues_de asc, o.created_at asc
    limit greatest(1, least(p_limite, 100))
    for update skip locked
  )
  update outbox o
     set status = 'procesando'
    from candidatos c
   where o.id = c.id
  returning o.id, o.tipo, o.payload, o.intentos;
end;
$fn$;

comment on function claim_outbox_events(integer) is
  'Reclama eventos pendientes del outbox de forma atomica con for update skip locked. Evita que dos workers concurrentes manden el mismo mensaje dos veces.';

revoke all on function claim_outbox_events(integer) from public;
grant execute on function claim_outbox_events(integer) to service_role;

-- ---------------------------------------------------------------------
-- release_outbox_event(p_id, p_ok, p_error, p_espera_segundos)
--
-- Cierra un evento reclamado. Si `p_ok` es true lo marca 'enviado'; si no, lo
-- devuelve a 'pendiente' con el contador incrementado y la espera aplicada, o lo
-- marca 'fallido' cuando el llamador decide abandonarlo (p_espera_segundos null).
-- ---------------------------------------------------------------------

create or replace function release_outbox_event(
  p_id               uuid,
  p_ok               boolean,
  p_error            text default null,
  p_espera_segundos  integer default null
)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if p_ok then
    update outbox
       set status = 'enviado',
           intentos = intentos + 1,
           ultimo_error = null
     where id = p_id;
    return;
  end if;

  -- Sin espera indicada, el llamador decidio que el fallo no es transitorio.
  if p_espera_segundos is null then
    update outbox
       set status = 'fallido',
           intentos = intentos + 1,
           ultimo_error = left(coalesce(p_error, 'sin detalle'), 1000)
     where id = p_id;
    return;
  end if;

  update outbox
     set status = 'pendiente',
         intentos = intentos + 1,
         ultimo_error = left(coalesce(p_error, 'sin detalle'), 1000),
         procesar_despues_de = now() + make_interval(secs => p_espera_segundos)
   where id = p_id;
end;
$fn$;

comment on function release_outbox_event(uuid, boolean, text, integer) is
  'Cierra un evento del outbox: enviado, reintento programado, o fallido definitivo. El truncado de ultimo_error evita que una traza enorme infle la tabla.';

revoke all on function release_outbox_event(uuid, boolean, text, integer) from public;
grant execute on function release_outbox_event(uuid, boolean, text, integer) to service_role;

-- ---------------------------------------------------------------------
-- recover_stuck_outbox_events(p_minutos)
--
-- Devuelve a 'pendiente' los eventos que quedaron en 'procesando'.
--
-- POR QUE ES NECESARIA: si el worker muere a mitad (timeout de la funcion
-- serverless, reinicio del proceso), el evento se queda en 'procesando' para
-- siempre y nadie lo vuelve a tomar. El cliente nunca recibe su aviso y no hay
-- ningun error visible en ningun sitio: es el peor tipo de fallo, silencioso.
-- ---------------------------------------------------------------------

create or replace function recover_stuck_outbox_events(p_minutos integer default 15)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_recuperados integer;
begin
  update outbox
     set status = 'pendiente',
         ultimo_error = 'recuperado: el worker no cerro el evento'
   where status = 'procesando'
     -- `created_at` como referencia porque la tabla no guarda cuando se reclamo.
     -- Es conservador: un evento reclamado hace poco pero creado hace mucho se
     -- recupera antes de tiempo, y como el reclamo es atomico eso solo puede
     -- generar un reintento de mas, nunca un mensaje duplicado en vuelo.
     and created_at < now() - make_interval(mins => greatest(1, p_minutos));

  get diagnostics v_recuperados = row_count;
  return v_recuperados;
end;
$fn$;

comment on function recover_stuck_outbox_events(integer) is
  'Rescata eventos que quedaron en procesando porque el worker murio a mitad. Sin esto, el aviso se pierde en silencio.';

revoke all on function recover_stuck_outbox_events(integer) from public;
grant execute on function recover_stuck_outbox_events(integer) to service_role;

-- ---------------------------------------------------------------------
-- Indice de apoyo
--
-- El indice parcial de 0001 cubre (procesar_despues_de) where status =
-- 'pendiente'. Se agrega uno para la recuperacion de 'procesando', que es una
-- consulta distinta y sin indice recorreria la tabla completa.
-- ---------------------------------------------------------------------

create index if not exists ix_outbox_procesando
  on outbox (created_at)
  where status = 'procesando';

-- ---------------------------------------------------------------------
-- Agenda del procesado
--
-- OPCION A (recomendada): pg_cron + pg_net, desde Supabase.
--
-- Es la buena si el proyecto esta en el plan Hobby de Vercel, que solo admite
-- UNA ejecucion de cron al dia. Un outbox que se procesa una vez al dia no sirve:
-- el cliente pagaria por la manana y recibiria la confirmacion al dia siguiente.
-- Supabase permite cron cada minuto sin coste.
--
-- Requiere activar las dos extensiones en Database > Extensions y sustituir el
-- dominio y el secreto por los reales:
--
--   create extension if not exists pg_cron;
--   create extension if not exists pg_net;
--
--   select cron.schedule(
--     'procesar-outbox',
--     '*/5 * * * *',
--     $$
--     select net.http_get(
--       url := 'https://TU-DOMINIO.vercel.app/api/cron/outbox',
--       headers := '{"Authorization": "Bearer TU_CRON_SECRET"}'::jsonb
--     );
--     $$
--   );
--
-- El secreto queda guardado en la definicion del job, visible para cualquiera con
-- acceso al panel de Supabase. Es el mismo nivel de acceso que ya permite leer la
-- base entera, asi que no anade exposicion; aun asi, conviene rotarlo si alguien
-- pierde el acceso al proyecto.
--
-- Para ver los jobs agendados y su historial. Ojo: `cron.job_run_details` NO tiene
-- columna `jobname`, solo `jobid`; hay que unirla con `cron.job` para saber a que
-- job corresponde cada ejecucion.
--
--   select jobid, jobname, schedule, active from cron.job;
--
--   select j.jobname, d.status, d.return_message, d.start_time
--     from cron.job_run_details d
--     join cron.job j on j.jobid = d.jobid
--    order by d.start_time desc
--    limit 20;
--
-- OPCION B: cron de Vercel (vercel.json). En Hobby queda limitado a una vez al
-- dia, lo que solo vale como red de seguridad, no como procesado principal.
--
-- EN CUALQUIER CASO, agendar tambien el rescate de eventos atascados:
--
--   select cron.schedule('recuperar-outbox', '*/10 * * * *',
--     $$select recover_stuck_outbox_events(15)$$);
--
-- Este si puede correr dentro de Postgres sin salir a internet, porque solo
-- devuelve filas a 'pendiente'.
-- ---------------------------------------------------------------------
