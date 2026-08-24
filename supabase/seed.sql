-- =====================================================================
-- seed.sql
-- Datos de arranque para desarrollo y demo.
--
-- Notas:
--   * Todos los importes en CENTIMOS de sol (19900 = S/ 199.00).
--   * cost_cents ronda el 55-65% del precio de venta.
--   * Idempotente: on conflict do nothing en todo, se puede reejecutar.
--   * IMPORTANTE: nota_calce se deja en null o con un texto marcado
--     explicitamente como plantilla. NO se inventan datos de calce: solo el
--     comerciante, que tiene el par en la mano, puede afirmar si calza grande
--     o pequeno. Un dato de calce inventado genera devoluciones reales.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Marcas
-- ---------------------------------------------------------------------

insert into brands (slug, nombre, logo_url, activo, orden) values
  ('converse',    'Converse',    'https://placehold.co/200x200/111111/ffffff?text=Converse',    true, 1),
  ('vans',        'Vans',        'https://placehold.co/200x200/111111/ffffff?text=Vans',        true, 2),
  ('new-balance', 'New Balance', 'https://placehold.co/200x200/111111/ffffff?text=New+Balance', true, 3),
  ('adidas',      'Adidas',      'https://placehold.co/200x200/111111/ffffff?text=Adidas',      true, 4)
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------
-- Productos
-- ---------------------------------------------------------------------

insert into products (
  slug, brand_id, modelo, colorway, silueta, descripcion, condicion,
  cost_cents, price_cents, compare_at_price_cents,
  nota_calce, garantia_originalidad, activo, destacado
)
select
  d.slug,
  b.id,
  d.modelo,
  d.colorway,
  d.silueta,
  d.descripcion,
  d.condicion,
  d.cost_cents,
  d.price_cents,
  d.compare_at_price_cents,
  d.nota_calce,
  d.garantia_originalidad,
  true,
  d.destacado
from (values
  (
    'converse-chuck-taylor-all-star-classic-negro', 'converse',
    'Chuck Taylor All Star Classic', 'Negro / Blanco', 'high top',
    'La lona alta de siempre. Puntera de goma, ojales metalicos y suela vulcanizada. El basico que combina con todo.',
    'nuevo_en_caja', 13100, 21900, 24900,
    null,
    'Producto original importado. Se entrega con caja y etiquetas de fabrica.',
    true
  ),
  (
    'converse-chuck-70-blanco', 'converse',
    'Chuck 70', 'Blanco (Parchment)', 'high top',
    'Reedicion del Chuck de los anos 70: lona mas gruesa, plantilla OrthoLite acolchada y puntera con acabado brillante.',
    'nuevo_en_caja', 17500, 27900, null,
    null,
    'Producto original importado. Se entrega con caja y etiquetas de fabrica.',
    true
  ),
  (
    'vans-old-skool-negro-blanco', 'vans',
    'Old Skool', 'Negro / Blanco', 'skate',
    'El clasico con la franja lateral. Refuerzo de lona y suede, suela waffle de goma.',
    'nuevo_en_caja', 15500, 25900, 28900,
    null,
    'Producto original importado. Se entrega con caja y etiquetas de fabrica.',
    true
  ),
  (
    'vans-authentic-negro-blanco', 'vans',
    'Authentic', 'Negro / Blanco', 'low top',
    'El modelo mas simple de Vans: lona, cordones y suela waffle. Bajo y liviano.',
    'nuevo_en_caja', 11900, 19900, null,
    null,
    'Producto original importado. Se entrega con caja y etiquetas de fabrica.',
    false
  ),
  (
    'new-balance-550-blanco-verde', 'new-balance',
    '550', 'Blanco / Verde', 'low top',
    'Silueta de basquet de los 80 recuperada. Cuero perforado en el empeine y detalles en contraste.',
    'nuevo_en_caja', 23900, 39900, null,
    -- PLANTILLA para el comerciante, no un dato verificado:
    'EJEMPLO A COMPLETAR POR EL COMERCIANTE: probar el par y anotar aqui la observacion real de calce. Borrar este texto antes de publicar.',
    'Producto original importado. Se entrega con caja y etiquetas de fabrica.',
    true
  ),
  (
    'adidas-samba-og-negro-blanco', 'adidas',
    'Samba OG', 'Core Black / Cloud White / Gum', 'low top',
    'Cuero negro con las tres bandas en blanco, puntera de suede y suela de goma color caramelo.',
    'nuevo_en_caja', 26900, 44900, 49900,
    -- PLANTILLA para el comerciante, no un dato verificado:
    'EJEMPLO A COMPLETAR POR EL COMERCIANTE: probar el par y anotar aqui la observacion real de calce. Borrar este texto antes de publicar.',
    'Producto original importado. Se entrega con caja y etiquetas de fabrica.',
    true
  )
) as d(
  slug, brand_slug, modelo, colorway, silueta, descripcion, condicion,
  cost_cents, price_cents, compare_at_price_cents,
  nota_calce, garantia_originalidad, destacado
)
join brands b on b.slug = d.brand_slug
on conflict (slug) do nothing;

-- ---------------------------------------------------------------------
-- Imagenes (placeholders). alt descriptivo real, no "imagen1".
-- ---------------------------------------------------------------------

insert into product_images (product_id, url, alt, orden, es_principal)
select p.id, d.url, d.alt, d.orden, d.es_principal
from (values
  ('converse-chuck-taylor-all-star-classic-negro',
   'https://placehold.co/800x800/111111/ffffff?text=Chuck+Taylor+Negro',
   'Converse Chuck Taylor All Star Classic negra de cana alta, vista lateral exterior', 0, true),
  ('converse-chuck-taylor-all-star-classic-negro',
   'https://placehold.co/800x800/222222/ffffff?text=Chuck+Taylor+Suela',
   'Suela vulcanizada beige del Converse Chuck Taylor All Star negro', 1, false),

  ('converse-chuck-70-blanco',
   'https://placehold.co/800x800/f5f5f0/111111?text=Chuck+70+Blanco',
   'Converse Chuck 70 blanco de cana alta con puntera brillante, vista lateral exterior', 0, true),
  ('converse-chuck-70-blanco',
   'https://placehold.co/800x800/e8e8e0/111111?text=Chuck+70+Detalle',
   'Detalle del parche de talon y los ojales metalicos del Converse Chuck 70 blanco', 1, false),

  ('vans-old-skool-negro-blanco',
   'https://placehold.co/800x800/111111/ffffff?text=Vans+Old+Skool',
   'Vans Old Skool negro con la franja lateral blanca, vista lateral exterior', 0, true),
  ('vans-old-skool-negro-blanco',
   'https://placehold.co/800x800/222222/ffffff?text=Old+Skool+Waffle',
   'Suela waffle de goma del Vans Old Skool negro vista desde abajo', 1, false),

  ('vans-authentic-negro-blanco',
   'https://placehold.co/800x800/111111/ffffff?text=Vans+Authentic',
   'Vans Authentic negro de lona baja con suela blanca, vista lateral exterior', 0, true),

  ('new-balance-550-blanco-verde',
   'https://placehold.co/800x800/f5f5f5/1b5e20?text=New+Balance+550',
   'New Balance 550 blanco con detalles verdes, vista lateral exterior', 0, true),
  ('new-balance-550-blanco-verde',
   'https://placehold.co/800x800/eeeeee/1b5e20?text=NB+550+Detalle',
   'Detalle de la N de fieltro verde sobre el cuero perforado del New Balance 550', 1, false),

  ('adidas-samba-og-negro-blanco',
   'https://placehold.co/800x800/111111/ffffff?text=Samba+OG',
   'Adidas Samba OG negro con tres bandas blancas y suela de goma caramelo, vista lateral', 0, true),
  ('adidas-samba-og-negro-blanco',
   'https://placehold.co/800x800/222222/d7b377?text=Samba+Suela',
   'Suela de goma color caramelo del Adidas Samba OG negro', 1, false)
) as d(slug, url, alt, orden, es_principal)
join products p on p.slug = d.slug
-- product_images no tiene clave natural unica, asi que la idempotencia se
-- resuelve con un not exists sobre (product_id, url) en lugar de on conflict.
where not exists (
  select 1 from product_images img
  where img.product_id = p.id and img.url = d.url
);

-- ---------------------------------------------------------------------
-- Variantes (tallas)
--
-- Equivalencias usadas (chart de hombre):
--   US 6=EU 38.5=24.0cm   US 6.5=EU 39=24.5cm   US 7=EU 40=25.0cm
--   US 7.5=EU 40.5=25.5cm US 8=EU 41=26.0cm     US 8.5=EU 42=26.5cm
--   US 9=EU 42.5=27.0cm   US 9.5=EU 43=27.5cm   US 10=EU 44=28.0cm
--   US 10.5=EU 44.5=28.5cm US 11=EU 45=29.0cm
--
-- El stock incluye a proposito varias tallas en 0 (agotado -> lista de espera)
-- y varias en 1 (ultima unidad -> aviso de stock bajo).
-- ---------------------------------------------------------------------

insert into variants (product_id, size_us, size_eu, size_cm, sku, stock, activo)
select p.id, d.size_us, d.size_eu, d.size_cm, d.sku, d.stock, true
from (values
  -- Chuck Taylor All Star Classic negro
  ('converse-chuck-taylor-all-star-classic-negro',  6.0, 38.5, 24.0, 'CVS-CTAS-BLK-060', 2),
  ('converse-chuck-taylor-all-star-classic-negro',  6.5, 39.0, 24.5, 'CVS-CTAS-BLK-065', 1),
  ('converse-chuck-taylor-all-star-classic-negro',  7.0, 40.0, 25.0, 'CVS-CTAS-BLK-070', 4),
  ('converse-chuck-taylor-all-star-classic-negro',  7.5, 40.5, 25.5, 'CVS-CTAS-BLK-075', 3),
  ('converse-chuck-taylor-all-star-classic-negro',  8.0, 41.0, 26.0, 'CVS-CTAS-BLK-080', 5),
  ('converse-chuck-taylor-all-star-classic-negro',  8.5, 42.0, 26.5, 'CVS-CTAS-BLK-085', 0),
  ('converse-chuck-taylor-all-star-classic-negro',  9.0, 42.5, 27.0, 'CVS-CTAS-BLK-090', 3),
  ('converse-chuck-taylor-all-star-classic-negro',  9.5, 43.0, 27.5, 'CVS-CTAS-BLK-095', 1),
  ('converse-chuck-taylor-all-star-classic-negro', 10.0, 44.0, 28.0, 'CVS-CTAS-BLK-100', 2),
  ('converse-chuck-taylor-all-star-classic-negro', 11.0, 45.0, 29.0, 'CVS-CTAS-BLK-110', 0),

  -- Chuck 70 blanco
  ('converse-chuck-70-blanco',  7.0, 40.0, 25.0, 'CVS-C70-WHT-070', 2),
  ('converse-chuck-70-blanco',  8.0, 41.0, 26.0, 'CVS-C70-WHT-080', 3),
  ('converse-chuck-70-blanco',  8.5, 42.0, 26.5, 'CVS-C70-WHT-085', 1),
  ('converse-chuck-70-blanco',  9.0, 42.5, 27.0, 'CVS-C70-WHT-090', 2),
  ('converse-chuck-70-blanco',  9.5, 43.0, 27.5, 'CVS-C70-WHT-095', 0),
  ('converse-chuck-70-blanco', 10.0, 44.0, 28.0, 'CVS-C70-WHT-100', 2),
  ('converse-chuck-70-blanco', 10.5, 44.5, 28.5, 'CVS-C70-WHT-105', 1),
  ('converse-chuck-70-blanco', 11.0, 45.0, 29.0, 'CVS-C70-WHT-110', 0),

  -- Vans Old Skool negro/blanco
  ('vans-old-skool-negro-blanco',  6.0, 38.5, 24.0, 'VNS-OS-BLKWHT-060', 1),
  ('vans-old-skool-negro-blanco',  7.0, 40.0, 25.0, 'VNS-OS-BLKWHT-070', 3),
  ('vans-old-skool-negro-blanco',  7.5, 40.5, 25.5, 'VNS-OS-BLKWHT-075', 2),
  ('vans-old-skool-negro-blanco',  8.0, 41.0, 26.0, 'VNS-OS-BLKWHT-080', 6),
  ('vans-old-skool-negro-blanco',  8.5, 42.0, 26.5, 'VNS-OS-BLKWHT-085', 4),
  ('vans-old-skool-negro-blanco',  9.0, 42.5, 27.0, 'VNS-OS-BLKWHT-090', 2),
  ('vans-old-skool-negro-blanco',  9.5, 43.0, 27.5, 'VNS-OS-BLKWHT-095', 1),
  ('vans-old-skool-negro-blanco', 10.0, 44.0, 28.0, 'VNS-OS-BLKWHT-100', 3),
  ('vans-old-skool-negro-blanco', 10.5, 44.5, 28.5, 'VNS-OS-BLKWHT-105', 0),
  ('vans-old-skool-negro-blanco', 11.0, 45.0, 29.0, 'VNS-OS-BLKWHT-110', 1),

  -- Vans Authentic negro/blanco (solo tallas enteras)
  ('vans-authentic-negro-blanco',  6.0, 38.5, 24.0, 'VNS-AUT-BLKWHT-060', 2),
  ('vans-authentic-negro-blanco',  7.0, 40.0, 25.0, 'VNS-AUT-BLKWHT-070', 4),
  ('vans-authentic-negro-blanco',  8.0, 41.0, 26.0, 'VNS-AUT-BLKWHT-080', 3),
  ('vans-authentic-negro-blanco',  9.0, 42.5, 27.0, 'VNS-AUT-BLKWHT-090', 1),
  ('vans-authentic-negro-blanco', 10.0, 44.0, 28.0, 'VNS-AUT-BLKWHT-100', 0),
  ('vans-authentic-negro-blanco', 11.0, 45.0, 29.0, 'VNS-AUT-BLKWHT-110', 2),

  -- New Balance 550 blanco/verde
  ('new-balance-550-blanco-verde',  7.0, 40.0, 25.0, 'NB-550-WHTGRN-070', 1),
  ('new-balance-550-blanco-verde',  8.0, 41.0, 26.0, 'NB-550-WHTGRN-080', 2),
  ('new-balance-550-blanco-verde',  8.5, 42.0, 26.5, 'NB-550-WHTGRN-085', 2),
  ('new-balance-550-blanco-verde',  9.0, 42.5, 27.0, 'NB-550-WHTGRN-090', 1),
  ('new-balance-550-blanco-verde',  9.5, 43.0, 27.5, 'NB-550-WHTGRN-095', 0),
  ('new-balance-550-blanco-verde', 10.0, 44.0, 28.0, 'NB-550-WHTGRN-100', 1),
  ('new-balance-550-blanco-verde', 10.5, 44.5, 28.5, 'NB-550-WHTGRN-105', 0),
  ('new-balance-550-blanco-verde', 11.0, 45.0, 29.0, 'NB-550-WHTGRN-110', 1),

  -- Adidas Samba OG negro/blanco
  ('adidas-samba-og-negro-blanco',  6.0, 38.5, 24.0, 'ADI-SMB-BLK-060', 0),
  ('adidas-samba-og-negro-blanco',  7.0, 40.0, 25.0, 'ADI-SMB-BLK-070', 2),
  ('adidas-samba-og-negro-blanco',  7.5, 40.5, 25.5, 'ADI-SMB-BLK-075', 1),
  ('adidas-samba-og-negro-blanco',  8.0, 41.0, 26.0, 'ADI-SMB-BLK-080', 3),
  ('adidas-samba-og-negro-blanco',  8.5, 42.0, 26.5, 'ADI-SMB-BLK-085', 2),
  ('adidas-samba-og-negro-blanco',  9.0, 42.5, 27.0, 'ADI-SMB-BLK-090', 1),
  ('adidas-samba-og-negro-blanco',  9.5, 43.0, 27.5, 'ADI-SMB-BLK-095', 1),
  ('adidas-samba-og-negro-blanco', 10.0, 44.0, 28.0, 'ADI-SMB-BLK-100', 2),
  ('adidas-samba-og-negro-blanco', 11.0, 45.0, 29.0, 'ADI-SMB-BLK-110', 0)
) as d(slug, size_us, size_eu, size_cm, sku, stock)
join products p on p.slug = d.slug
on conflict (sku) do nothing;

-- ---------------------------------------------------------------------
-- Settings iniciales
-- Valores de ejemplo: el comerciante los ajusta desde el panel.
-- ---------------------------------------------------------------------

insert into settings (key, value) values
  -- Datos del Yape que se muestran en la pantalla de pago.
  ('yape',
   '{"numero": "999888777", "titular": "COCO JAMBO E.I.R.L.", "instrucciones": "Yapea el monto EXACTO, incluidos los centimos. Los centimos identifican tu pedido."}'::jsonb),

  -- Costos de envio por zona, en centimos.
  ('envio_costos',
   '{"lima_domicilio": 1500, "provincia_agencia": 2500, "recojo_tienda": 0}'::jsonb),

  -- A partir de este subtotal (en centimos) el envio es gratis: S/ 300.00.
  ('envio_gratis_desde_cents', '30000'::jsonb),

  -- Descuento por pagar con Yape directo (sin pasarela): 5%.
  ('descuento_yape_pct', '5'::jsonb),

  -- Minutos que se mantiene la reserva de stock durante el checkout.
  ('reserva_minutos', '30'::jsonb),

  -- Umbral para mostrar "ultimas unidades" en la ficha de producto.
  ('stock_bajo_umbral', '2'::jsonb),

  -- Zonas de reparto a domicilio en Lima (informativo para el front).
  ('lima_distritos_reparto',
   '["Miraflores","San Isidro","Surco","San Borja","La Molina","Jesus Maria","Lince","Magdalena","Barranco","San Miguel","Pueblo Libre","Surquillo"]'::jsonb),

  -- Datos de contacto para el boton de WhatsApp.
  ('contacto',
   '{"whatsapp": "51999888777", "horario": "Lunes a sabado de 10:00 a 20:00", "tienda": "Av. Ejemplo 123, Lima"}'::jsonb)
on conflict (key) do nothing;
