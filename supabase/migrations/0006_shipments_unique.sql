-- =====================================================================
-- 0006_shipments_unique.sql
-- Un envio por pedido: restriccion unica sobre shipments.order_id.
--
-- EL BUG QUE ARREGLA:
--
-- `registrarEnvio` guarda los datos de la guia con un upsert sobre `order_id`,
-- para que el admin pueda corregir un numero mal tecleado sin crear un segundo
-- envio del mismo pedido. Pero `on conflict (order_id)` exige que exista un indice
-- UNICO sobre esa columna, y 0001 solo creo un indice normal.
--
-- Sin la restriccion, Postgres responde 42P10 ("there is no unique or exclusion
-- constraint matching the ON CONFLICT specification") y el panel mostraba
-- "No pudimos guardar los datos del envio" sin mas pistas.
--
-- Ademas de arreglar el upsert, la restriccion expresa una regla real del dominio:
-- un pedido tiene un envio. Dos filas de envio para el mismo pedido significarian
-- dos guias, y el cliente recibiria dos codigos de rastreo distintos para un solo
-- paquete.
--
-- Aplicar DESPUES de 0001_schema.sql.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Paso 1: eliminar duplicados previos.
--
-- Si algun pedido ya tiene mas de un envio (posible porque hasta ahora nada lo
-- impedia), la restriccion no se puede crear. Se conserva el mas reciente: es el
-- que refleja la ultima correccion del admin.
-- ---------------------------------------------------------------------

delete from shipments s
where exists (
  select 1
  from shipments otro
  where otro.order_id = s.order_id
    and (otro.updated_at, otro.id) > (s.updated_at, s.id)
);

-- ---------------------------------------------------------------------
-- Paso 2: la restriccion.
--
-- Se crea como constraint y no solo como indice para que el nombre aparezca en los
-- mensajes de error de Postgres, lo que hace evidente la causa la proxima vez.
-- ---------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'ux_shipments_order_id'
  ) then
    alter table shipments
      add constraint ux_shipments_order_id unique (order_id);
  end if;
end
$$;

comment on constraint ux_shipments_order_id on shipments is
  'Un envio por pedido. Necesaria para el upsert on conflict (order_id) del panel, y regla del dominio: dos filas significarian dos guias para un solo paquete.';

-- El indice normal de 0001 queda redundante: la restriccion unica ya crea el suyo,
-- y mantener dos indices sobre la misma columna solo cuesta escrituras.
drop index if exists ix_shipments_order_id;
