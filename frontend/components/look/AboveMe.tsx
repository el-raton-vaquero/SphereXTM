'use client';

import { useCallback, useMemo, useState } from 'react';
import { useLocale, withLang } from '../../lib/i18n';
import { PRESETS } from '../../lib/prism/presets';
import type { GeoStatus, StarField } from '../../lib/look/hooks';
import { useClock } from '../../lib/look/hooks';
import { CITIES, type SavedPlace } from '../../lib/look/places';
import { NAMED_STARS } from '../../lib/look/stars';
import { altAzToEnu, bodyStates, enuToAltAz, enuToRadec, eqjToEnu, eqjToEnuMatrix, nextTransit } from '../../lib/look/sky';
import { HipsControls, HipsImage, RegionPanel, type HipsSource, type HipsStatus } from './SpherexViews';
import { northUpWcs, type HipsLayer } from '../../lib/look/hips';
import DomeChart from './DomeChart';

const TARGETS = PRESETS.map((p) => ({ id: p.id, name: p.name, ra: p.ra, dec: p.dec }));

function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function AboveMe({ place, geo, locate, setPlace, setCity, field }: {
  place: SavedPlace; geo: GeoStatus; locate: () => Promise<SavedPlace | null>; setPlace: (p: SavedPlace) => void; setCity: (id: string) => void; field: StarField | null;
}) {
  const { locale, t } = useLocale();
  const L = t.look;
  const [fixed, setFixed] = useState<Date | null>(null);
  const date = useClock(fixed === null, fixed);
  const [latIn, setLatIn] = useState('');
  const [lonIn, setLonIn] = useState('');
  const [pick, setPick] = useState<{ alt: number; az: number } | null>(null);
  const [layer, setLayer] = useState<HipsLayer>('color');
  const [hips, setHips] = useState<HipsStatus>('loading');
  const [hipsSrc, setHipsSrc] = useState<HipsSource>('irsa');
  const onHips = useCallback((st: HipsStatus, src: HipsSource) => { setHips(st); setHipsSrc(src); }, []);

  const tf = useMemo(() => new Intl.DateTimeFormat(locale === 'es' ? 'es' : 'en', { hour: '2-digit', minute: '2-digit' }), [locale]);
  const fmt = (d: Date | null) => (d ? tf.format(d) : '—');

  const m = useMemo(() => eqjToEnuMatrix(place, date), [place, date]);
  const bodies = useMemo(() => bodyStates(date, place, true), [date, place]);
  const sun = bodies.find((b) => b.id === 'Sun');
  const stars = useMemo(() => NAMED_STARS.map((s) => ({ ...s, ...enuToAltAz(eqjToEnu(m, s.ra, s.dec)) })).filter((s) => s.alt > 5).sort((a, b) => a.v - b.v).slice(0, 10), [m]);
  const targets = useMemo(() => TARGETS.map((tg) => ({ ...tg, ...enuToAltAz(eqjToEnu(m, tg.ra, tg.dec)), tr: nextTransit(tg.ra, tg.dec, date, place) })), [m, date, place]);
  const pickRadec = useMemo(() => (pick ? enuToRadec(m, altAzToEnu(pick.alt, pick.az)) : null), [pick, m]);
  const pickWcs = useMemo(() => (pickRadec ? northUpWcs(pickRadec.ra, pickRadec.dec, 3, 640, 640) : null), [pickRadec]);

  const placeLabel = place.source === 'city' && place.cityId ? L.cities[place.cityId] ?? place.cityId : `${place.lat.toFixed(2)}°, ${place.lon.toFixed(2)}°`;

  const applyManual = (e: React.FormEvent) => {
    e.preventDefault();
    const lat = Number(latIn.replace(',', '.')), lon = Number(lonIn.replace(',', '.'));
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) setPlace({ lat, lon, source: 'manual' });
  };

  const az8 = (az: number) => L.cardinal[Math.round(az / 45) % 8];

  return (
    <div className="look-above">
      <div className="look-above-top">
        <h2 className="look-h2 p-display">{L.aboveTitle}</h2>
        <p className="look-place">
          <strong>{placeLabel}</strong>{' '}
          <span className="look-dim">({L.locFrom[place.source]}{place.accuracyM ? ` ±${Math.round(place.accuracyM)} m` : ''})</span>
        </p>
        <div className="look-loc">
          <button type="button" className="look-btn look-btn-primary" onClick={() => void locate()} disabled={geo === 'locating'}>
            {geo === 'locating' ? L.locLocating : L.locUse}
          </button>
          <label className="look-field look-field-inline">
            <span className="p-label">{L.locCity}</span>
            <select className="look-select" value={place.source === 'city' ? place.cityId : ''} onChange={(e) => e.target.value && setCity(e.target.value)}>
              <option value="">—</option>
              {CITIES.map((c) => <option key={c.id} value={c.id}>{L.cities[c.id] ?? c.id}</option>)}
            </select>
          </label>
          <form className="look-latlon" onSubmit={applyManual}>
            <label className="look-field look-field-inline"><span className="p-label">{L.locLat}</span>
              <input className="look-input p-data" inputMode="decimal" value={latIn} onChange={(e) => setLatIn(e.target.value)} placeholder={place.lat.toFixed(2)} size={7} />
            </label>
            <label className="look-field look-field-inline"><span className="p-label">{L.locLon}</span>
              <input className="look-input p-data" inputMode="decimal" value={lonIn} onChange={(e) => setLonIn(e.target.value)} placeholder={place.lon.toFixed(2)} size={8} />
            </label>
            <button type="submit" className="look-btn">{L.locApply}</button>
          </form>
        </div>
        {geo === 'denied' && <p className="look-warn">{L.locDenied}</p>}
        {geo === 'unavailable' && <p className="look-warn">{L.locUnavailable}</p>}
        <div className="look-time">
          <label className="look-field look-field-inline">
            <span className="p-label">{L.timeLabel}</span>
            <input type="datetime-local" className="look-input p-data" value={toLocalInput(date)}
              onChange={(e) => { const d = new Date(e.target.value); if (!Number.isNaN(d.getTime())) setFixed(d); }} />
          </label>
          <button type="button" className="look-btn" aria-pressed={fixed === null} onClick={() => setFixed(null)}>{L.timeNow}</button>
          {fixed === null && <span className="look-tag">{L.timeLive}</span>}
        </div>
        <p className="look-note"><span className="look-tag look-tag-computed">{t.common.computed}</span> {L.computedNote}</p>
      </div>

      <div className="look-above-grid">
        <div className="look-dome-wrap">
          <DomeChart m={m} field={field} bodies={bodies} targets={TARGETS} cardinal={L.cardinal} bodyNames={L.bodies} pick={pick}
            onPick={(alt, az) => setPick({ alt, az })} label={L.domeLabel} />
          <p className="look-note">{L.domeLabel} {L.domeHint}</p>
          {sun && sun.alt > -6 && <p className="look-warn">{L.daylight}</p>}
        </div>

        <div className="look-tables">
          <section>
            <h3 className="look-h3">{L.solarSystem}</h3>
            <table className="look-table">
              <thead><tr><th scope="col">{L.colName}</th><th scope="col">{L.colAlt}</th><th scope="col">{L.colAz}</th><th scope="col">{L.colRise}</th><th scope="col">{L.colSet}</th><th scope="col">{L.colMag}</th></tr></thead>
              <tbody>
                {bodies.map((b) => (
                  <tr key={b.id} className={b.alt > 0 ? 'is-up' : 'is-down'}>
                    <th scope="row">
                      {L.bodies[b.id]}
                      {b.id === 'Moon' && b.phase !== null && <span className="look-dim"> · {L.moonLit((b.phase * 100).toFixed(0))}</span>}
                    </th>
                    <td className="p-data">{b.alt.toFixed(0)}°</td>
                    <td className="p-data">{b.az.toFixed(0)}° {az8(b.az)}</td>
                    <td className="p-data">{fmt(b.rise)}</td>
                    <td className="p-data">{fmt(b.set)}</td>
                    <td className="p-data">{b.mag !== null ? b.mag.toFixed(1) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section>
            <h3 className="look-h3">{L.targetsUp}</h3>
            <ul className="look-targets">
              {targets.map((tg) => (
                <li key={tg.id} className={tg.alt > 0 ? 'is-up' : 'is-down'}>
                  <div className="look-target-main">
                    <span className="look-target-name">{tg.name}</span>
                    <span className="look-dim">{t.targets[tg.id]?.kind}</span>
                  </div>
                  <div className="p-data look-target-pos">
                    {tg.alt > 0 ? `${L.up} · ${L.alt} ${tg.alt.toFixed(0)}° ${L.az} ${tg.az.toFixed(0)}° ${az8(tg.az)}` : L.down}
                  </div>
                  <div className="look-dim look-target-when">
                    {tg.tr.neverRises ? L.neverRises : tg.tr.circumpolar ? `${L.circumpolar} · ${L.transitAt(fmt(tg.tr.time), tg.tr.maxAlt.toFixed(0))}` : L.transitAt(fmt(tg.tr.time), tg.tr.maxAlt.toFixed(0))}
                  </div>
                  <div className="look-target-links">
                    <a className="look-link" href={withLang(`/explore?target=${tg.id}`, locale)}>{L.explore}</a>
                    <a className="look-link" href={withLang(`/sky?ra=${tg.ra.toFixed(4)}&dec=${tg.dec.toFixed(4)}&lat=${place.lat.toFixed(3)}&lon=${place.lon.toFixed(3)}`, locale)}>{L.sky}</a>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="look-h3">{L.brightStars}</h3>
            {stars.length ? (
              <table className="look-table">
                <thead><tr><th scope="col">{L.colName}</th><th scope="col">{L.colAlt}</th><th scope="col">{L.colAz}</th><th scope="col">{L.colMag}</th></tr></thead>
                <tbody>
                  {stars.map((s) => (
                    <tr key={s.name}>
                      <th scope="row">{s.name}</th>
                      <td className="p-data">{s.alt.toFixed(0)}°</td>
                      <td className="p-data">{s.az.toFixed(0)}° {az8(s.az)}</td>
                      <td className="p-data">{s.v.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="look-dim">{L.noneUp}</p>}
          </section>
        </div>
      </div>

      {pick && pickRadec && pickWcs && (
        <section className="look-pick">
          <h3 className="look-h3">{L.pickTitle} <span className="p-data look-dim">{L.alt} {pick.alt.toFixed(1)}° · {L.az} {pick.az.toFixed(1)}°</span></h3>
          <div className="look-pick-grid">
            <figure className="look-fig">
              <div className="look-frame" style={{ aspectRatio: '1' }}>
                <HipsImage wcs={pickWcs} layer={layer} className="look-fill" alt={L.hipsTitle} onStatus={onHips} />
                {hips === 'loading' && <div className="look-frame-msg"><span className="look-spinner" aria-hidden="true" />{L.hipsLoading}</div>}
                {hips === 'failed' && <div className="look-frame-msg">{L.hipsFailed}</div>}
                {hips === 'ok' && <span className="look-frame-reticle" aria-hidden="true" />}
              </div>
              <figcaption className="p-label">{L.hipsTitle}</figcaption>
              <HipsControls layer={layer} setLayer={setLayer} status={hips} wcs={pickWcs} source={hipsSrc} />
            </figure>
            <RegionPanel ra={pickRadec.ra} dec={pickRadec.dec} onPickTarget={(id) => { const tg = targets.find((x) => x.id === id); if (tg) setPick({ alt: tg.alt, az: tg.az }); }} />
          </div>
        </section>
      )}
    </div>
  );
}
