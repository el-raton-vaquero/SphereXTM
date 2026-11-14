# M4.5 — Casos científicos reales interactivos

Implementado sobre `m4-implementation`, baseline `72f5fa8`, el 14-11-2026.
Sin commits ni pushes. El clon utilizado es `/home/jorge/spaceApps/pruebaSpaceApps`:
su remoto conserva el nombre antiguo `el-raton-vaquero/pruebaSpaceApps`. El
directorio inicial de otro fork estaba en `main` y no se modificó para esta tarea.

## Reconocimiento y decisión

Se leyeron los dos `AGENTS.md`, estado, plan, contrato, integridad científica,
informe M4, registro astrométrico y código de procesamiento, servicio y UI.
El frontend local tiene Next.js 16.4.6; se consultaron sus docs instaladas de
Client Components y documentación actual de FastAPI/React/Astropy.

M4 ya aportaba FITS, hashes, épocas, astrometría referenciada, centro fijo, máscaras,
reglas espectrales, diagnósticos locales y cinco pares de campo aceptados.
**No aportaba un registro de datasets servibles**: sus manifiestos son campañas
incompletas con múltiples pares/rechazos y sus figuras no son fuentes de imágenes.

Se promueven exclusivamente WISE D6 y Barnard D2/D6. Los dos pares WISE D5 no
se incorporan; tampoco Lalande, Epsilon Indi B ni supuestas nuevas detecciones.
Los registros astrométricos M4, sus manifiestos históricos, umbrales y los locks
de dependencias se mantienen sin cambios.

## Casos disponibles y resultado reproducido

| ID | Clasificación | OBSID t1 → t2 | Píxeles comunes válidos | Desplazamiento **predicho** |
|---|---|---|---:|---:|
| `m101` | Referencia | `2026W20_2A_0464_3` → `2026W26_1A_0500_1` | 769/900 | No se atribuye movimiento |
| `wise0855-d6` | Exploratorio | `2025W19_1B_0116_1` → `2026W20_1A_0033_1` | 761/900 | 8,204330″ |
| `barnard-d2` | Limitación instrumental | `2025W35_1A_0146_1` → `2026W34_1A_0363_1` | 802/900 | 10,204182″ |
| `barnard-d6` | Limitación instrumental | `2025W33_2C_0321_1` → `2026W12_2A_0520_4` | 730/900 | 6,225254″ |

Se prepararon los tres pares M4 desde sus **seis cutouts FITS reales**, importados
de `server/outputs/m4` con verificación de sidecars y SHA-256 fijado en M4.
Se releyeron IMAGE/FLAGS/VARIANCE/WCS-WAVE y se repitió la alineación con las
reglas originales. No se utilizaron PNG como entrada ni se hicieron nuevas
búsquedas de archivo. Se reprodujeron las fracciones aceptadas, sin relajar:
≥30 días, ≥80% cobertura común compatible, ≤0,25 anchos de banda de desfase,
razón de anchos ≤1,2 y rechazo de bits salvo SOURCE/FULLSAMPLE.

### Procedencia versionada y disponibilidad

- `server/spherex/data/datasets.json`: catálogo editorial de cuatro casos,
  identidad de los pares, centro fijo, detector, clasificación y advertencias.
- `server/spherex/data/dataset-evidence.json`: subconjunto **derivado de**
  `docs/m4-evidence.json`, con su hash, productos/URLs/hashes/épocas, astrometría,
  diagnósticos locales y aceptación original. No contiene arrays de imagen.
- `server/scripts/export_dataset_evidence.py`: permite regenerar ese subconjunto.
  Una prueba comprueba su correspondencia con la evidencia M4 original.
- `spherex.datasets`: preparación explícita de **dos productos fijados por caso**,
  no una campaña dinámica. Se verifican los hashes de descarga contra M4,
  fechas/OBSID/detector y reproducibilidad de cobertura antes de publicar.
- La API lee `aligned.fits` y `manifest.json` locales. Comprueba identidad, checksum
  del alineado, vínculo a evidencia, metadatos, WCS, valores finitos y máscara
  binaria. Si faltan o son incompatibles, informa **indisponibilidad**, no demo.
- Los originales conservan adquisición y hashes; los nuevos manifiestos añaden
  fecha de preparación, parámetros/métricas, diagnósticos y checksum del alineado.
Los datos preparados y FITS no se incorporan a Git.

SHA-256 de los alineados verificados en esta entrega (los hashes de los seis
cutouts originales están fijados en `dataset-evidence.json`):

| Caso | SHA-256 `aligned.fits` |
|---|---|
| M101, idéntico a M4 | `775134edcb9c5f66602d84cdbb9c3f8945ba0c9a56cb36fa3f9c6c43fa94e19c` |
| WISE D6 | `dbcd0adae8d43a7e3a7065006c33f1e39a0788dd7c6df9b1942b08a38a0f5584` |
| Barnard D2 | `74496803b7139ce8dc5639aaddd534109e83dae5b90cd63e13c5028ffd12e129` |
| Barnard D6 | `697544cf6d6205bf21ae0ef8c3e5c583dd3ca8d20dce33945046cde48e146234` |

Los endpoints nuevos son `GET /datasets` y `GET /datasets/{id}/frames`. El proxy
existente los expone como `/api/datasets*`. `/frames`, `/health` y la preparación
M101 anterior permanecen disponibles. Las peticiones HTTP **no descargan datos**.

## Interfaz y geometría

Selector nativo etiquetado «Caso científico real», clasificación y límites
explícitos. Se actualizan imágenes, épocas, detector, longitud de onda, título y
procedencia. Cambiar caso cancela la petición anterior y descarta respuestas
atrasadas; limpia frames/épocas/overlays durante carga o error. La caché del
cliente incluye el ID del dataset y mantiene separación real/mock.

Se conservan parpadeo, fechas, cortina y diferencias; se añade vista completa
lado a lado, con la misma escala y máscara. En móvil se apila sin desbordamiento.
El selector no aparece en simulación, que conserva sus cuatro épocas generadas.

Las predicciones están separadas del raster medido y **no** utilizan
`movingTargetPixel` ni las trayectorias educativas. Se propaga la astrometría M4
con `predict` a cada `MJD-OBS`; Astropy transforma esas coordenadas mediante el
WCS completo del alineado. El píxel FITS cero-based `(x,y)` pasa a pantalla
`(x,height−1−y)`. SVG suma `0,5` para señalar el centro de la celda.

- Vista normal/blink: solo predicción de la época activa.
- Diferencia/apilado: ambas predicciones, etiquetadas t1/t2; no línea de movimiento.
- Lado a lado: cada imagen muestra su propia época.
- Cortina: predicciones ocultas explícitamente para no atribuir una marca a la
  mitad/época equivocada; siguen disponibles en lado a lado.
- Se pueden ocultar los overlays. Barnard mantiene las marcas **sobre la máscara**
  y avisa que la fuente no es evaluable, sin rellenar ni afirmar una detección.
- `wcs.screenCrpix` comunica la referencia exacta de centros cero-based para
  inspección/transformación; `crpix` heredado y su semántica permanecen compatibles.

Se corrigió también la fecha visible de `DATE-OBS`: cuando FITS omite `Z`, se
interpreta explícitamente como UTC. La regresión comprueba que
`2026-08-18T20:48:38.781` no se convierte en 19 de agosto en un navegador de México.

## Preparación y ejecución local

Desde `server/`, con los locks existentes:

```bash
uv sync --locked
# M101 mantiene su preparación independiente:
uv run --locked python -m spherex.prepare --output outputs/m101

# Comandos ejecutados, reutilizando la caché auténtica M4 presente en este clon:
uv run --locked python -m spherex.datasets --dataset wise0855-d6 --research-dir outputs/m4 --offline
uv run --locked python -m spherex.datasets --dataset barnard-d2 --research-dir outputs/m4 --offline
uv run --locked python -m spherex.datasets --dataset barnard-d6 --research-dir outputs/m4 --offline

# Si no se dispone de la caché: solo dos descargas fijadas, sin SIA ni catálogos.
# Esta ruta online nueva NO se ejerció en esta entrega:
uv run --locked python -m spherex.datasets --dataset wise0855-d6 --timeout 30

uv run --locked uvicorn spherex.api:app --host 127.0.0.1 --port 8000
```

Datos M4.5 por defecto: `server/outputs/datasets/<id>/`. Se puede cambiar con
`SPHEREX_DATASETS_DIR`; M101 sigue usando `SPHEREX_DATA_DIR` / `outputs/m101`.
`--output` permite preparar otro directorio; debe coincidir con el que la API
consulta. Preparar los casos secuencialmente. Si cambian los bytes de un producto
en IRSA, el hash fijado falla: se requiere nueva revisión, no aceptación silenciosa.

Desde `frontend/`:

```bash
npm run dev
# http://127.0.0.1:3000/?api=real&dataset=wise0855-d6
# http://127.0.0.1:3000/?api=real&dataset=barnard-d2
# http://127.0.0.1:3000/?api=mock&target=wise0855
```

Para reproducir la exportación de metadatos (sin FITS):

```bash
cd server
uv run --locked python scripts/export_dataset_evidence.py
```

### Docker persistente, opt-in

El backend lee `/data/datasets` del volumen existente en solo lectura; M101
permanece en `/data/m101`. Nuevo servicio `data-prepare`, perfil `science`, sin
dependencias desde `data-init`, `backend` ni `frontend`. Su fallo no participa en
los criterios de arranque normal de M101.

```bash
docker compose up -d --build
# Solo cuando se quieran preparar los casos adicionales:
docker compose --profile science run --build --rm data-prepare --dataset wise0855-d6
docker compose --profile science run --rm data-prepare --dataset barnard-d2
docker compose --profile science run --rm data-prepare --dataset barnard-d6
```

El perfil usa la misma imagen científica y no añade dependencias. No monta la
caché local de investigación automáticamente. Para una importación offline se
debe montar explícitamente esa caché en solo lectura y pasar `--research-dir`.
Se verificó `docker compose config --quiet`, **no** se reconstruyó/ejecutó esta
nueva imagen/perfil ni se repitió la campaña Docker M101 de la entrega anterior.

## Verificación ejecutada

| Comando / comprobación | Resultado |
|---|---|
| `cd server && uv run --locked pytest -q` | **84 passed**, 0 skipped; aviso preexistente Starlette/httpx |
| `node frontend/scripts/test-integration.cjs` | PASS; selección/races/identidad, WCS, UTC, máscaras, error sin fallback y mock |
| `cd frontend && npx tsc --noEmit` | Pasa al ejecutarse después del build |
| `cd frontend && npm run lint` | 0 errores; un aviso preexistente de fuentes en `app/layout.tsx` |
| `cd frontend && npm run build` | Pasa, Next.js 16.4.6 producción |
| Tres preparaciones M4 offline | Salida 0; pares, hashes y coberturas reproducidos |
| Inventario y cuatro endpoints por TestClient/proxy | HTTP 200, IDs/máscaras esperados |
| `docker compose config --quiet` | Pasa |
| Chromium real, producción, escritorio 1440×1000 y móvil 390×844 | PASS; cuatro datasets, overlays, lado a lado, blink, diferencia, deep link, error 503 y mock |
| `git diff --check` | Pasa |

Un `tsc` lanzado en paralelo al build encontró temporalmente `.next/types/routes.js`
ausente mientras Next regeneraba tipos. Se repitió **después** y pasó; no se
ocultó el fallo cambiando opciones TypeScript. Ejecutar esos dos comandos en serie.

El MCP de navegador no encontró su distribución Chrome. Se utilizó Playwright
**1.65.0** ya instalado en la caché externa, con Chromium headless existente;
sin modificar dependencias de la aplicación. Harness reproducible:

```bash
# Con API + frontend ejecutándose y los cuatro datasets preparados:
PLAYWRIGHT_MODULE=/ruta/a/playwright \
  node frontend/scripts/test-scientific-cases.cjs
```

En esta máquina, `PLAYWRIGHT_MODULE` fue
`/home/jorge/.npm/_npx/e41f203b7505f1fb/node_modules/playwright`.
La prueba final usó el frontend standalone después del build (copias de
`public` y `.next/static` al árbol standalone) y `HOSTNAME=127.0.0.1 PORT=3000
node .next/standalone/server.js`. El navegador se configuró en
`America/Mexico_City` para comprobar UTC.

Capturas auténticas y reporte del harness:
`docs/assets/m45-wise-desktop.png`, `m45-barnard-mobile.png`,
`m45-browser-report.json`. El único mock HTTP de esa prueba es una **inyección
explícita de error 503**, nunca imágenes simuladas etiquetadas como observaciones.
No hubo errores JavaScript de página.

## Archivos afectados

- Backend: `spherex/datasets.py`, `data/datasets.json`, `data/dataset-evidence.json`,
  `api.py`, `models.py`, `service.py`; exportador de evidencia y `tests/test_datasets.py`.
- Frontend: nuevos `ScientificCases.tsx`, `RealComparison.tsx`, `catalogOverlay.ts`,
  `observationTime.ts`; adaptador, tipos, WCS, store, página, visor, contexto,
  cabecera y CSS. Harness de integración ampliado y nuevo harness Chromium.
- Operación/documentación: `compose.yaml`, README científico, contrato, plan,
  estado y este informe/capturas.
- No se modificaron locks, astrometría M4, reglas científicas, backend de
  extracción espectral ni manifiestos históricos. No se añadieron FITS a Git.

## Límites abiertos

**Ningún caso demuestra movimiento observado validado ni Planet X.**
WISE conserva señal débil y confusión no resuelta; Barnard conserva píxeles
predichos excluidos por OVERFLOW/BLOOM (también SUR_ERROR en D2).
El desplazamiento comunicado procede de catálogo, no de centroides medidos.
La campaña M4 completa sigue siendo incompleta aunque estos pares sean
reproducibles.

Se mantienen WCS-WAVE aproximado, fondo zodiacal sin sustraer, falta de
homogeneización de PSF y de propagación de varianza/covarianzas/paralaje anual.
Las diferencias son visuales, no una significancia de variabilidad. No se
implementa extracción espectral calibrada ni búsqueda libre en cada petición.
El frontend muestra los límites científicos nuevos principalmente en español.
No se probaron otros navegadores ni dispositivos físicos.
