-- =====================================================================
-- 0007_product_media.sql
-- Bucket de fotos de producto y trigger de imagen principal unica.
--
-- POR QUE ESTE BUCKET SI ES PUBLICO, al contrario del de vouchers:
--
-- Una foto de producto es material de marketing: existe para que la vea
-- cualquiera, se indexa en Google Imagenes y se sirve desde el CDN sin pasar por
-- el servidor. Un bucket privado obligaria a firmar una URL por cada foto en cada
-- visita al catalogo: mas latencia, mas peticiones y ninguna proteccion real,
-- porque el contenido no es sensible.
--
-- El voucher de Yape es lo contrario (datos personales del pagador) y por eso su
-- bucket es privado. La diferencia de trato entre los dos buckets es deliberada,
-- no una inconsistencia.
--
-- LO QUE SIGUE SIENDO PRIVADO AQUI: la ESCRITURA. No hay politica de INSERT para
-- anon ni para authenticated. Las subidas van con la service_role key desde el
-- servidor, que valida los magic bytes antes de guardar. Un bucket publico de
-- lectura con escritura abierta seria alojamiento gratuito de cualquier archivo
-- con el dominio del negocio dandole credibilidad.
--
-- Aplicar DESPUES de 0002_rls.sql (las politicas usan public.is_admin()).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Bucket
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'productos',
  'productos',
  -- PUBLICO en lectura. Ver la cabecera.
  true,
  -- 8 MB: una foto de producto es mas grande que un screenshot de Yape, pero
  -- 8 MB ya es una foto de camara sin optimizar. El limite frena que el catalogo
  -- se llene de archivos de 40 MB que el movil del cliente tenga que descargar.
  8388608,
  array['image/jpeg', 'image/png', 'image/webp', 'image/avif']
)
on conflict (id) do update set
  public = true,
  file_size_limit = 8388608,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/avif'];

-- ---------------------------------------------------------------------
-- Politicas
--
-- Igual que en 0004_storage.sql, la creacion va envuelta en un bloque que avisa
-- en lugar de abortar: `storage.objects` pertenece a supabase_storage_admin y en
-- algunos proyectos rechaza CREATE POLICY desde el SQL Editor. El bucket queda
-- creado en cualquier caso, y con `public = true` la lectura ya funciona sin
-- politica.
-- ---------------------------------------------------------------------

do $$
begin
  begin
    -- Borrado: solo admins, para poder quitar una foto equivocada.
    drop policy if exists "productos_delete_admin" on storage.objects;
    create policy "productos_delete_admin"
      on storage.objects for delete
      using (bucket_id = 'productos' and public.is_admin());
  exception
    when insufficient_privilege then
      raise warning 'No se pudo crear la politica de DELETE sobre storage.objects para el bucket productos. Crearla desde el panel: Storage > Policies. El bucket SI quedo creado y publico en lectura.';
  end;
end
$$;

-- ---------------------------------------------------------------------
-- Una sola imagen principal por producto
--
-- POR QUE UN INDICE Y NO CODIGO DE APLICACION: `es_principal` decide que foto se
-- ve en la tarjeta del catalogo. Con dos filas marcadas, la elegida depende del
-- orden de la consulta, es decir, cambia sin motivo aparente entre recargas. Con
-- cero, la tarjeta sale sin foto.
--
-- El indice parcial unico convierte "dos principales" en un error 23505 que la
-- aplicacion puede tratar, en vez de en un catalogo que parpadea.
-- ---------------------------------------------------------------------

-- Antes del indice hay que dejar una sola principal por producto: si el catalogo
-- actual tiene dos, la creacion falla. Se conserva la de menor `orden`.
update product_images pi
   set es_principal = false
 where pi.es_principal = true
   and exists (
     select 1
     from product_images otra
     where otra.product_id = pi.product_id
       and otra.es_principal = true
       and (otra.orden, otra.created_at, otra.id) < (pi.orden, pi.created_at, pi.id)
   );

create unique index if not exists ux_product_images_principal
  on product_images (product_id)
  where es_principal = true;

comment on index ux_product_images_principal is
  'Una sola foto principal por producto. Sin esto, la foto de la tarjeta del catalogo depende del orden de la consulta y cambia entre recargas.';

-- ---------------------------------------------------------------------
-- Movimientos de inventario
--
-- LA DEUDA QUE CIERRA: hasta ahora un ajuste de stock sobrescribia la columna
-- `variants.stock` sin dejar rastro. Con eso, un descuadre entre lo que dice el
-- sistema y lo que hay en el almacen es IRRECONSTRUIBLE: no se puede saber si
-- fueron cinco ventas, un ajuste mal tecleado o un par que se perdio.
--
-- La tabla es append-only por el mismo motivo que `order_events`: un historial
-- que se puede editar no sirve para auditar nada. No se le crean politicas de
-- UPDATE ni DELETE, y se revocan los privilegios explicitamente.
-- ---------------------------------------------------------------------

create table if not exists inventory_moves (
  id          uuid primary key default gen_random_uuid(),
  variant_id  uuid not null references variants (id) on delete cascade,
  -- El delta y no solo el valor final: sumar los deltas debe reproducir el stock
  -- actual, y eso es exactamente la comprobacion que permite detectar un
  -- descuadre.
  delta       integer not null,
  stock_antes integer not null check (stock_antes >= 0),
  stock_despues integer not null check (stock_despues >= 0),
  motivo      text not null
                check (motivo in ('ajuste_manual', 'recepcion', 'venta', 'devolucion', 'merma', 'alta_producto')),
  nota        text,
  -- Quien lo hizo. Nullable porque los movimientos de origen automatico
  -- (una venta) no tienen admin detras.
  actor       text,
  created_at  timestamptz not null default now(),
  constraint ck_inventory_moves_coherente
    check (stock_despues = stock_antes + delta)
);

comment on table inventory_moves is
  'Historial append-only de movimientos de stock. Sumar los deltas de una variante debe reproducir su stock actual: es lo que permite reconstruir un descuadre.';
comment on column inventory_moves.delta is
  'Variacion aplicada. Positivo entra mercaderia, negativo sale.';
comment on constraint ck_inventory_moves_coherente on inventory_moves is
  'stock_despues = stock_antes + delta. Impide guardar una fila incoherente que arruinaria la auditoria entera.';

create index if not exists ix_inventory_moves_variant
  on inventory_moves (variant_id, created_at desc);

alter table inventory_moves enable row level security;

-- Solo admins leen el historial: expone cuanto stock maneja el negocio.
drop policy if exists inventory_moves_admin_select on inventory_moves;
create policy inventory_moves_admin_select
  on inventory_moves
  for select
  using (is_admin());

-- Sin politica de INSERT: las escrituras van con service_role desde el servidor,
-- junto al UPDATE del stock. Sin politica de UPDATE ni DELETE: append-only.
grant select on inventory_moves to authenticated;
revoke update, delete on inventory_moves from anon, authenticated;

-- ---------------------------------------------------------------------
-- adjust_stock(p_variant_id, p_stock_nuevo, p_motivo, p_nota, p_actor)
--
-- POR QUE UNA FUNCION Y NO UN UPDATE DESDE LA APLICACION:
--
-- El ajuste son dos escrituras que deben pasar juntas o ninguna: actualizar
-- `variants.stock` y registrar el movimiento. Hechas por separado desde el
-- servidor, un fallo entre las dos deja el stock cambiado sin rastro, que es
-- justo el problema que esta tabla venia a resolver.
--
-- Ademas bloquea la fila con FOR UPDATE antes de leer el stock anterior. Sin el
-- bloqueo, dos ajustes simultaneos leerian el mismo `stock_antes` y el historial
-- registraria dos movimientos que no cuadran con el resultado final.
-- ---------------------------------------------------------------------

create or replace function adjust_stock(
  p_variant_id uuid,
  p_stock_nuevo integer,
  p_motivo text default 'ajuste_manual',
  p_nota text default null,
  p_actor text default null
)
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  v_stock_antes integer;
begin
  if p_stock_nuevo < 0 then
    raise exception 'el stock no puede ser negativo (se recibio %)', p_stock_nuevo;
  end if;

  select stock into v_stock_antes
  from variants
  where id = p_variant_id
  for update;

  if v_stock_antes is null then
    raise exception 'la variante % no existe', p_variant_id;
  end if;

  -- Sin cambio real no se escribe nada: un historial lleno de movimientos de
  -- delta 0 (el admin recorriendo tallas con el tabulador) es un historial
  -- ilegible.
  if v_stock_antes = p_stock_nuevo then
    return v_stock_antes;
  end if;

  update variants set stock = p_stock_nuevo where id = p_variant_id;

  insert into inventory_moves
    (variant_id, delta, stock_antes, stock_despues, motivo, nota, actor)
  values
    (p_variant_id, p_stock_nuevo - v_stock_antes, v_stock_antes, p_stock_nuevo,
     p_motivo, nullif(btrim(coalesce(p_nota, '')), ''), p_actor);

  return p_stock_nuevo;
end;
$fn$;

comment on function adjust_stock(uuid, integer, text, text, text) is
  'Ajusta el stock de una variante y registra el movimiento en la misma transaccion. Bloquea la fila con FOR UPDATE para que dos ajustes concurrentes no dejen un historial que no cuadre.';

revoke all on function adjust_stock(uuid, integer, text, text, text) from public;
grant execute on function adjust_stock(uuid, integer, text, text, text) to service_role;
