# M4 — Viabilidad científica de nuevos objetivos SPHEREx

Investigación del plan aprobado, ejecutada el **14 de noviembre de 2026**. El
resultado es una evaluación de observaciones reales y posiciones de catálogo
**predichas**. No se midió movimiento, no se identificó una nueva fuente y no se
hace ninguna afirmación de descubrimiento de Planet X.

## Método reproducible

El nuevo CLI `server/spherex/research.py` reutiliza sin modificar descubrimiento,
lectura FITS, máscaras conservadoras, selección espectral y reproyección de M1.
El frontend, contrato HTTP, servicio M101 e inicialización Docker no cambian.
Los productos de investigación se guardan en `server/outputs/m4/`, ignorado por
Git, y los de M101 siguen en su directorio habitual.

Desde `server/`:

```bash
uv run --locked python -m spherex.research --timeout 20
uv run --locked python -m spherex.research --offline
# Alternativa opcional, después de las campañas principales:
uv run --locked python -m spherex.research --targets lalande21185 --max-downloads 12 --timeout 20
uv run --locked python -m spherex.research --targets lalande21185 --max-downloads 12 --offline
uv run --locked python scripts/summarize_m4.py --output ../docs/m4-evidence.json
uv run --locked pytest -q
```

`--offline` exige los mismos parámetros espaciales, temporales y de muestreo.
No descarga los productos que fallaron en vivo: conserva explícitamente la
clasificación incompleta y permite reproducir los pares de los productos que sí
se adquirieron. Cada ejecución completa conserva su manifiesto en `runs/`.
Un XML con `ERROR` o `OVERFLOW`, un fallo HTTP o un catálogo inaccesible nunca
se interpreta como ausencia de observaciones. Las respuestas brutas, URL,
fecha de adquisición, hash SHA-256, filas y duración quedan registradas.

Se consulta DR1 y QR3 con SIA2, `MAXREC=1000`, intervalo MJD 60676–61406
(2025-01-01 a 2027-01-01), y un cono pequeño que cubre la trayectoria predicha
más un margen de 36 arcsec. Se deduplican URLs de producto; releases diferentes
se conservan separadas. Los FITS verifican OBSID, detector, DATE-OBS/MJD-OBS,
unidades, WCS TAN-SIP, varianza y flags. `DATE` no se usa como época de observación.
Las longitudes de onda locales proceden de WCS-WAVE, aproximado para visualización.

Se eligen hasta dos detectores por candidato principal y uno por alternativa,
con muestreo determinista que abarca toda la serie temporal. Límites: 24
productos por detector, 192 productos y 2 GiB de productos adquiridos en toda
la caché M4; 16 MiB por archivo, límites M1 por caché/directorio y respuesta,
timeouts y descargas secuenciales. Un bloqueo entre procesos impide campañas
simultáneas en el mismo directorio. Agotar un presupuesto significa investigación
incompleta. No se amplía el muestreo cambiando los límites hasta obtener un éxito.

Cada candidato tiene **un único centro celeste fijo**, calculado de la trayectoria
2025–2027, para todas las épocas y detectores. No se recentra sobre la fuente.
Los cutouts nativos tienen el doble del lado del campo comparado de 3 arcmin;
la cuadrícula común usa la escala nativa mayor. Los umbrales permanecen:

- Separación ≥30 días.
- Cobertura común válida y espectralmente compatible ≥80% de la cuadrícula.
- Desfase espectral ≤0,25 anchos de banda y razón de anchos ≤1,2.
- Rechazo de todos los bits excepto SOURCE y FULLSAMPLE, también bits desconocidos.

Se registran **todos** los pares y rechazos, también después del primer par
aceptado. Las posiciones predichas se verifican contra la máscara común y las
máscaras nativas. El diagnóstico local registra flags, fracción válida dentro
de un radio de una FWHM (mínimo un píxel), mediana de fondo entre dos y tres
radios, varianza del píxel nativo y contraste/fondo dividido por su sigma nativa.
Esto **no es SNR fotométrica calibrada**, ni prueba de identificación o ausencia
de confusión. No se propaga varianza con la interpolación bilineal.

## Astrometría y selección de detectores

El registro versionado es `server/spherex/data/m4-targets.json`; no se emplean
presets del frontend. ICRS no tiene equinoccio: la época de **posición** se
transmite a `SkyCoord.obstime`. El movimiento en RA es siempre
`pm_ra_cosdec = dα/dt cos δ`, en mas/año.

| Objetivo | Posición de referencia (grados) y época | μα* / μδ (mas/año) | Paralaje / RV | Detectores |
|---|---|---|---|---|
| Barnard | 269.44850252543836, +4.739420051112412; J2016.0 TCB | −801.550978 / +10362.394207 | 546.975940 mas; −110.46822 km/s | D2, D6 |
| WISE 0855−0714, componente móvil | 133.787085, −7.244451; MJD 56677.3 UTC | −8060 / +700 | 454 mas; RV desconocida | D6, D5 |
| Epsilon Indi Ba/Bb | Requiere fila 2MASS J22041052−5646577 y su `jdate` | +3987.41 / −2505.35 | 274.99 mas; RV no adoptada | D2, D6 |
| Lalande 21185, alternativa | Requiere fila Gaia DR3 762815470562110464, época del catálogo | Valores de la respuesta Gaia | Valores de Gaia | D2 |

Barnard se verificó mediante consulta real a **Gaia DR3
4472832130942575872**. Incertidumbres 1σ: RA 0,02624 mas, Dec 0,02904 mas,
μα* 0,03182 mas/año, μδ 0,03607 mas/año, paralaje 0,04012 mas y RV
0,13126 km/s. La consulta ADQL exacta se conserva en el registro; usa
`gaiadr3.gaia_source` en el [archivo oficial Gaia](https://gea.esac.esa.int/archive/).
D2 y D6 son muestras exploratorias de una enana M cercana; ninguna elección
presupone que los píxeles de la estrella sean utilizables.

WISE usa las tablas 1 y 2 de [Luhman 2014](https://arxiv.org/html/1404.6501v1).
Incertidumbres: posición 0,04 arcsec, μα* 90 mas/año, μδ 70 mas/año y paralaje
45 mas. La posición de Spitzer es **observada**, no el origen baricéntrico de
un ajuste: retiene un desfase paraláctico desconocido de hasta aproximadamente
0,454 arcsec. Las incertidumbres antiguas de movimiento acumulan del orden de
1–2 arcsec hasta 2026. Se trata la astrometría J2000, calibrada con 2MASS, como
ICRS para esta visualización aproximada. La mayor emisión publicada en [4.5]
que en [3.6], junto al límite J, motiva priorizar D6 y después D5; no se convierten
magnitudes IRAC en flujos SPHEREx. Las fuentes estacionarias mezcladas documentadas
por ese trabajo impiden equiparar un píxel brillante con WISE 0855.

Epsilon B usa el movimiento baricéntrico y paralaje de la tabla 4 de
[Chen et al. 2022](https://arxiv.org/html/2205.08077v1), con errores 0,12 y
0,10 mas/año y 0,43 mas. La posición y época deben proceder de la fila
[2MASS PSC](https://irsa.ipac.caltech.edu/data/2MASS/docs/releases/allsky/doc/sec2_2a.html),
no de Epsilon Indi A ni de las cifras truncadas del nombre. Ba/Bb tienen
separación subarcsec y se consideran potencialmente **no resueltos** a la escala
SPHEREx. Propagar un fotocentro 2MASS con movimiento baricéntrico no modela las
órbitas de los componentes. D2 y D6 son elecciones exploratorias para el sistema T.

`Astropy.apply_space_motion` incluye perspectiva cuando se suministran distancia
y RV (Barnard; Lalande cuando Gaia la proporciona). RV desconocida se fija
explícitamente a cero, sin inferir una medida. No se modelan paralaje anual del
observador, órbitas ni covarianzas; las incertidumbres y errores de anclaje no
se eliminan por usar Astropy. Para estas fuentes próximas, una predicción ICRS
no sustituye un ajuste astrométrico de imágenes.

## Registro propuesto de datasets

El registro de candidatos astrométricos anterior **no** constituye un registro
de datasets publicables. Una extensión posterior puede guardar entradas
pequeñas con `id` estable, `directory`, `region` (centro, campo y WCS común),
`epochs` (OBSID, fecha UTC/MJD), `detector`, `provenance` (colecciones, URLs,
hashes y procesamiento) y `validation` (cobertura, compatibilidad y limitaciones).
Una entrada sólo se promovería tras verificar sus archivos y documentar por
separado la calidad de la fuente; una región comparable no implica movimiento
observable. M101 seguirá siendo el dataset predeterminado del contrato actual.
La selección explícita de otro dataset y nuevos endpoints quedan fuera de M4.

Referencias del método: [acceso oficial SPHEREx](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-access/),
[productos oficiales](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/),
[Astropy: propagación temporal](https://docs.astropy.org/en/stable/coordinates/apply_space_motion.html).
