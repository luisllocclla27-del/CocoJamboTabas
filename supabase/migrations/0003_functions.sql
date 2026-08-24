-- =====================================================================
-- 0003_functions.sql
-- Logica de negocio que vive EN LA BASE de datos.
--
-- Criterio: todo lo que, si se hace mal, corrompe dinero o inventario
-- (disponibilidad, creacion de pedido, transiciones de estado) se resuelve en
-- SQL/plpgsql y no en la app. La base es el unico punto por el que pasan
-- todas las escrituras: es el sitio correcto para las invariantes.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. available_stock()
-- Disponibilidad real = stock fisico - reservas activas no vencidas.
-- stable: dentro de una misma sentencia el resultado no cambia.
-- ---------------------------------------------------------------------

-- security definer a proposito: reservations no es legible por anon (ver 0002),
-- pero la disponibilidad SI debe poder consultarse desde la ficha de producto.
-- Sin security definer un anonimo veria cero reservas y la web anunciaria como
-- disponible stock que ya esta comprometido en otro checkout.
create or replace function available_stock(p_variant_id uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $fn$
  select greatest(
    coalesce((select v.stock from variants v where v.id = p_variant_id), 0)
    - coalesce((
        select sum(r.cantidad)
        from reservations r
        where r.variant_id = p_variant_id
          and r.status = 'activa'
          and r.expires_at > now()
      ), 0),
    0
  )::integer;
$fn$;

comment on function available_stock(uuid) is
  'Stock vendible de una variante: stock fisico menos reservas activas vigentes. Nunca negativo.';

grant execute on function available_stock(uuid) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2. create_order_with_reservations()
-- LA funcion critica del sistema.
--
-- Invariantes NO negociables:
--   a) Atomicidad: una funcion es una unica transaccion. Si algo falla, no
--      queda ni pedido a medias ni reserva huerfana.
--   b) Bloqueo PESIMISTA y ORDENADO: se hace "select ... from variants
--      where id = ... for update" ANTES de comprobar disponibilidad, y los
--      variant_id se recorren en orden ASCENDENTE.
--      - El for update serializa las compras de la misma variante: sin el,
--        dos checkouts simultaneos del ultimo par leen "queda 1" a la vez y
--        ambos venden. La lectura de available_stock() solo es fiable si se
--        hace con la fila bloqueada.
--      - El orden ascendente evita DEADLOCKS: si la transaccion A bloquea la
--        variante X y luego pide Y, mientras B bloquea Y y luego pide X, se
--        quedan esperandose mutuamente. Con un orden total unico, dos
--        transacciones cualesquiera adquieren los locks en la misma secuencia
--        y una simplemente espera a la otra.
--   c) Precios SIEMPRE desde la base: subtotal, unit_price_cents y
--      unit_cost_cents se leen de products, nunca del payload del cliente.
--      Es la defensa contra manipulacion de precios desde el navegador
--      (DevTools, proxy, request forjado). El cliente solo elige QUE y CUANTO,
--      jamas a que precio.
-- ---------------------------------------------------------------------

create or replace function create_order_with_reservations(
  p_reference       text,
  p_customer        jsonb,          -- {nombre, apellidos, dni, email, telefono}
  p_items           jsonb,          -- [{variant_id, cantidad}]
  p_payment_method  payment_method,
  p_shipping_mode   shipping_mode,
  p_shipping_cents  integer,
  p_discount_cents  integer,
  p_payment_cents   smallint,
  p_reserva_minutos integer default 30,
  p_direccion       jsonb default null
)
returns uuid
language plpgsql
as $fn$
declare
  v_item            record;
  v_stock           integer;
  v_variant_activo  boolean;
  v_product_id      uuid;
  v_size_us         numeric(4,1);
  v_disponible      integer;
  v_modelo          text;
  v_colorway        text;
  v_price_cents     integer;
  v_cost_cents      integer;
  v_producto_activo boolean;
  v_lines           jsonb := '[]'::jsonb;
  v_line            jsonb;
  v_subtotal_cents  integer := 0;
  v_shipping_cents  integer := coalesce(p_shipping_cents, 0);
  v_discount_cents  integer := coalesce(p_discount_cents, 0);
  v_base_cents      integer;
  v_total_cents     integer;
  v_payment_cents   smallint;
  v_customer_id     uuid;
  v_order_id        uuid;
  v_expires_at      timestamptz;
  v_telefono        text := nullif(trim(coalesce(p_customer->>'telefono', '')), '');
begin
  -- --- Validaciones de entrada -------------------------------------
  if p_reference is null or length(trim(p_reference)) = 0 then
    raise exception 'reference obligatoria' using errcode = 'P0001';
  end if;

  if p_items is null
     or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'el pedido no tiene items' using errcode = 'P0001';
  end if;

  if v_telefono is null then
    raise exception 'telefono obligatorio: es el canal WhatsApp del pedido'
      using errcode = 'P0001';
  end if;

  if coalesce(p_reserva_minutos, 0) <= 0 then
    raise exception 'p_reserva_minutos debe ser mayor que cero' using errcode = 'P0001';
  end if;

  v_expires_at := now() + make_interval(mins => p_reserva_minutos);

  -- --- Paso 1: bloquear, validar y valorar cada linea ---------------
  -- Las cantidades se agrupan por variante (group by) para que un payload con
  -- la misma variante repetida no pueda burlar la comprobacion de stock, y se
  -- recorren en ORDEN ASCENDENTE de variant_id (order by 1) para el bloqueo
  -- ordenado descrito arriba.
  for v_item in
    select (elem->>'variant_id')::uuid as variant_id,
           sum((elem->>'cantidad')::integer)::integer as cantidad
    from jsonb_array_elements(p_items) as elem
    group by 1
    order by 1
  loop
    if v_item.cantidad is null or v_item.cantidad <= 0 then
      raise exception 'cantidad invalida para variante %', v_item.variant_id
        using errcode = 'P0001';
    end if;

    -- BLOQUEO de la fila de inventario ANTES de leer la disponibilidad.
    select v.stock, v.activo, v.product_id, v.size_us
      into v_stock, v_variant_activo, v_product_id, v_size_us
    from variants v
    where v.id = v_item.variant_id
    for update;

    if not found then
      raise exception 'variante inexistente: %', v_item.variant_id
        using errcode = 'P0001';
    end if;

    -- Precio y costo se toman de la BASE, no del cliente.
    select p.modelo, p.colorway, p.price_cents, p.cost_cents, p.activo
      into v_modelo, v_colorway, v_price_cents, v_cost_cents, v_producto_activo
    from products p
    where p.id = v_product_id;

    if not v_variant_activo or not coalesce(v_producto_activo, false) then
      raise exception 'la variante % no esta disponible para venta', v_item.variant_id
        using errcode = 'P0001';
    end if;

    -- Con la fila bloqueada, esta lectura ya es de fiar.
    v_disponible := available_stock(v_item.variant_id);

    if v_disponible < v_item.cantidad then
      raise exception using
        errcode = 'P0001',
        message = format(
          'stock insuficiente para variante %s: solicitado %s, disponible %s',
          v_item.variant_id, v_item.cantidad, v_disponible
        );
    end if;

    v_subtotal_cents := v_subtotal_cents + (v_price_cents * v_item.cantidad);

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'variant_id',       v_item.variant_id,
      'cantidad',         v_item.cantidad,
      'unit_price_cents', v_price_cents,
      'unit_cost_cents',  coalesce(v_cost_cents, 0),
      'product_modelo',   v_modelo,
      'product_colorway', v_colorway,
      'size_us',          v_size_us
    ));
  end loop;

  -- --- Paso 2: importes --------------------------------------------
  if v_discount_cents > v_subtotal_cents then
    raise exception 'descuento (% centimos) mayor que el subtotal (% centimos)',
      v_discount_cents, v_subtotal_cents using errcode = 'P0001';
  end if;

  v_base_cents := v_subtotal_cents - v_discount_cents + v_shipping_cents;

  -- Los centimos identificadores solo aplican al flujo de Yape manual: es ahi
  -- donde el MONTO es la unica forma fiable de conciliar el deposito.
  if p_payment_method = 'yape_manual' and p_payment_cents is not null then
    if p_payment_cents < 0 or p_payment_cents > 99 then
      raise exception 'payment_cents fuera de rango (0-99): %', p_payment_cents
        using errcode = 'P0001';
    end if;

    v_payment_cents := p_payment_cents;
    -- Se sustituyen los centimos del importe por los centimos identificadores.
    -- Si eso dejara el total por debajo de lo debido se sube al sol siguiente:
    -- el total NUNCA puede ser menor que subtotal - descuento + envio.
    v_total_cents := (v_base_cents - (v_base_cents % 100)) + v_payment_cents;
    if v_total_cents < v_base_cents then
      v_total_cents := v_total_cents + 100;
    end if;
  else
    v_payment_cents := null;
    v_total_cents := v_base_cents;
  end if;

  -- --- Paso 3: cliente (reutiliza por telefono) ---------------------
  select c.id into v_customer_id
  from customers c
  where c.telefono = v_telefono
  order by c.created_at
  limit 1;

  if v_customer_id is null then
    insert into customers (nombre, apellidos, dni, email, telefono)
    values (
      coalesce(nullif(trim(p_customer->>'nombre'), ''), 'Sin nombre'),
      nullif(trim(coalesce(p_customer->>'apellidos', '')), ''),
      nullif(trim(coalesce(p_customer->>'dni', '')), ''),
      nullif(trim(coalesce(p_customer->>'email', '')), ''),
      v_telefono
    )
    returning id into v_customer_id;
  end if;

  -- --- Paso 4: pedido ----------------------------------------------
  -- Nota para quien llame a esta funcion: el indice unico parcial
  -- ux_orders_payment_cents_pendientes puede hacer fallar este insert con
  -- unique_violation (SQLSTATE 23505) si otro pedido pendiente ya tiene esos
  -- centimos. Es el comportamiento correcto y deseado; el backend debe
  -- reintentar con otros p_payment_cents (o con otra reference si el choque
  -- fuese ahi), no ignorar el error.
  insert into orders (
    reference, customer_id, status,
    subtotal_cents, discount_cents, shipping_cents, total_cents, payment_cents,
    payment_method, shipping_mode,
    direccion, distrito, departamento, provincia, agencia_destino, notas,
    reserved_until
  )
  values (
    p_reference, v_customer_id, 'pendiente_pago',
    v_subtotal_cents, v_discount_cents, v_shipping_cents, v_total_cents, v_payment_cents,
    p_payment_method, p_shipping_mode,
    nullif(trim(coalesce(p_direccion->>'direccion', '')), ''),
    nullif(trim(coalesce(p_direccion->>'distrito', '')), ''),
    nullif(trim(coalesce(p_direccion->>'departamento', '')), ''),
    nullif(trim(coalesce(p_direccion->>'provincia', '')), ''),
    nullif(trim(coalesce(p_direccion->>'agencia_destino', '')), ''),
    nullif(trim(coalesce(p_direccion->>'notas', '')), ''),
    v_expires_at
  )
  returning id into v_order_id;

  -- --- Paso 5: lineas (snapshot) y reservas -------------------------
  for v_line in select * from jsonb_array_elements(v_lines)
  loop
    insert into order_items (
      order_id, variant_id, cantidad,
      unit_price_cents, unit_cost_cents,
      product_modelo, product_colorway, size_us
    )
    values (
      v_order_id,
      (v_line->>'variant_id')::uuid,
      (v_line->>'cantidad')::integer,
      (v_line->>'unit_price_cents')::integer,
      (v_line->>'unit_cost_cents')::integer,
      v_line->>'product_modelo',
      v_line->>'product_colorway',
      (v_line->>'size_us')::numeric(4,1)
    );

    insert into reservations (order_id, variant_id, cantidad, status, expires_at)
    values (
      v_order_id,
      (v_line->>'variant_id')::uuid,
      (v_line->>'cantidad')::integer,
      'activa',
      v_expires_at
    );
  end loop;

  -- --- Paso 6: auditoria -------------------------------------------
  insert into order_events (order_id, from_status, to_status, evento, actor, metadata)
  values (
    v_order_id, null, 'pendiente_pago', 'pedido_creado', 'cliente',
    jsonb_build_object(
      'subtotal_cents', v_subtotal_cents,
      'discount_cents', v_discount_cents,
      'shipping_cents', v_shipping_cents,
      'total_cents',    v_total_cents,
      'payment_cents',  v_payment_cents,
      'items',          v_lines,
      'expires_at',     v_expires_at
    )
  );

  return v_order_id;
end;
$fn$;

comment on function create_order_with_reservations(
  text, jsonb, jsonb, payment_method, shipping_mode, integer, integer, smallint, integer, jsonb
) is
  'Crea pedido + cliente + lineas + reservas de forma atomica. Bloquea las variantes con for update en orden ascendente de id (anti-deadlock) y calcula los importes con precios leidos de la base.';

-- Solo el backend (service_role) crea pedidos. Nunca el navegador.
-- Recordatorio: Postgres concede EXECUTE a PUBLIC al crear la funcion, y
-- service_role hereda de PUBLIC; tras el revoke hay que reconceder a mano.
revoke all on function create_order_with_reservations(
  text, jsonb, jsonb, payment_method, shipping_mode, integer, integer, smallint, integer, jsonb
) from public, anon, authenticated;

grant execute on function create_order_with_reservations(
  text, jsonb, jsonb, payment_method, shipping_mode, integer, integer, smallint, integer, jsonb
) to service_role;

-- ---------------------------------------------------------------------
-- 3. expire_stale_reservations()
-- Libera el inventario de los checkouts abandonados. Pensada para cron.
-- ---------------------------------------------------------------------

create or replace function expire_stale_reservations()
returns integer
language plpgsql
as $fn$
declare
  v_pedidos_expirados integer := 0;
  v_order             record;
begin
  -- 1) Reservas activas vencidas -> expirada.
  --    Se limita a los pedidos que SIGUEN esperando pago. Un pedido en
  --    'comprobante_enviado' ya tiene un voucher esperando revision: si se le
  --    liberase el stock por vencimiento, la talla podria venderse otra vez
  --    mientras el admin aprueba el pago. Su reserva se mantiene viva hasta
  --    que la revision decida (verificado/preparando la confirma, rechazado la
  --    libera via transition_order_status).
  --    El stock fisico no se toca: nunca se habia descontado.
  update reservations r
  set status = 'expirada'
  where r.status = 'activa'
    and r.expires_at <= now()
    and exists (
      select 1 from orders o
      where o.id = r.order_id
        and o.status = 'pendiente_pago'
    );

  -- 2) Pedidos que seguian esperando pago y cuyo plazo vencio.
  --    Se recorren en orden de id (misma disciplina anti-deadlock) y se audita
  --    cada uno individualmente, porque order_events necesita el order_id.
  --    skip locked: si otra ejecucion del cron se solapa, esta ignora las filas
  --    que la otra ya esta procesando en vez de quedarse esperando.
  for v_order in
    select o.id, o.reserved_until
    from orders o
    where o.status = 'pendiente_pago'
      and o.reserved_until is not null
      and o.reserved_until <= now()
    order by o.id
    for update skip locked
  loop
    update orders
    set status = 'expirado'
    where id = v_order.id;

    insert into order_events (order_id, from_status, to_status, evento, actor, motivo, metadata)
    values (
      v_order.id, 'pendiente_pago', 'expirado', 'pedido_expirado', 'sistema',
      'Se agoto el plazo de pago y se libero el stock reservado',
      jsonb_build_object('reserved_until', v_order.reserved_until)
    );

    v_pedidos_expirados := v_pedidos_expirados + 1;
  end loop;

  return v_pedidos_expirados;
end;
$fn$;

comment on function expire_stale_reservations() is
  'Expira reservas vencidas y sus pedidos pendientes de pago, registra el evento y devuelve cuantos pedidos expiro. Debe agendarse por cron.';

revoke all on function expire_stale_reservations() from public, anon, authenticated;
grant execute on function expire_stale_reservations() to service_role;

-- ---------------------------------------------------------------------
-- 4. transition_order_status()
-- Maquina de estados validada EN LA BASE.
-- No basta con validarla en la app: los webhooks, el panel de admin, los
-- scripts de mantenimiento y el cron son cuatro caminos distintos hacia la
-- misma fila. La unica barrera que cubre los cuatro esta aqui.
-- ---------------------------------------------------------------------

create or replace function transition_order_status(
  p_order_id uuid,
  p_to       order_status,
  p_actor    text,
  p_motivo   text default null
)
returns void
language plpgsql
as $fn$
declare
  v_from      order_status;
  v_permitido order_status[];
  v_res       record;
begin
  if p_actor is null or length(trim(p_actor)) = 0 then
    raise exception 'actor obligatorio para auditar la transicion' using errcode = 'P0001';
  end if;

  -- Se bloquea el pedido para que dos transiciones simultaneas no se pisen.
  select o.status into v_from
  from orders o
  where o.id = p_order_id
  for update;

  if not found then
    raise exception 'pedido inexistente: %', p_order_id using errcode = 'P0001';
  end if;

  if v_from = p_to then
    -- Idempotente: reintentar la misma transicion no es un error ni genera evento.
    return;
  end if;

  -- Tabla de transiciones. entregado, cancelado y expirado son TERMINALES.
  -- Nota operativa: en 'rechazado' las reservas ya se liberaron, asi que volver
  -- a 'pendiente_pago' NO recupera la reserva de stock. Si al reintentar el
  -- pago la talla ya se vendio, la app debe revalidar disponibilidad antes de
  -- prometer el envio.
  v_permitido := case v_from
    when 'pendiente_pago'      then array['comprobante_enviado','preparando','expirado','cancelado']::order_status[]
    when 'comprobante_enviado' then array['verificado','rechazado']::order_status[]
    when 'verificado'          then array['preparando','cancelado']::order_status[]
    when 'rechazado'           then array['pendiente_pago','cancelado']::order_status[]
    when 'preparando'          then array['enviado','cancelado']::order_status[]
    when 'enviado'             then array['entregado']::order_status[]
    else array[]::order_status[]
  end;

  if not (p_to = any (v_permitido)) then
    raise exception 'transicion invalida: % -> %', v_from, p_to using errcode = 'P0001';
  end if;

  update orders set status = p_to where id = p_order_id;

  if p_to = 'preparando' then
    -- Se confirma la venta: las reservas pasan a confirmada y AHORA si se
    -- descuenta el stock fisico. El orden ascendente por variant_id repite la
    -- misma disciplina anti-deadlock de create_order_with_reservations().
    --
    -- Se incluyen tambien las reservas 'expirada': si el admin aprueba el pago
    -- despues del plazo, el par igual sale del almacen y el stock debe bajar.
    -- greatest(...,0) protege del caso raro en que la unidad se hubiese vendido
    -- a otro cliente mientras la reserva estaba caida; ese conflicto se
    -- resuelve fuera de la base (reponer o reembolsar), no dejando stock
    -- negativo.
    for v_res in
      select r.variant_id, sum(r.cantidad)::integer as cantidad
      from reservations r
      where r.order_id = p_order_id
        and r.status in ('activa', 'expirada')
      group by r.variant_id
      order by 1
    loop
      perform 1 from variants v where v.id = v_res.variant_id for update;

      update variants v
      set stock = greatest(v.stock - v_res.cantidad, 0)
      where v.id = v_res.variant_id;
    end loop;

    update reservations
    set status = 'confirmada'
    where order_id = p_order_id
      and status in ('activa', 'expirada');

  elsif p_to in ('rechazado', 'cancelado', 'expirado') then
    -- Se libera lo reservado. Si el pedido ya estaba en preparando o enviado,
    -- las reservas eran 'confirmada' y el stock ya se habia descontado: hay
    -- que devolverlo al inventario para no perder unidades.
    for v_res in
      select r.variant_id, sum(r.cantidad)::integer as cantidad
      from reservations r
      where r.order_id = p_order_id
        and r.status = 'confirmada'
      group by r.variant_id
      order by 1
    loop
      perform 1 from variants v where v.id = v_res.variant_id for update;

      update variants v
      set stock = v.stock + v_res.cantidad
      where v.id = v_res.variant_id;
    end loop;

    -- Las reservas 'activa' o 'expirada' nunca descontaron stock: basta con
    -- marcarlas liberadas.
    update reservations
    set status = 'liberada'
    where order_id = p_order_id
      and status in ('activa', 'confirmada', 'expirada');
  end if;

  -- Siempre se audita.
  insert into order_events (order_id, from_status, to_status, evento, actor, motivo)
  values (p_order_id, v_from, p_to, 'cambio_estado', p_actor, p_motivo);
end;
$fn$;

comment on function transition_order_status(uuid, order_status, text, text) is
  'Aplica una transicion de estado validandola contra la maquina de estados. Confirma reservas y descuenta stock al pasar a preparando; libera y reintegra al cancelar, rechazar o expirar. Siempre audita en order_events.';

revoke all on function transition_order_status(uuid, order_status, text, text)
  from public, anon, authenticated;
grant execute on function transition_order_status(uuid, order_status, text, text)
  to service_role;

-- ---------------------------------------------------------------------
-- 5. public_order_tracking()
-- Unica puerta del seguimiento publico.
--
-- DECISION DE SEGURIDAD: en lugar de abrir orders por RLS con la reference
-- como filtro, se expone esta funcion security definer que devuelve una LISTA
-- BLANCA de campos. Diferencia practica: si manana se anade una columna
-- sensible a orders (nota interna, margen, telefono de respaldo), esta funcion
-- sigue devolviendo lo mismo, mientras que una politica "select * where
-- reference = X" la habria filtrado sin que nadie lo notase.
--
-- NUNCA se devuelve: apellidos, dni, email, telefono, direccion completa,
-- voucher_path, operation_number, costos, margenes ni payment_cents.
--
-- CONDICION IMPRESCINDIBLE: la reference es la unica credencial de acceso, asi
-- que debe generarse con ENTROPIA suficiente y no ser secuencial. Un COCO-0001
-- correlativo permitiria enumerar todos los pedidos de la tienda. Se recomienda
-- un sufijo aleatorio (base32 sin caracteres ambiguos, >= 8 simbolos) y rate
-- limiting en el endpoint que llama a esta funcion.
-- ---------------------------------------------------------------------

create or replace function public_order_tracking(p_reference text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  v_result jsonb;
begin
  select jsonb_build_object(
    'reference',    o.reference,
    'status',       o.status,
    'created_at',   o.created_at,
    'total_cents',  o.total_cents,
    -- Solo el nombre de pila: suficiente para que el cliente reconozca su
    -- pedido, insuficiente para identificar a una persona.
    'nombre_pila',  split_part(coalesce(c.nombre, ''), ' ', 1),
    'items', coalesce((
      select jsonb_agg(
               jsonb_build_object(
                 'modelo',   oi.product_modelo,
                 'colorway', oi.product_colorway,
                 'size_us',  oi.size_us,
                 'cantidad', oi.cantidad
               )
               order by oi.created_at
             )
      from order_items oi
      where oi.order_id = o.id
    ), '[]'::jsonb),
    'envio', (
      select jsonb_build_object(
               'guia',            s.guia,
               'pickup_code',     s.pickup_code,
               'agencia_destino', o.agencia_destino,
               'tracking_url',    s.tracking_url,
               'hitos',           coalesce(s.hitos, '[]'::jsonb),
               'delivered',       s.delivered
             )
      from shipments s
      where s.order_id = o.id
      order by s.created_at desc
      limit 1
    )
  )
  into v_result
  from orders o
  join customers c on c.id = o.customer_id
  where o.reference = p_reference;

  -- Reference inexistente -> null. Mismo resultado para "no existe" que para
  -- "no encontrado", sin mensajes que confirmen la existencia del pedido.
  return v_result;
end;
$fn$;

comment on function public_order_tracking(text) is
  'Seguimiento publico por reference. security definer con lista blanca de campos no sensibles. Devuelve null si la reference no existe.';

grant execute on function public_order_tracking(text) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 6. check_operation_number_reuse()
-- Chequeo previo antes de aceptar un voucher: evita gastar OCR y, sobre todo,
-- evita aceptar dos veces el mismo numero de operacion.
-- ---------------------------------------------------------------------

create or replace function check_operation_number_reuse(p_operation_number text)
returns boolean
language sql
stable
security definer
set search_path = public
as $fn$
  select exists (
    select 1
    from payments p
    where p.operation_number is not null
      and p.operation_number = p_operation_number
  );
$fn$;

comment on function check_operation_number_reuse(text) is
  'True si el numero de operacion ya fue registrado en payments. Devuelve solo un booleano, nunca datos del pago.';

-- No se expone al navegador: un anonimo podria sondear numeros de operacion.
revoke all on function check_operation_number_reuse(text) from public, anon, authenticated;
grant execute on function check_operation_number_reuse(text) to service_role;

-- =====================================================================
-- AGENDADO OBLIGATORIO
--
-- expire_stale_reservations() NO se ejecuta sola. Sin un agendado periodico,
-- cada checkout abandonado deja stock reservado para siempre: available_stock()
-- devuelve 0 y el ultimo par deja de venderse aunque siga en la caja. Es el
-- fallo mas silencioso de este diseno, porque la tienda parece funcionar.
--
-- Opcion A - pg_cron dentro de Supabase (recomendado, cada 5 minutos):
--
--   create extension if not exists pg_cron;
--   select cron.schedule(
--     'expirar-reservas',
--     '*/5 * * * *',
--     $cron$ select expire_stale_reservations(); $cron$
--   );
--
-- Opcion B - cron externo (Vercel Cron, GitHub Actions) llamando a una ruta
-- del backend que ejecute la funcion con service_role. Protegerla con un
-- secreto en cabecera: es un endpoint que muta estado.
--
-- Ademas conviene vigilar la cola outbox: si crece o los intentos suben,
-- los avisos de WhatsApp no estan saliendo.
-- =====================================================================
