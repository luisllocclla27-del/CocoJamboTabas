-- =====================================================================
-- 0002_rls.sql
-- Row Level Security para todas las tablas.
--
-- Modelo mental:
--   * anon / authenticated  -> solo catalogo activo y alta en waitlist.
--   * admin (admin_users)   -> lectura y escritura operativa.
--   * service_role          -> ignora RLS por definicion; es el que usa el
--                              backend para escribir pedidos, pagos y eventos.
--
-- Regla general: la AUSENCIA de politica equivale a DENEGADO. Aqui se usa
-- deliberadamente ese comportamiento (por ejemplo, no hay ninguna politica de
-- UPDATE ni DELETE sobre order_events).
-- =====================================================================

-- =====================================================================
-- PRIVILEGIOS DE TABLA
--
-- RLS y GRANT son dos capas distintas: la RLS filtra FILAS, el GRANT decide si
-- el rol puede tocar la TABLA. Sin el grant, anon recibe "permission denied for
-- table" antes de que la politica llegue a evaluarse. Supabase suele conceder
-- estos privilegios por defecto, pero se declaran aqui de forma explicita para
-- que el esquema no dependa de esa configuracion.
--
-- Se concede solo lo minimo: lectura del catalogo y un insert en waitlist.
-- Todo lo demas queda para authenticated (admins, filtrados por RLS) y
-- service_role (que ignora la RLS por definicion).
-- =====================================================================

grant select on brands, products, product_images, variants to anon, authenticated;
grant insert on waitlist to anon, authenticated;

-- El panel de admin opera con un usuario autenticado; que pueda hacer algo o no
-- lo decide is_admin() en cada politica.
grant select, insert, update, delete on
  brands, products, product_images, variants,
  customers, orders, order_items, reservations,
  payments, shipments, waitlist, settings
  to authenticated;

grant select, insert on order_events to authenticated;
grant select on outbox, webhook_events, admin_users to authenticated;

-- Refuerzo explicito de la inmutabilidad de la bitacora: ademas de no existir
-- politica de UPDATE/DELETE, se revoca el privilegio.
revoke update, delete on order_events from anon, authenticated;

-- ---------------------------------------------------------------------
-- Helper: is_admin()
-- security definer para poder leer admin_users sin que la propia RLS de
-- admin_users provoque recursion; stable porque no muta nada y su resultado
-- es constante dentro de una misma sentencia.
-- ---------------------------------------------------------------------

create or replace function is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from admin_users au
    where au.id = auth.uid()
  );
$$;

comment on function is_admin() is
  'True si el usuario autenticado esta en admin_users. security definer para evitar recursion de RLS sobre admin_users.';

-- Nota sobre permisos: al crear una funcion, Postgres concede EXECUTE a PUBLIC.
-- Por eso, cada vez que se revoca de PUBLIC hay que volver a conceder
-- explicitamente a service_role, que es el rol con el que el backend ejecuta
-- las funciones sensibles (service_role hereda de PUBLIC, no tiene un permiso
-- propio). Olvidarlo deja el checkout con "permission denied for function".
revoke all on function is_admin() from public;
grant execute on function is_admin() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- Habilitar RLS en TODAS las tablas
-- ---------------------------------------------------------------------

alter table brands          enable row level security;
alter table products        enable row level security;
alter table product_images  enable row level security;
alter table variants        enable row level security;
alter table customers       enable row level security;
alter table orders          enable row level security;
alter table order_items     enable row level security;
alter table reservations    enable row level security;
alter table payments        enable row level security;
alter table shipments       enable row level security;
alter table order_events    enable row level security;
alter table outbox          enable row level security;
alter table waitlist        enable row level security;
alter table webhook_events  enable row level security;
alter table settings        enable row level security;
alter table admin_users     enable row level security;

-- =====================================================================
-- CATALOGO: lectura publica solo de filas activas.
-- =====================================================================

-- brands -------------------------------------------------------------
drop policy if exists brands_select_publico on brands;
create policy brands_select_publico
  on brands
  for select
  using (activo = true);

drop policy if exists brands_admin_all on brands;
create policy brands_admin_all
  on brands
  for all
  using (is_admin())
  with check (is_admin());

-- products -----------------------------------------------------------
-- Solo productos activos y de marca activa: desactivar una marca oculta
-- su catalogo completo sin tener que tocar cada producto.
drop policy if exists products_select_publico on products;
create policy products_select_publico
  on products
  for select
  using (
    activo = true
    and exists (
      select 1 from brands b
      where b.id = products.brand_id and b.activo = true
    )
  );

drop policy if exists products_admin_all on products;
create policy products_admin_all
  on products
  for all
  using (is_admin())
  with check (is_admin());

-- product_images -----------------------------------------------------
drop policy if exists product_images_select_publico on product_images;
create policy product_images_select_publico
  on product_images
  for select
  using (
    exists (
      select 1 from products p
      where p.id = product_images.product_id and p.activo = true
    )
  );

drop policy if exists product_images_admin_all on product_images;
create policy product_images_admin_all
  on product_images
  for all
  using (is_admin())
  with check (is_admin());

-- variants -----------------------------------------------------------
drop policy if exists variants_select_publico on variants;
create policy variants_select_publico
  on variants
  for select
  using (
    activo = true
    and exists (
      select 1 from products p
      where p.id = variants.product_id and p.activo = true
    )
  );

drop policy if exists variants_admin_all on variants;
create policy variants_admin_all
  on variants
  for all
  using (is_admin())
  with check (is_admin());

-- =====================================================================
-- DATOS TRANSACCIONALES Y PERSONALES
--
-- DECISION DE SEGURIDAD (importante):
-- Ni orders, ni order_items, ni payments, ni shipments, ni customers, ni
-- reservations, ni order_events son legibles por el rol anonimo. El cliente NO
-- lee su propio pedido via RLS: no hay sesion de usuario en el checkout, asi
-- que la unica llave posible seria la reference, y exponerla como filtro de
-- RLS convertiria la tabla en enumerable (probar COCO-0001, COCO-0002, ...) y
-- dejaria a la vista datos personales de terceros, vouchers, numeros de
-- operacion y costos.
--
-- En su lugar el seguimiento publico pasa por public_order_tracking(reference),
-- una funcion security definer (ver 0003) que devuelve un jsonb con SOLO
-- campos no sensibles. La superficie expuesta es una lista blanca explicita,
-- no "toda la fila menos lo que recordemos ocultar".
--
-- Las escrituras del checkout las hace el backend con service_role, que salta
-- la RLS, siempre a traves de create_order_with_reservations().
-- =====================================================================

-- customers ----------------------------------------------------------
drop policy if exists customers_admin_select on customers;
create policy customers_admin_select
  on customers
  for select
  using (is_admin());

drop policy if exists customers_admin_write on customers;
create policy customers_admin_write
  on customers
  for all
  using (is_admin())
  with check (is_admin());

-- orders -------------------------------------------------------------
drop policy if exists orders_admin_select on orders;
create policy orders_admin_select
  on orders
  for select
  using (is_admin());

drop policy if exists orders_admin_write on orders;
create policy orders_admin_write
  on orders
  for all
  using (is_admin())
  with check (is_admin());

-- order_items --------------------------------------------------------
drop policy if exists order_items_admin_select on order_items;
create policy order_items_admin_select
  on order_items
  for select
  using (is_admin());

drop policy if exists order_items_admin_write on order_items;
create policy order_items_admin_write
  on order_items
  for all
  using (is_admin())
  with check (is_admin());

-- reservations -------------------------------------------------------
drop policy if exists reservations_admin_select on reservations;
create policy reservations_admin_select
  on reservations
  for select
  using (is_admin());

drop policy if exists reservations_admin_write on reservations;
create policy reservations_admin_write
  on reservations
  for all
  using (is_admin())
  with check (is_admin());

-- payments -----------------------------------------------------------
-- Refuerzo explicito: voucher_path apunta a un bucket PRIVADO de Storage y la
-- fila entera solo es legible por is_admin(). Un anonimo no puede leer
-- voucher_path, operation_number, ocr_raw ni risk_signals por ninguna via:
-- public_order_tracking() no toca esta tabla.
drop policy if exists payments_admin_select on payments;
create policy payments_admin_select
  on payments
  for select
  using (is_admin());

drop policy if exists payments_admin_write on payments;
create policy payments_admin_write
  on payments
  for all
  using (is_admin())
  with check (is_admin());

-- shipments ----------------------------------------------------------
drop policy if exists shipments_admin_select on shipments;
create policy shipments_admin_select
  on shipments
  for select
  using (is_admin());

drop policy if exists shipments_admin_write on shipments;
create policy shipments_admin_write
  on shipments
  for all
  using (is_admin())
  with check (is_admin());

-- order_events -------------------------------------------------------
-- Solo SELECT para admin e INSERT (en la practica lo ejecuta service_role, que
-- salta RLS; la politica queda para insertar desde una sesion admin).
-- NO se crean politicas de UPDATE ni DELETE: la ausencia de politica implica
-- denegado, y eso es exactamente lo que se quiere. La bitacora es inmutable.
drop policy if exists order_events_admin_select on order_events;
create policy order_events_admin_select
  on order_events
  for select
  using (is_admin());

drop policy if exists order_events_insert on order_events;
create policy order_events_insert
  on order_events
  for insert
  with check (is_admin());

-- =====================================================================
-- waitlist: alta publica, lectura solo admin.
-- =====================================================================

-- Cualquiera puede pedir aviso de restock de una talla agotada...
drop policy if exists waitlist_insert_publico on waitlist;
create policy waitlist_insert_publico
  on waitlist
  for insert
  with check (
    notificado = false
    and exists (
      select 1
      from variants v
      join products p on p.id = v.product_id
      where v.id = waitlist.variant_id
        and v.activo = true
        and p.activo = true
    )
  );

-- ...pero nadie puede LEER la lista (son telefonos de terceros).
drop policy if exists waitlist_admin_select on waitlist;
create policy waitlist_admin_select
  on waitlist
  for select
  using (is_admin());

drop policy if exists waitlist_admin_write on waitlist;
create policy waitlist_admin_write
  on waitlist
  for all
  using (is_admin())
  with check (is_admin());

-- =====================================================================
-- settings
-- SELECT solo admin. Las claves "publicas" (costos de envio, umbral de envio
-- gratis, numero de Yape a mostrar) NO se exponen por RLS: las lee el servidor
-- con service_role y las inyecta en la pagina, o se publican por una funcion
-- security definer con lista blanca de keys. Asi una clave privada anadida en
-- el futuro no queda expuesta por defecto.
-- =====================================================================

drop policy if exists settings_admin_select on settings;
create policy settings_admin_select
  on settings
  for select
  using (is_admin());

drop policy if exists settings_admin_write on settings;
create policy settings_admin_write
  on settings
  for all
  using (is_admin())
  with check (is_admin());

-- =====================================================================
-- Infraestructura interna: outbox, webhook_events, admin_users.
-- Sin acceso publico. En la practica solo las toca service_role.
-- =====================================================================

drop policy if exists outbox_admin_select on outbox;
create policy outbox_admin_select
  on outbox
  for select
  using (is_admin());

drop policy if exists outbox_admin_write on outbox;
create policy outbox_admin_write
  on outbox
  for all
  using (is_admin())
  with check (is_admin());

drop policy if exists webhook_events_admin_select on webhook_events;
create policy webhook_events_admin_select
  on webhook_events
  for select
  using (is_admin());

drop policy if exists webhook_events_admin_write on webhook_events;
create policy webhook_events_admin_write
  on webhook_events
  for all
  using (is_admin())
  with check (is_admin());

-- admin_users: un admin ve la lista; nadie mas. Las altas se hacen con
-- service_role para que nadie pueda auto-promoverse.
drop policy if exists admin_users_admin_select on admin_users;
create policy admin_users_admin_select
  on admin_users
  for select
  using (is_admin());
