-- =====================================================================
-- 0004_storage.sql
-- Bucket de vouchers de Yape y sus políticas.
--
-- POR QUÉ ES UN BUCKET PRIVADO Y NO PÚBLICO:
--
-- Un voucher de Yape es un documento con datos personales: nombre completo del
-- pagador, número de celular parcial y el monto. Un bucket público expone cada
-- comprobante a cualquiera que adivine la ruta, y las rutas de Storage son
-- adivinables si se derivan del id del pedido.
--
-- Con el bucket privado, la única forma de ver un voucher es una URL firmada que
-- el servidor genera bajo demanda para un admin autenticado, con caducidad. Ese
-- es el motivo de que `payments.voucher_path` guarde una RUTA y no una URL: la
-- URL se construye al vuelo y expira.
--
-- LIMITACIÓN DEL ENTORNO HOSPEDADO, que condiciona este archivo:
--
-- El esquema `storage` pertenece al rol `supabase_storage_admin`, no al `postgres`
-- con el que corre el SQL Editor. Se pueden INSERTAR filas en `storage.buckets`
-- (hay grants para eso), pero NO ejecutar `COMMENT ON` ni `ALTER TABLE`, que
-- exigen ser dueño de la tabla y fallan con `42501: must be owner of table`.
--
-- Por eso aquí no hay ningún `comment on` sobre tablas de `storage`, y la creación
-- de políticas va envuelta en un bloque que avisa en lugar de abortar la
-- migración: en algunos proyectos `storage.objects` también rechaza
-- `CREATE POLICY` desde SQL, y en ese caso se crean desde el panel.
--
-- Aplicar DESPUÉS de 0002_rls.sql, porque las políticas usan `public.is_admin()`.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Bucket
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'vouchers',
  'vouchers',
  -- PRIVADO. Ver la cabecera de este archivo.
  false,
  -- 5 MB: un screenshot de celular pesa entre 100 KB y 2 MB. El límite frena que
  -- alguien suba un video de 200 MB y agote la cuota del proyecto.
  5242880,
  -- Solo imágenes. Sin esta lista, el campo de "sube tu comprobante" acepta
  -- cualquier archivo ejecutable y se convierte en alojamiento gratis para
  -- malware, con el dominio del negocio dándole credibilidad.
  array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
)
on conflict (id) do update set
  public = false,
  file_size_limit = 5242880,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

-- ---------------------------------------------------------------------
-- Políticas
--
-- El cliente NO sube el voucher directamente al bucket: lo manda al servidor, que
-- lo valida (tipo real de archivo, tamaño, pHash, OCR) y lo guarda con la
-- service_role key. Por eso NO existe una política de INSERT para anon.
--
-- La alternativa (subida directa desde el navegador con una política permisiva)
-- dejaría un endpoint de escritura sin autenticar en un bucket del proyecto, y
-- haría imposible el antifraude: el hash y el OCR tienen que calcularse antes de
-- aceptar el archivo, no después.
--
-- No se crean políticas de INSERT ni UPDATE: la ausencia de política significa
-- denegado para todo rol sujeto a RLS. Las escrituras van con service_role, que
-- las omite, y por eso ocurren únicamente en el servidor.
-- ---------------------------------------------------------------------

do $$
begin
  -- Lectura: solo admins. Es lo que permite que el panel muestre el voucher en la
  -- cola de verificación.
  begin
    drop policy if exists "vouchers_select_admin" on storage.objects;
    create policy "vouchers_select_admin"
      on storage.objects for select
      using (bucket_id = 'vouchers' and public.is_admin());
  exception
    when insufficient_privilege then
      raise warning 'No se pudo crear la politica de SELECT sobre storage.objects (se necesita ser dueno de la tabla). Crearla desde el panel: Storage > Policies > vouchers. El bucket SI quedo creado y privado.';
  end;

  -- Borrado: solo admins, para poder purgar vouchers de pedidos cerrados según la
  -- política de retención de datos personales.
  begin
    drop policy if exists "vouchers_delete_admin" on storage.objects;
    create policy "vouchers_delete_admin"
      on storage.objects for delete
      using (bucket_id = 'vouchers' and public.is_admin());
  exception
    when insufficient_privilege then
      raise warning 'No se pudo crear la politica de DELETE sobre storage.objects. Crearla desde el panel: Storage > Policies > vouchers.';
  end;
end
$$;

-- ---------------------------------------------------------------------
-- Comprobación
--
-- Debe devolver una fila con public = false. Si `public` fuera true, los
-- comprobantes serían accesibles por URL directa y habría que corregirlo antes
-- de recibir el primer pago.
-- ---------------------------------------------------------------------

-- select id, public, file_size_limit, allowed_mime_types
-- from storage.buckets where id = 'vouchers';

-- ---------------------------------------------------------------------
-- Convención de rutas
--
-- `vouchers/<año>/<mes>/<order_id>/<uuid>.<ext>`
--
-- Se incluye el uuid aleatorio para que la ruta no sea deducible del pedido, y el
-- año/mes para poder purgar por antigüedad con un prefijo. El `order_id` mantiene
-- agrupados los reintentos de un mismo pedido, que es lo que el admin necesita
-- ver junto cuando un cliente sube tres capturas.
-- ---------------------------------------------------------------------
