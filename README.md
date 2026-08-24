# Coco Jambo

Tienda de zapatillas urbanas para el mercado peruano: catálogo público, checkout con
reserva de stock, pago por Yape validado a mano y panel de administración.

Next.js 16 · React 19 · TypeScript estricto · Tailwind 4 · Supabase (Postgres + RLS)

---

## Por qué existe este proyecto

El encargo era una tienda para un comerciante que vende Converse, Vans y New Balance,
cobra por Yape y valida los comprobantes revisando capturas de pantalla. Un CRUD de
productos no resuelve eso. Los tres problemas reales son otros:

**1. El mismo par no se puede vender dos veces.** Dos personas comprando el último 41 a
la vez es una condición de carrera, y se resuelve en la base de datos, no en el código de
aplicación.

**2. Una captura de Yape se falsifica o se reutiliza en segundos.** Hace falta que el
sistema detecte lo detectable y deje el resto a criterio humano, sin fingir certezas.

**3. Casar un pago con su pedido.** Lo habitual es pedirle al cliente que escriba un
código en el mensaje del Yape. La mitad no lo hace.

---

## Las tres decisiones que definen el diseño

### Céntimos únicos: el monto identifica el pago

En vez de cobrar S/ 249.00, se cobra **S/ 249.37**. Los céntimos se asignan por pedido y
son únicos entre los pedidos que esperan pago, así que **el monto exacto apunta a un solo
pedido**. El cliente no tiene que copiar ningún código: solo pagar lo que ve en pantalla.

La unicidad la garantiza un índice parcial en Postgres:

```sql
create unique index ux_orders_payment_cents_pendientes on orders (payment_cents)
where status in ('pendiente_pago','comprobante_enviado') and payment_method = 'yape_manual';
```

Cuando dos pedidos concurrentes eligen el mismo valor, el `insert` falla con `23505` y la
aplicación reintenta con otros céntimos. Es un resultado esperado, no un bug.

**Su límite, dicho claramente:** solo hay 99 identificadores. Con 99 pedidos esperando
pago a la vez el espacio se agota y el checkout pide reintentar en unos minutos. Es
aceptable para el volumen de una tienda pequeña, y es el punto exacto donde este mecanismo
debe reemplazarse por la pasarela automática.

→ `src/lib/payment-cents.ts`

### El stock se reserva con bloqueo en la base

`create_order_with_reservations()` bloquea cada variante con `SELECT ... FOR UPDATE`
**en orden ascendente de id** antes de comprobar disponibilidad. El orden evita deadlocks
entre transacciones que compran los mismos dos modelos en distinto orden.

La disponibilidad real es `stock físico − reservas activas no expiradas`, nunca la columna
`stock` a secas. Las reservas caducan a los 30 minutos y `expire_stale_reservations()` las
libera.

Detalle no obvio: las reservas **no** expiran mientras el pedido está en
`comprobante_enviado`. Si caducaran ahí, la talla se revendería justo mientras el
comerciante revisa el voucher.

→ `supabase/migrations/0003_functions.sql`

### El sistema nunca aprueba ni rechaza un pago solo

El módulo antifraude calcula señales y puntúa el riesgo para **ordenar la cola de
verificación**: lo limpio arriba para aprobar rápido, lo dudoso marcado. Pero
`nivel: "rechazar"` es una recomendación, no una acción.

Aprobar un pago mueve dinero; rechazarlo deja a un cliente legítimo sin su compra.
Ninguna de las dos se automatiza.

→ `src/lib/fraud/risk-score.ts`

---

## Arquitectura

```
src/lib/
├── money.ts, payment-cents.ts, order-status.ts, reference.ts, sizes.ts   núcleo de dominio
├── fraud/          pHash, parser de vouchers, score de riesgo, EXIF
├── payments/       PaymentProvider: Yape manual · Tupay
├── shipping/       ShippingProvider: manual · Shalom
├── cart/           carrito en cookie firmada
├── orders/         creación, lectura pública, comprobantes
├── admin/          consultas y acciones del panel
└── supabase/       clientes por contexto (navegador · servidor · admin)

supabase/migrations/  16 tablas, 6 enums, RLS completa, 6 funciones
```

**Las dos interfaces son el punto arquitectónico.** `PaymentProvider` y
`ShippingProvider` tienen dos implementaciones cada una, intercambiables por variable de
entorno. El manual no depende de nadie y funciona desde el día uno; el automático es una
mejora que se enciende cuando hay credenciales.

Eso importa especialmente en envíos: Shalom **no publica API oficial**. Lo que existe es
un wrapper no oficial de terceros que raspa `pro.shalom.pe`. El día que Shalom cambie su
web, la respuesta es `SHALOM_ENABLED=false` y seguir despachando a mano el mismo día, no
un hotfix.

---

## Seguridad

Las decisiones que un revisor debería mirar primero:

**Ningún importe viene del cliente.** El carrito guarda `variantId` y `cantidad`; los
precios se leen de la base al mostrar y otra vez dentro de la función SQL que crea el
pedido.

**Tres capas de autorización, no una.** El `proxy.ts` redirige al login (conveniencia de
UX), el layout del panel comprueba `admin_users` en cada carga (no un claim del JWT:
revocar acceso debe surtir efecto ya), y por debajo las políticas RLS de Postgres evalúan
`is_admin()`. Un bug en cualquiera de las dos primeras no expone datos.

**Cada Server Action revalida los permisos.** Una Server Action es un endpoint HTTP:
quien conozca su identificador puede invocarla sin pasar por la página.

**Los vouchers viven en un bucket privado sin política de INSERT.** El cliente no escribe
en Storage: manda el archivo al servidor, que valida los *magic bytes* (no el
`Content-Type`, que el cliente controla), calcula hashes y lo guarda. El admin los ve por
URL firmada con 5 minutos de caducidad.

**Las referencias de pedido no son enumerables.** `COCO-7F3K2M`, 28⁶ combinaciones sobre
un alfabeto sin vocales ni caracteres confundibles al dictarlos por WhatsApp. Es la única
credencial del seguimiento público, así que un `COCO-0001` secuencial permitiría recorrer
los pedidos del negocio.

**Los webhooks se verifican sobre el cuerpo crudo**, en tiempo constante, con ventana
anti-replay y deduplicación por id de evento. Re-serializar el JSON antes de verificar es
el bug número uno de estas integraciones: cambia los bytes y la firma deja de cuadrar.

---

## Puesta en marcha

```bash
npm install
cp .env.example .env.local   # completar con las claves de Supabase
npm run dev
```

**Migraciones**, en este orden, desde el SQL Editor de Supabase:

```
supabase/migrations/0001_schema.sql
supabase/migrations/0002_rls.sql
supabase/migrations/0003_functions.sql
supabase/migrations/0004_storage.sql
supabase/seed.sql
```

**Usuario admin.** Crear el usuario en *Authentication → Users* y autorizarlo:

```sql
insert into admin_users (id, rol)
select id, 'admin' from auth.users where email = 'tu-email@ejemplo.com';
```

**Expiración de reservas.** Sin esto, cada checkout abandonado bloquea una talla para
siempre. Activar `pg_cron` y agendar:

```sql
select cron.schedule('expirar-reservas', '*/5 * * * *',
  $$select expire_stale_reservations()$$);
```

**Procesado del outbox.** La ruta `/api/cron/outbox` manda los avisos encolados. El
cron de `vercel.json` está puesto a diario porque **el plan Hobby de Vercel no admite
más de una ejecución al día**, y eso no sirve como procesado principal: el cliente
pagaría por la mañana y recibiría la confirmación al día siguiente.

La solución sin coste es agendarlo desde Supabase, que permite cron cada minuto.
Activar `pg_cron` y `pg_net` en *Database → Extensions* y ejecutar (sustituyendo
dominio y secreto):

```sql
select cron.schedule('procesar-outbox', '*/5 * * * *', $$
  select net.http_get(
    url := 'https://TU-DOMINIO.vercel.app/api/cron/outbox',
    headers := '{"Authorization": "Bearer TU_CRON_SECRET"}'::jsonb
  );
$$);

select cron.schedule('recuperar-outbox', '*/10 * * * *',
  $$select recover_stuck_outbox_events(15)$$);
```

### Variables de entorno

| Variable | Obligatoria | Notas |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | sí | |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | sí | Pública por diseño; la RLS protege los datos |
| `SUPABASE_SERVICE_ROLE_KEY` | sí | **Omite la RLS.** Solo servidor, nunca `NEXT_PUBLIC_` |
| `NEXT_PUBLIC_SITE_URL` | sí | Dominio real en producción |
| `YAPE_NUMERO`, `YAPE_TITULAR` | sí | Lo que ve el cliente al pagar |
| `PAYMENTS_TUPAY_ENABLED` | no | `false` por defecto |
| `SHALOM_ENABLED` | no | `false` por defecto |
| `CRON_SECRET` | en producción | Protege `/api/cron/outbox`. Sin él la ruta se niega a funcionar |

---

## Comandos

```bash
npm run dev         npm run build      npm start
npm run test        npm run typecheck  npm run lint
```

**653 tests.** No buscan cobertura: cubren los invariantes que, si se rompen, cuestan
dinero. Por ejemplo, que el total con céntimos únicos nunca quede por debajo del importe
real ni lo supere en más de un sol (barrido exhaustivo), que la fecha
`"2026-04-16 11:40:45"` de Shalom sea hora de Perú y no UTC, que un webhook repetido no
dispare dos veces sus efectos, y que ningún mensaje de error contenga la contraseña de
Shalom Pro.

---

## Estado y límites conocidos

**Funciona:** catálogo con filtros por talla disponible, ficha de producto, lista de
espera, carrito, checkout con reservas, pago por Yape con céntimos únicos, subida de
comprobante, seguimiento sin cuenta, panel con cola de verificación, gestión de pedidos,
ajuste de stock y lista de espera.

**Falta, y por qué:**

- **pHash y OCR sin implementar.** Necesitan `sharp` y un motor OCR. Los módulos definen
  la interfaz y están testeados, pero no se finge validar lo que no se valida: las señales
  quedan como "no verificable" y suben el peso de la revisión humana. El resto del
  antifraude sí opera (número de operación único en base, magic bytes, score de riesgo).
- **Tupay no puede vivir en serverless.** Exige whitelisting de IP de salida y Vercel usa
  IPs dinámicas: fallaría de forma intermitente, el peor modo de fallo. Requiere un host
  con IP fija o NAT estático. Por eso está apagado por defecto.
- **Sin worker del outbox.** Los avisos de WhatsApp se encolan en `outbox` pero nadie los
  consume todavía.
- **Sin historial de movimientos de inventario.** Un ajuste de stock no queda registrado,
  así que un descuadre no se puede reconstruir. Deuda consciente.
- **Alta de productos por SQL.** El formulario con subida de fotos es lo siguiente.
- **El umbral del pHash (10 sobre 64) no está calibrado con vouchers reales.** Todos los
  vouchers de Yape comparten plantilla, así que la distancia entre dos legítimos distintos
  es menor que entre dos fotos cualesquiera. Hay que recalibrarlo con un lote real antes de
  confiar en esa señal.

---

Proyecto de demostración. Los productos, precios y datos del catálogo son de ejemplo.
