-- =====================================================================
-- 0001_schema.sql
-- Esquema base del e-commerce de zapatillas urbanas (Supabase / Postgres).
--
-- Convenciones del proyecto:
--   * Todo el dinero se guarda en CENTIMOS como integer, con sufijo _cents.
--     Nunca float ni numeric para dinero: los redondeos en coma flotante
--     producen descuadres imposibles de auditar contra un voucher de Yape.
--   * Timestamps siempre timestamptz default now().
--   * PKs uuid con gen_random_uuid() (pgcrypto).
--   * Idempotente donde es razonable: create table if not exists, etc.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Enums
-- Se crean con bloques DO para que la migracion sea re-ejecutable
-- (create type no admite "if not exists").
-- ---------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'order_status') then
    create type order_status as enum (
      'pendiente_pago',
      'comprobante_enviado',
      'verificado',
      'rechazado',
      'preparando',
      'enviado',
      'entregado',
      'cancelado',
      'expirado'
    );
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'payment_method') then
    create type payment_method as enum (
      'yape_manual',
      'tupay',
      'contraentrega'
    );
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'payment_status') then
    create type payment_status as enum (
      'pendiente',
      'en_revision',
      'aprobado',
      'rechazado',
      'expirado'
    );
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'reservation_status') then
    create type reservation_status as enum (
      'activa',
      'confirmada',
      'liberada',
      'expirada'
    );
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'shipping_mode') then
    create type shipping_mode as enum (
      'lima_domicilio',
      'provincia_agencia',
      'recojo_tienda'
    );
  end if;
end
$$;

do $$
begin
  if not exists (select 1 from pg_type where typname = 'size_system') then
    create type size_system as enum ('US', 'EU', 'CM');
  end if;
end
$$;

-- size_system no se usa como columna: variants guarda las tres equivalencias
-- (size_us, size_eu, size_cm) a la vez. El enum existe para tipar el sistema de
-- tallas elegido por el usuario en la UI y en funciones de conversion.
comment on type size_system is
  'Sistema de tallas para presentacion (US/EU/CM). variants almacena las tres equivalencias.';

-- ---------------------------------------------------------------------
-- Trigger utilitario: mantiene updated_at al dia.
-- ---------------------------------------------------------------------

create or replace function set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function set_updated_at() is
  'Trigger BEFORE UPDATE que refresca updated_at. Evita depender de la app.';

-- ---------------------------------------------------------------------
-- 1. brands
-- ---------------------------------------------------------------------

create table if not exists brands (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique,
  nombre     text not null,
  logo_url   text,
  activo     boolean not null default true,
  orden      integer not null default 0,
  created_at timestamptz not null default now()
);

comment on table brands is 'Marcas del catalogo (Converse, Vans, New Balance, Adidas...).';
comment on column brands.orden is 'Orden manual de aparicion en el listado de marcas; menor primero.';

create index if not exists ix_brands_activo on brands (activo);

-- ---------------------------------------------------------------------
-- 2. products
-- ---------------------------------------------------------------------

create table if not exists products (
  id                      uuid primary key default gen_random_uuid(),
  slug                    text not null unique,
  brand_id                uuid not null references brands (id) on delete restrict,
  modelo                  text not null,
  colorway                text not null,
  silueta                 text,
  descripcion             text,
  condicion               text not null default 'nuevo_en_caja'
                            check (condicion in ('nuevo_en_caja', 'nuevo_sin_caja')),
  cost_cents              integer not null default 0 check (cost_cents >= 0),
  price_cents             integer not null check (price_cents >= 0),
  compare_at_price_cents  integer check (compare_at_price_cents >= 0),
  nota_calce              text,
  garantia_originalidad   text,
  activo                  boolean not null default true,
  destacado               boolean not null default false,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

comment on table products is
  'Producto = modelo + colorway. Las tallas viven en variants.';
comment on column products.silueta is
  'Texto libre controlado por el comerciante: high top, low top, slip on, skate, running...';
comment on column products.cost_cents is
  'Costo de adquisicion actual en centimos. Se usa para margen; al vender se congela en order_items.unit_cost_cents.';
comment on column products.compare_at_price_cents is
  'Precio tachado (antes). Nullable: si es null no se muestra descuento.';
comment on column products.nota_calce is
  'Nota sobre el calce (calza grande/pequeno). NO se infiere ni se hardcodea: lo llena el comerciante.';
comment on column products.garantia_originalidad is
  'Texto de garantia de originalidad mostrado en la ficha. Nullable.';

create index if not exists ix_products_brand_id on products (brand_id);
create index if not exists ix_products_activo on products (activo);

-- Busqueda full-text en espanol sobre modelo + colorway.
-- Expresion inmutable (coalesce + to_tsvector con configuracion literal),
-- requisito para poder indexarla.
create index if not exists ix_products_busqueda
  on products
  using gin (
    to_tsvector('spanish', coalesce(modelo, '') || ' ' || coalesce(colorway, ''))
  );

drop trigger if exists tr_products_updated_at on products;
create trigger tr_products_updated_at
  before update on products
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- 3. product_images
-- ---------------------------------------------------------------------

create table if not exists product_images (
  id           uuid primary key default gen_random_uuid(),
  product_id   uuid not null references products (id) on delete cascade,
  url          text not null,
  alt          text not null,
  orden        integer not null default 0,
  es_principal boolean not null default false,
  created_at   timestamptz not null default now()
);

comment on column product_images.alt is
  'Texto alternativo OBLIGATORIO: accesibilidad (lectores de pantalla) y SEO.';

create index if not exists ix_product_images_product_id on product_images (product_id, orden);

-- ---------------------------------------------------------------------
-- 4. variants
-- ---------------------------------------------------------------------

create table if not exists variants (
  id         uuid primary key default gen_random_uuid(),
  product_id uuid not null references products (id) on delete cascade,
  size_us    numeric(4,1) not null,
  size_eu    numeric(4,1),
  size_cm    numeric(4,1),
  sku        text not null unique,
  stock      integer not null default 0 check (stock >= 0),
  activo     boolean not null default true,
  created_at timestamptz not null default now(),
  constraint ux_variants_product_size_us unique (product_id, size_us)
);

comment on table variants is 'Talla concreta de un producto. Unidad real de inventario.';
comment on column variants.stock is
  'Stock FISICO en almacen. La disponibilidad para vender es stock menos reservas activas (ver available_stock()).';

create index if not exists ix_variants_product_id on variants (product_id);

-- ---------------------------------------------------------------------
-- 5. customers
-- ---------------------------------------------------------------------

create table if not exists customers (
  id         uuid primary key default gen_random_uuid(),
  nombre     text not null,
  apellidos  text,
  dni        text,
  email      text,
  telefono   text not null,
  created_at timestamptz not null default now()
);

comment on column customers.telefono is
  'Obligatorio: es el canal WhatsApp por el que se coordina el pedido.';
comment on column customers.dni is
  'Nullable. Solo se pide cuando la agencia de envio lo exige.';

-- Unico parcial: puede haber muchos clientes sin DNI, pero un DNI no se repite.
create unique index if not exists ux_customers_dni
  on customers (dni)
  where dni is not null;

create index if not exists ix_customers_telefono on customers (telefono);

-- ---------------------------------------------------------------------
-- 6. orders
-- ---------------------------------------------------------------------

create table if not exists orders (
  id               uuid primary key default gen_random_uuid(),
  reference        text not null unique,
  customer_id      uuid not null references customers (id) on delete restrict,
  status           order_status not null default 'pendiente_pago',
  subtotal_cents   integer not null default 0 check (subtotal_cents >= 0),
  discount_cents   integer not null default 0 check (discount_cents >= 0),
  shipping_cents   integer not null default 0 check (shipping_cents >= 0),
  total_cents      integer not null default 0 check (total_cents >= 0),
  payment_cents    smallint check (payment_cents between 0 and 99),
  payment_method   payment_method not null,
  shipping_mode    shipping_mode not null,
  direccion        text,
  distrito         text,
  departamento     text,
  provincia        text,
  agencia_destino  text,
  notas            text,
  reserved_until   timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table orders is 'Pedido. reference con formato COCO-XXXX es el identificador publico.';
comment on column orders.reference is
  'Identificador publico del pedido (COCO-XXXX). Debe generarse con entropia suficiente: es la llave del seguimiento publico.';
comment on column orders.total_cents is
  'Total FINAL a pagar, con los centimos unicos (payment_cents) ya incluidos.';
comment on column orders.payment_cents is
  'Centimos unicos (0-99) asignados a este pedido. Hacen que el monto exacto del Yape identifique univocamente el pedido, sin depender del nombre del pagador.';
comment on column orders.reserved_until is
  'Momento en que caduca la reserva de stock del pedido. Copia denormalizada del expires_at de reservations para poder filtrar rapido.';

create index if not exists ix_orders_status on orders (status);
create index if not exists ix_orders_created_at on orders (created_at desc);
create index if not exists ix_orders_reference on orders (reference);
create index if not exists ix_orders_customer_id on orders (customer_id);

-- Unicidad de los centimos identificadores mientras el pago esta "en juego".
-- Postgres no permite un indice unico parcial con condicion sobre otra tabla,
-- asi que la condicion se apoya en columnas de orders.
-- Por que existe: garantiza que el MONTO recibido en Yape identifique
-- univocamente el pedido. Si dos pedidos pendientes compartieran los mismos
-- centimos, un deposito de S/ 249.37 seria ambiguo y habria que conciliar a mano.
-- Al salir de estos estados los centimos se liberan y se pueden reutilizar.
create unique index if not exists ux_orders_payment_cents_pendientes
  on orders (payment_cents)
  where status in ('pendiente_pago', 'comprobante_enviado')
    and payment_method = 'yape_manual';

drop trigger if exists tr_orders_updated_at on orders;
create trigger tr_orders_updated_at
  before update on orders
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- 7. order_items
-- ---------------------------------------------------------------------

create table if not exists order_items (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null references orders (id) on delete cascade,
  variant_id       uuid references variants (id) on delete set null,
  cantidad         integer not null check (cantidad > 0),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  unit_cost_cents  integer not null default 0 check (unit_cost_cents >= 0),
  product_modelo   text not null,
  product_colorway text not null,
  size_us          numeric(4,1) not null,
  created_at       timestamptz not null default now()
);

-- DECISION: order_items guarda un SNAPSHOT desnormalizado del producto
-- (modelo, colorway, talla) y del dinero (unit_price_cents, unit_cost_cents).
-- Motivo: un pedido es un documento historico. Si manana el comerciante
-- renombra el producto, le cambia el precio, corrige el colorway o borra la
-- variante, el pedido antiguo debe seguir leyendose exactamente igual que el
-- dia en que el cliente compro. Por eso variant_id es nullable con
-- "on delete set null": se pierde el enlace, no el contenido.
comment on table order_items is
  'Linea de pedido con snapshot desnormalizado del producto y de los importes al momento de la venta.';
comment on column order_items.unit_cost_cents is
  'Costo unitario CONGELADO al momento de la venta. Permite calcular la ganancia real historica aunque el costo de reposicion cambie.';
comment on column order_items.product_modelo is
  'Snapshot: nombre del modelo al momento de la venta. No se actualiza nunca.';
comment on column order_items.product_colorway is
  'Snapshot: colorway al momento de la venta.';
comment on column order_items.size_us is
  'Snapshot: talla US vendida. Sobrevive al borrado de la variante.';

create index if not exists ix_order_items_order_id on order_items (order_id);
create index if not exists ix_order_items_variant_id on order_items (variant_id);

-- ---------------------------------------------------------------------
-- 8. reservations
-- ---------------------------------------------------------------------

create table if not exists reservations (
  id         uuid primary key default gen_random_uuid(),
  order_id   uuid not null references orders (id) on delete cascade,
  variant_id uuid not null references variants (id) on delete cascade,
  cantidad   integer not null check (cantidad > 0),
  status     reservation_status not null default 'activa',
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

comment on table reservations is
  'Reserva temporal de stock mientras el cliente paga. El stock fisico solo se descuenta al pasar a preparando.';

-- Indice que sostiene el calculo de disponibilidad: available_stock() filtra
-- exactamente por (variant_id, status = activa, expires_at > now()).
create index if not exists ix_reservations_disponibilidad
  on reservations (variant_id, status, expires_at);

create index if not exists ix_reservations_order_id on reservations (order_id);

-- ---------------------------------------------------------------------
-- 9. payments
-- ---------------------------------------------------------------------

create table if not exists payments (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid not null references orders (id) on delete cascade,
  method              payment_method not null,
  status              payment_status not null default 'pendiente',
  amount_cents        integer not null default 0 check (amount_cents >= 0),
  operation_number    text,
  voucher_path        text,
  voucher_phash       text,
  voucher_sha256      text,
  ocr_raw             jsonb,
  ocr_confidence      numeric,
  risk_score          integer,
  risk_signals        jsonb,
  provider_deposit_id text,
  provider_invoice_id text,
  reviewed_by         uuid,
  reviewed_at         timestamptz,
  rejection_reason    text,
  created_at          timestamptz not null default now()
);

comment on table payments is 'Intento de pago: voucher de Yape, cobro por Tupay o contraentrega.';
comment on column payments.operation_number is
  'Numero de operacion declarado o extraido por OCR del voucher.';
comment on column payments.voucher_path is
  'Ruta del voucher en Storage (bucket privado). NUNCA una URL publica: se firma bajo demanda y solo para admin.';
comment on column payments.voucher_phash is
  'Hash perceptual de 64 bits en hex de la imagen del voucher.';
comment on column payments.voucher_sha256 is
  'SHA-256 del archivo exacto. Detecta el reenvio bit a bit del mismo archivo.';
comment on column payments.ocr_raw is
  'Salida cruda del OCR, para auditar por que se aprobo o rechazo un pago.';
comment on column payments.risk_signals is
  'Senales de riesgo detectadas (monto distinto, fecha vieja, phash parecido...).';
comment on column payments.reviewed_by is
  'auth.users.id del admin que reviso. Sin FK a auth.users para no bloquear el borrado de usuarios.';

create index if not exists ix_payments_order_id on payments (order_id);
create index if not exists ix_payments_status on payments (status);

-- Mata la reutilizacion de vouchers: un mismo numero de operacion no puede
-- justificar dos pagos distintos.
create unique index if not exists ux_payments_operation_number
  on payments (operation_number)
  where operation_number is not null;

-- Detecta la MISMA imagen aunque la recorten, reescalen o recompriman:
-- el hash perceptual sobrevive a esas transformaciones donde el sha256 no.
create unique index if not exists ux_payments_voucher_phash
  on payments (voucher_phash)
  where voucher_phash is not null;

-- Idempotencia frente al proveedor (Tupay): un deposito = un pago.
create unique index if not exists ux_payments_provider_deposit_id
  on payments (provider_deposit_id)
  where provider_deposit_id is not null;

-- ---------------------------------------------------------------------
-- 10. shipments
-- ---------------------------------------------------------------------

create table if not exists shipments (
  id                 uuid primary key default gen_random_uuid(),
  order_id           uuid not null references orders (id) on delete cascade,
  provider           text not null default 'manual'
                       check (provider in ('manual', 'shalom')),
  guia               text,
  codigo             text,
  pickup_code        text,
  agencia_origen_id  integer,
  agencia_destino_id integer,
  tracking_url       text,
  hitos              jsonb not null default '[]'::jsonb,
  delivered          boolean not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

comment on column shipments.pickup_code is
  'Clave de retiro de 4 digitos que la agencia pide al destinatario.';
comment on column shipments.hitos is
  'Historial de eventos del transportista como array jsonb: [{fecha, estado, detalle}].';

create index if not exists ix_shipments_order_id on shipments (order_id);

drop trigger if exists tr_shipments_updated_at on shipments;
create trigger tr_shipments_updated_at
  before update on shipments
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- 11. order_events (auditoria inmutable)
-- ---------------------------------------------------------------------

create table if not exists order_events (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references orders (id) on delete cascade,
  from_status order_status,
  to_status   order_status,
  evento      text not null,
  actor       text not null,
  motivo      text,
  metadata    jsonb,
  created_at  timestamptz not null default now()
);

-- Tabla APPEND-ONLY. Sobre order_events no se hace UPDATE ni DELETE nunca:
-- es la bitacora con la que se defiende un cobro o un rechazo de voucher.
-- La RLS de 0002 lo refuerza: existen politicas de INSERT y de SELECT, y
-- deliberadamente NINGUNA de UPDATE ni DELETE (ausencia de politica = denegado).
comment on table order_events is
  'Auditoria inmutable (append-only) del ciclo de vida del pedido. Sin UPDATE ni DELETE; la RLS lo refuerza.';
comment on column order_events.actor is
  'Quien provoco el evento: sistema, cliente, o admin:<uuid>.';
comment on column order_events.metadata is
  'Contexto libre del evento (montos, ids de proveedor, senales de riesgo).';

create index if not exists ix_order_events_order_id_created_at
  on order_events (order_id, created_at);

-- ---------------------------------------------------------------------
-- 12. outbox (patron transactional outbox)
-- ---------------------------------------------------------------------

create table if not exists outbox (
  id                    uuid primary key default gen_random_uuid(),
  tipo                  text not null,
  payload               jsonb not null default '{}'::jsonb,
  status                text not null default 'pendiente'
                          check (status in ('pendiente', 'procesando', 'enviado', 'fallido')),
  intentos              integer not null default 0 check (intentos >= 0),
  ultimo_error          text,
  procesar_despues_de   timestamptz not null default now(),
  created_at            timestamptz not null default now()
);

comment on table outbox is
  'Transactional outbox: los efectos secundarios (WhatsApp, avisos de restock) se encolan en la MISMA transaccion que el cambio de estado. Si la transaccion falla no se manda nada; si el envio falla se reintenta sin perder el evento.';
comment on column outbox.tipo is
  'whatsapp_comprobante_recibido, whatsapp_pedido_enviado, restock_aviso, ...';
comment on column outbox.procesar_despues_de is
  'No procesar antes de este momento. Permite backoff exponencial en los reintentos.';

-- Indice parcial: el worker solo consulta lo pendiente.
create index if not exists ix_outbox_pendientes
  on outbox (procesar_despues_de)
  where status = 'pendiente';

-- ---------------------------------------------------------------------
-- 13. waitlist
-- ---------------------------------------------------------------------

create table if not exists waitlist (
  id         uuid primary key default gen_random_uuid(),
  variant_id uuid not null references variants (id) on delete cascade,
  telefono   text not null,
  email      text,
  notificado boolean not null default false,
  created_at timestamptz not null default now(),
  constraint ux_waitlist_variant_telefono unique (variant_id, telefono)
);

comment on table waitlist is
  'Lista de espera por talla agotada. El unique evita que el mismo numero se apunte dos veces a la misma talla.';

create index if not exists ix_waitlist_pendientes
  on waitlist (variant_id)
  where notificado = false;

-- ---------------------------------------------------------------------
-- 14. webhook_events (deduplicacion)
-- ---------------------------------------------------------------------

create table if not exists webhook_events (
  id           uuid primary key default gen_random_uuid(),
  provider     text not null,
  event_id     text not null,
  payload      jsonb not null default '{}'::jsonb,
  procesado_at timestamptz,
  created_at   timestamptz not null default now(),
  constraint ux_webhook_events_provider_event unique (provider, event_id)
);

-- Los proveedores de pago reenvian el mismo evento cuando no reciben un 200
-- a tiempo (o simplemente por diseno, con entrega "at least once"). El unique
-- (provider, event_id) garantiza que un evento se procese UNA sola vez:
-- el insert falla y el handler responde 200 sin volver a aplicar el efecto.
comment on table webhook_events is
  'Deduplicacion de webhooks. Los proveedores reenvian el mismo evento; el unique (provider, event_id) asegura procesamiento exactamente una vez.';

-- ---------------------------------------------------------------------
-- 15. settings (clave/valor)
-- ---------------------------------------------------------------------

create table if not exists settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

comment on table settings is
  'Configuracion editable sin desplegar: numero de Yape, costos de envio, umbrales.';

drop trigger if exists tr_settings_updated_at on settings;
create trigger tr_settings_updated_at
  before update on settings
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- 16. admin_users
-- ---------------------------------------------------------------------

create table if not exists admin_users (
  id         uuid primary key references auth.users (id) on delete cascade,
  rol        text not null default 'staff' check (rol in ('admin', 'staff')),
  created_at timestamptz not null default now()
);

comment on table admin_users is
  'Usuarios con acceso al panel. Base de la funcion is_admin() usada por toda la RLS.';
