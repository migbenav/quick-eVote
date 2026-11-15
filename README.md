# Votaciones de propietarios

Aplicación web mínima e independiente: Supabase + HTML/CSS/JavaScript. No requiere Kiro, Node, compilación ni framework.

## 1. Crear Supabase

1. Crea un proyecto nuevo en Supabase.
2. Abre **SQL Editor**, pega `database.sql` y ejecuta el script.
3. En **Authentication > Users**, crea el usuario del administrador con correo y contraseña.
4. Copia el UUID de ese usuario.
5. En SQL Editor ejecuta:
   ```sql
   insert into public.admin_users(user_id) values ('PEGA-AQUI-EL-UUID');
   ```
6. En **Project Settings > API**, copia Project URL y la clave `anon` / `publishable`.
7. Pega ambos valores en `config.js`.

## 2. Ejecutar localmente

No abras los HTML con doble clic porque los módulos JavaScript pueden ser bloqueados por el navegador. Usa un servidor estático local, por ejemplo la extensión **Live Server** de VS Code, o publica la carpeta en un hosting estático.

Las rutas son:
- Administración: `/admin/`
- Participantes: `/vote/`

## 3. Preparar la reunión

1. Ingresa en `/admin/`.
2. Crea la reunión.
3. Carga las **unidades**, cada una con su propio porcentaje:
   - **Masiva (recomendada):** en la sección 2 usa **Descargar plantilla**, llena el CSV, cárgalo y pulsa **Revisar CSV**. Verás la vista previa y solo podrás importar cuando todo esté correcto.
   - **Manual:** agrega o actualiza una unidad con el formulario inferior.
4. Usa el **código de voto** para agrupar las unidades que votan juntas. Ejemplo: `A704` (0.59) y `E05` (0.20) con el mismo código `C001`. Cuando `C001` emite un voto, aporta 0.79. No es necesario juntar las unidades en una sola fila.
5. Las unidades que no deben votar se dejan con el código de voto vacío o con `activo = NO`. Siguen existiendo en el padrón, pero no suman.
6. `Máximo de votos` normalmente es 1. Si varios copropietarios comparten el código y deben emitir votos separados, indica el número permitido.
7. Crea una pregunta con sus opciones, una por línea.
8. Mientras esté en **Borrador**, puedes usar **Editar** para corregir el texto o las opciones, o **Eliminar** para quitarla. También puedes editar una pregunta **Cerrada** que todavía no tenga votos.
9. Activa la pregunta y comparte `/vote/` con los participantes. Solo una pregunta puede estar activa a la vez, pero puedes activar cualquier borrador en el orden que quieras: no hace falta reordenar la lista.

Una vez que una pregunta tiene votos registrados ya no se puede editar ni eliminar, para no alterar resultados. Si necesitas cambiar el planteamiento, crea una pregunta nueva.

La agrupación puede cambiar en cualquier momento reimportando el CSV: las unidades se actualizan por su código de unidad y el código de voto se reasigna. Haz estos cambios antes de abrir la votación, porque los resultados se recalculan con las unidades actuales.

## 3.1 Formato del CSV

La primera fila debe tener los encabezados. El orden de las columnas no importa:

```csv
unidad;descripcion;porcentaje;codigo_voto;contacto;max_votos;activo
A704;Dpto. 704;0,59;C001;Juan Perez;1;SI
E05;Estacionamiento E05;0,20;C001;Juan Perez;1;SI
A705;Dpto. 705;0,40;;;1;NO
```

- `unidad`: obligatoria y única dentro de la reunión. Se convierte a mayúsculas.
- `descripcion`: si falta, se usa el código de unidad.
- `porcentaje` (o `participacion`, `alicuota`): obligatorio, mayor o igual a 0.
- `codigo_voto` (o `grupo`, `codigo_contacto`): opcional. Las unidades con el mismo código suman su porcentaje y votan juntas. Si la celda está vacía, la unidad no vota. Si no incluyes esta columna, cada unidad queda como su propio código de voto.
- `contacto`: opcional. Se usa como etiqueta del código de voto cuando se crea.
- `max_votos`: opcional, entero mayor o igual a 1. Si incluyes la columna, actualiza el máximo del código; si hay valores distintos para un mismo código, se usa el mayor.
- `activo`: opcional, `SI`/`NO` (también `1`/`0`). Por defecto `SI`. Una unidad inactiva no suma aunque tenga código de voto.

También puedes usar `codigo` en lugar de `unidad`; si el archivo trae `unidad` y `codigo`, `codigo` se interpreta como código de voto.

Se aceptan `;`, `,` o tabulador como separador, y `0,59` o `0.59` como decimal. Para Excel en español conviene guardar como **CSV (delimitado por punto y coma)**. Hay un archivo de ejemplo en `ejemplo-unidades.csv`.

La importación es idempotente: si una unidad ya existe, se actualizan su descripción, porcentaje, código de voto y estado. Los códigos de voto que no existen se crean automáticamente. Si hay errores en alguna fila, no se importa ninguna para evitar cargas incompletas.

La opción **Reemplazar todas las unidades** sirve para corregir el padrón completo o pasar de la versión anterior: borra las unidades de la reunión y elimina los códigos de voto que queden sin uso. Se bloquea si la reunión ya tiene votos registrados, para no alterar resultados históricos.

## 3.2 Si ya tenías la base de datos creada

Vuelve a ejecutar `database.sql` completo en Supabase. Es idempotente: crea la tabla `voting_units`, actualiza las funciones y no borra los datos existentes.

Los códigos creados con la versión anterior que todavía no tengan unidades siguen usando su `weight` guardado. En cuanto cargas unidades para ese código, el peso pasa a calcularse como la suma de sus unidades activas.

## 4. Regla de ponderación

El peso de un código de voto es la **suma de los porcentajes de sus unidades activas**. Ese peso se reparte entre los votos efectivamente recibidos con ese código.

Ejemplo: si `C001` agrupa A704 (0.59%) y E05 (0.20%), su peso es 0.79%. Si registra un solo voto, ese voto aporta 0.79 puntos porcentuales. Si permite hasta dos votos y recibe dos, cada uno aporta 0.395. Los votos de un mismo código pueden seleccionar opciones diferentes si se habilitaron varios votos.

Las unidades inactivas o sin código de voto no suman. Los resultados solo pueden consultarse con una cuenta autorizada como administrador.

## 5. Límites de esta versión inicial

- No identifica individualmente a la persona que emite cada voto.
- Un código compartido no permite comprobar que cada envío provenga de un copropietario diferente.
- Las unidades y sus porcentajes se cargan por CSV o manualmente desde el panel.
- Cambiar unidades o agrupaciones después de emitidos los votos recalcula los resultados; haz los cambios antes de abrir la votación.
- No hay recuperación automática de contraseñas dentro de la interfaz; se gestiona desde Supabase.
- Antes de usarla en una votación oficial, prueba el flujo completo con datos ficticios y verifica el padrón y los porcentajes.

## Seguridad importante

La clave `anon` / `publishable` puede estar en el navegador; nunca pongas una clave `service_role` en `config.js`. La seguridad se apoya en RLS y en las funciones SQL. No des acceso de administrador a participantes.
