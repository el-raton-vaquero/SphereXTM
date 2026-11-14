"""Bounded M4 target-feasibility CLI. Does not publish datasets or alter M101.

Exit 0: at least one comparable pair; 2: completed negative sample;
3: incomplete research (catalog, archive, cache or budget). Predictions are not detections.
"""
from __future__ import annotations

import argparse
import csv
from contextlib import contextmanager
import hashlib
import io
import itertools
import json
from pathlib import Path
import sys
import time
from urllib.parse import urlencode
import xml.etree.ElementTree as ET

import astropy
from astropy import units as u
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.time import Time
import numpy as np
import reproject

from spherex.archive import (COLLECTIONS, MAX_FILE_BYTES, MAX_QUERY_BYTES, SIA_URL,
                             cutout_url, download_cutout, fetch_bytes, parse_sia,
                             utc_now, write_json)
from spherex.alignment import align_pair, pair_score, save_comparison
from spherex.filelock import LockBusyError, exclusive_lock
from spherex.fits import inspect_cutout
from spherex.targets import load_targets, predict, sky_position, trajectory_region

MIN_DAYS, MIN_COVERAGE, MAX_OFFSET = 30.0, 0.8, 0.25
MAX_PRODUCTS, MAX_TOTAL_BYTES = 192, 2 * 1024**3
ERRORS = (OSError, RuntimeError, ValueError, KeyError, ET.ParseError)
LIMITATIONS = [
    'Catalog positions and displacements are PREDICTED, not SPHEREx detections.',
    'ICRS space motion; annual observer parallax and component orbits not modeled.',
    'No covariance propagation; catalog/anchor uncertainties remain relevant.',
    'Approximate WCS-WAVE; not calibrated CWAVE/CBAND spectrophotometry.',
    'Native variance diagnostics are exploratory, not calibrated aperture SNR.',
    'No PSF homogenization, source identification, calibrated photometry or measured motion.',
    'IMAGE includes zodiacal light. Local median subtraction is diagnostic only.',
    'Deterministic bounded sample cannot establish absence from the archive.',
]


def saved_response(url: str, path: Path, timeout: float, offline: bool,
                   records: list, fetch=fetch_bytes) -> bytes:
    """Save raw discovery/catalog responses and verify exact URL/hash on replay."""
    record = {'url': url, 'file': str(path), 'started_utc': utc_now()}
    records.append(record)
    started = time.monotonic()
    try:
        if offline:
            if not path.exists() or path.stat().st_size > MAX_QUERY_BYTES:
                raise ValueError('Missing or oversized offline response')
            data = path.read_bytes()
            original = json.loads(path.with_suffix('.json').read_text())
            if original['url'] != url or original['sha256'] != hashlib.sha256(data).hexdigest():
                raise ValueError('Offline response provenance mismatch')
            record.update(original)
            record['offline_replay'] = True
        else:
            data = fetch(url, MAX_QUERY_BYTES, timeout)
            path.write_bytes(data)
            record.update(sha256=hashlib.sha256(data).hexdigest(), retrieved_utc=utc_now())
            write_json(path.with_suffix('.json'), record)
        record['status'] = 'received'  # SIA status must still be validated by parse_sia.
        return data
    except ERRORS as exc:
        record.update(status='remote_or_cache_error', error=f'{type(exc).__name__}: {exc}')
        raise
    finally:
        record['elapsed_seconds'] = time.monotonic() - started


def resolve_target(target: dict, output: Path, args, records: list) -> dict:
    """Epsilon B position AND observation epoch from 2MASS, not epsilon A/Gaia."""
    if target['status'] == 'verified':
        return target.copy()
    if target['status'] == 'requires_gaia':
        query = ('SELECT source_id,ra,dec,ref_epoch,ra_error,dec_error,pmra,pmdec,'
                 'pmra_error,pmdec_error,parallax,parallax_error,radial_velocity,'
                 'radial_velocity_error FROM gaiadr3.gaia_source WHERE source_id='
                 + target['gaia_source_id'])
        url = 'https://gea.esac.esa.int/tap-server/tap/sync?' + urlencode(
            {'REQUEST':'doQuery','LANG':'ADQL','FORMAT':'csv','QUERY':query})
        data = saved_response(url,output/'gaia.csv',args.timeout,args.offline,records)
        rows = list(csv.DictReader(io.StringIO(data.decode())))
        if len(rows) != 1 or rows[0].get('source_id') != target['gaia_source_id']:
            raise ValueError('Expected unique Gaia source row')
        row = rows[0]
        return target | {'ra_deg':float(row['ra']), 'dec_deg':float(row['dec']),
            'epoch':float(row['ref_epoch']), 'epoch_format':'jyear','epoch_scale':'tcb',
            'pm_ra_cosdec_masyr':float(row['pmra']),'pm_dec_masyr':float(row['pmdec']),
            'parallax_mas':float(row['parallax']),
            'radial_velocity_kms':float(row['radial_velocity']) if row['radial_velocity'] else None,
            'uncertainties':{k:float(row[k]) if row[k] else None for k in
                ('ra_error','dec_error','pmra_error','pmdec_error','parallax_error','radial_velocity_error')},
            'catalog_query':query, 'status':'verified'}
    if target['id'] != 'epsilon-indi-b':
        raise ValueError('Catalog astrometry not verified; no discovery allowed')
    query = ("SELECT ra,dec,jdate,err_maj,err_min,designation FROM fp_psc "
             "WHERE designation='22041052-5646577'")
    url = 'https://irsa.ipac.caltech.edu/TAP/sync?' + urlencode(
        {'REQUEST': 'doQuery', 'LANG': 'ADQL', 'FORMAT': 'csv', 'QUERY': query})
    data = saved_response(url, output/'2mass.csv', args.timeout, args.offline, records)
    rows = list(csv.DictReader(io.StringIO(data.decode())))
    if len(rows) != 1 or rows[0].get('designation') != '22041052-5646577':
        raise ValueError('Expected unique 2MASS epsilon Indi B catalog row')
    row = rows[0]
    return target | {'ra_deg': float(row['ra']), 'dec_deg': float(row['dec']),
                     'epoch': float(row['jdate'])-2400000.5, 'epoch_format': 'mjd',
                     'epoch_scale': 'utc', 'status': 'verified', 'catalog_query': query,
                     'uncertainties': target['uncertainties'] | {
                         'anchor_major_arcsec': float(row['err_maj']),
                         'anchor_minor_arcsec': float(row['err_min'])}}


def deduplicate(rows: list[dict]) -> list[dict]:
    """Preserve releases separately; collapse repeated product URLs across cones."""
    return sorted({r['access_url']: r for r in rows}.values(),
                  key=lambda r: (float(r['t_min']), r['access_url']))


def check_budget(root: Path, max_bytes=MAX_TOTAL_BYTES, max_products=MAX_PRODUCTS):
    # Downloaded products only (aligned FITS is a derived output).
    products = [p for p in root.rglob('*.fits') if p.with_suffix('.json').exists()]
    used = sum(p.stat().st_size for p in products)
    if len(products) >= max_products or used + MAX_FILE_BYTES > max_bytes:
        raise ValueError('Campaign budget exhausted; research incomplete')
    return {'cached_product_count': len(products), 'cached_bytes': used}


def sample_indices(count: int, limit: int) -> list[int]:
    if not 1 <= limit <= 24:
        raise ValueError('Maximum 24 products per detector')
    return np.unique(np.linspace(0, count-1, min(count, limit), dtype=int)).tolist() if count else []


def local_diagnostic(obs, path: Path, predicted: SkyCoord) -> dict:
    """Native nearest pixel plus PSF-sized aperture/annulus diagnostics.

    Reject invalid native flags; no interpolation of variance or independent-noise
    interpretation. No source detection is inferred from these quantities.
    """
    x, y = map(float, obs.wcs.world_to_pixel(predicted))
    result = sky_position(predicted) | {'pixel_xy_zero_based': [x, y], 'native_valid': False}
    if not (-0.5 <= x < obs.image.shape[1]-0.5 and -0.5 <= y < obs.image.shape[0]-0.5):
        return result | {'reason': 'outside_cutout'}
    ix, iy = int(np.floor(x+0.5)), int(np.floor(y+0.5))
    scale = max(obs.metadata['pixel_scale_arcsec'])
    radius = max(1.0, obs.metadata['psf_fwhm_arcsec']/scale)
    yy, xx = np.indices(obs.image.shape)
    rr = np.hypot(xx-x, yy-y)
    aperture = rr <= radius
    annulus = (rr >= 2*radius) & (rr <= 3*radius) & obs.valid
    with fits.open(path, memmap=False) as hdus:
        var = hdus['VARIANCE'].data.astype(float)
        flag = int(hdus['FLAGS'].data[iy, ix])
        flag_names = [hdus['FLAGS'].header[k] for k in hdus['FLAGS'].header
                      if k.startswith('MSKN') and flag & (1 << int(k[4:]))]
    local = aperture & obs.valid
    background = float(np.median(obs.image[annulus])) if annulus.sum() >= 5 else None
    valid = bool(obs.valid[iy, ix])
    value = float(obs.image[iy, ix]) if valid else None
    variance = float(var[iy, ix]) if valid else None
    contrast = ((value-background)/np.sqrt(variance)
                if valid and background is not None else None)
    return result | {'native_valid': valid, 'native_flags': flag, 'native_flag_names': flag_names,
                     'aperture_radius_pixels': radius,
                     'aperture_valid_fraction': float(local.sum()/aperture.sum()),
                     'annulus_valid_count': int(annulus.sum()),
                     'local_background_mjy_sr': background, 'native_value_mjy_sr': value,
                     'native_variance': variance,
                     'pixel_contrast_over_native_sigma_exploratory': contrast,
                     'confusion_assessment': 'not established; requires catalog and PSF inspection'}


def mask_at(grid, mask, position: SkyCoord) -> bool:
    x, y = map(float, grid.world_to_pixel(position))
    if not (-0.5 <= x < mask.shape[1]-0.5 and -0.5 <= y < mask.shape[0]-0.5):
        return False
    return bool(mask[int(np.floor(y+0.5)), int(np.floor(x+0.5))])


def evaluate_pairs(observations, target, center, output: Path, size: float):
    """Record every rejected/accepted pair, saving figures only after validation."""
    attempts = []
    for a, b in itertools.combinations(observations, 2):
        record = {'obs_ids': [a.metadata['obs_id'], b.metadata['obs_id']]}
        bw = min(a.metadata['bandwidth_um_approx'], b.metadata['bandwidth_um_approx'])
        record.update(center_wave_offset_bandwidths=abs(a.metadata['wavelength_um_approx']
                       -b.metadata['wavelength_um_approx'])/bw,
                      center_bandwidth_ratio=max(a.metadata['bandwidth_um_approx'],
                                                 b.metadata['bandwidth_um_approx'])/bw)
        attempts.append(record)
        if pair_score(a.metadata, b.metadata, MIN_DAYS, MAX_OFFSET) is None:
            record.update(status='rejected', reason='time_or_center_spectral_incompatibility',
                          time_separation_days=abs(a.metadata['mjd_obs']-b.metadata['mjd_obs']))
            continue
        try:
            grid, arrays, matched, metrics = align_pair(a, b, center, size, MAX_OFFSET)
            pa, pb = [predict(target, o.metadata['mjd_obs']) for o in (a, b)]
            displacement = float(pa.separation(pb).arcsec)
            positions_valid = [mask_at(grid, matched, p) for p in (pa, pb)]
            record.update(metrics, predicted_displacement_arcsec=displacement,
                          predicted_displacement_pixels=displacement/metrics['pixel_scale_arcsec'],
                          predicted_displacement_psf=displacement/max(a.metadata['psf_fwhm_arcsec'],
                                                                     b.metadata['psf_fwhm_arcsec']),
                          predicted_positions=[sky_position(pa), sky_position(pb)],
                          predicted_positions_common_mask_valid=positions_valid)
            if metrics['spectrally_matched_fraction_of_grid'] < MIN_COVERAGE:
                record.update(status='rejected', reason='common_spectral_coverage_below_80_percent')
                continue
            record['status'] = 'comparable_pair_validated'
            record['motion_status'] = ('potentially_evaluable_not_measured' if all(positions_valid)
                                       and all(o.metadata['predicted_local']['native_valid'] for o in (a,b))
                                       else 'source_not_evaluable_quality')
            # One figure per detector, but evaluation continues for all pairs.
            if not any(r.get('figure') for r in attempts):
                display = save_comparison(output, a, b, grid, arrays, matched)
                record.update(display, figure=str(output/'comparison.png'))
                # Separate marked image makes catalog-derived predictions explicit.
                save_predicted_figure(output, grid, arrays, matched, pa, pb, a, b)
        except ERRORS as exc:
            record.update(status='processing_error', reason=str(exc))
    return attempts


def save_predicted_figure(output, grid, arrays, mask, pa, pb, a, b):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    fig, axes = plt.subplots(1, 2, figsize=(11, 5), layout='constrained',
                             subplot_kw={'projection': grid})
    cmap = plt.colormaps['gray'].with_extremes(bad='#4477aa')
    limits = np.nanpercentile(np.concatenate([im[mask] for im in arrays]), [2, 98])
    for ax, image, obs in zip(axes, arrays, (a,b), strict=True):
        shown = ax.imshow(np.where(mask,image,np.nan), origin='lower', cmap=cmap,
                  vmin=limits[0], vmax=limits[1])
        for p, color, label in ((pa,'orange','Predicted t1'),(pb,'cyan','Predicted t2')):
            ax.plot(*grid.world_to_pixel(p), marker='+', color=color, ls='', label=label)
        ax.set_title(obs.metadata['date_obs_utc'][:10])
        ax.legend(fontsize=8)
    fig.colorbar(shown, ax=list(axes), label='Surface brightness [MJy/sr]', shrink=0.7)
    fig.suptitle('Observed SPHEREx + catalog PREDICTIONS; no measured motion')
    fig.supxlabel('Blue = excluded quality / coverage / wavelength; common display scale')
    fig.savefig(output/'predicted-positions.png',dpi=140)
    plt.close(fig)


def detector_run(args, target, center, rows, detector: int, output: Path, root: Path):
    output.mkdir(parents=True, exist_ok=True)
    candidates = [r for r in rows if r['energy_bandpassname'] == f'SPHEREx-D{detector}']
    result = {'detector': detector, 'candidate_count': len(candidates), 'downloads': [],
              'status': 'in_progress', 'started_utc': utc_now()}
    observations = []
    for index in sample_indices(len(candidates), args.max_downloads):
        row = candidates[index]
        record = {'obs_id': row['obs_id'], 'source': row}
        result['downloads'].append(record)
        try:
            url = cutout_url(row['access_url'], center.ra.deg, center.dec.deg, 2*args.size_arcmin)
            # Existing verified cache entries do not consume additional download budget.
            key = hashlib.sha256(url.encode()).hexdigest()[:20]
            if not (output/f'{key}.fits').exists() and not args.offline:
                check_budget(output,max_products=24)
                check_budget(root)
            path, provenance = download_cutout(url, output, args.timeout, args.offline)
            record.update(provenance)
            predicted = predict(target, float(row['t_min']))
            obs = inspect_cutout(path, row, predicted)
            obs.metadata['predicted_local'] = local_diagnostic(obs, path, predicted)
            record['observation'] = obs.metadata
            observations.append(obs)
            print(f"{target['id']} D{detector}: {row['obs_id']} inspected", flush=True)
        except ERRORS as exc:
            record['error'] = f'{type(exc).__name__}: {exc}'
        write_json(output/'progress.json', result)
    result['pair_attempts'] = evaluate_pairs(observations, target, center, output, args.size_arcmin)
    result['accepted_pairs'] = sum(r['status']=='comparable_pair_validated' for r in result['pair_attempts'])
    incomplete = any('error' in r for r in result['downloads']) or any(
        r['status']=='processing_error' for r in result['pair_attempts'])
    result['sample_limited'] = len(candidates) > args.max_downloads
    result['status'] = ('incomplete' if incomplete else
                        'comparable_pair_validated' if result['accepted_pairs'] else
                        'negative_within_bounded_sample')
    result['finished_utc'] = utc_now()
    persist(output, result)
    return result


def persist(output: Path, manifest: dict):
    write_json(output/'manifest.json', manifest)
    history = output/'runs'
    history.mkdir(exist_ok=True)
    write_json(history/(manifest['started_utc'].replace(':','-')+'.json'), manifest)


def candidate_run(args, target, root):
    output = root/target['id']
    output.mkdir(parents=True, exist_ok=True)
    result = {'target': target, 'started_utc': utc_now(), 'queries': [], 'catalog_requests': [],
              'detectors': [], 'limitations': LIMITATIONS, 'offline': args.offline}
    try:
        target = resolve_target(target, output, args, result['catalog_requests'])
        result['target'] = target
        center, radius = trajectory_region(target, args.start_mjd, args.end_mjd)
        result['fixed_grid_center'] = sky_position(center)
        result['trajectory_endpoints'] = [sky_position(predict(target,t))
                                          for t in (args.start_mjd,args.end_mjd)]
        result['discovery_radius_deg'] = radius
        rows, errors = [], []
        for collection in COLLECTIONS:
            url = SIA_URL+'?'+urlencode({'COLLECTION':collection,
                'POS':f'CIRCLE {center.ra.deg} {center.dec.deg} {radius}',
                'TIME':f'{args.start_mjd} {args.end_mjd}', 'MAXREC':1000})
            try:
                data = saved_response(url, output/f'{collection}.xml', args.timeout,
                                      args.offline, result['queries'])
                parsed = parse_sia(data)
                result['queries'][-1].update(rows=len(parsed),status='OK')
                rows.extend(parsed)
            except ERRORS as exc:
                result['queries'][-1].update(status='error_or_incomplete',error=str(exc))
                errors.append(str(exc))
        rows = deduplicate(rows)
        result['deduplicated_products'] = len(rows)
        result['all_detector_counts'] = {str(d):sum(r['energy_bandpassname']==f'SPHEREx-D{d}'
                                                    for r in rows) for d in range(1,7)}
        result['all_detector_metadata'] = {str(d): [
            {k:row.get(k) for k in ('obs_id','obs_collection','t_min','t_max','em_min','em_max','access_url')}
            for row in rows if row['energy_bandpassname']==f'SPHEREx-D{d}']
            for d in range(1,7)}
        # Do not treat a remote error as an empty archive. Inspect successful release
        # results, but keep overall classification incomplete.
        for detector in target['detectors']:
            result['detectors'].append(detector_run(args,target,center,rows,detector,
                                                    output/f'd{detector}',root))
        accepted = sum(d['accepted_pairs'] for d in result['detectors'])
        result['accepted_pairs'] = accepted
        result['status'] = ('incomplete' if errors or any(d['status']=='incomplete' for d in result['detectors'])
                            else 'comparable_pair_validated' if accepted else 'negative_within_bounded_sample')
    except ERRORS as exc:
        result.update(status='blocked',error=f'{type(exc).__name__}: {exc}')
    result['finished_utc'] = utc_now()
    persist(output,result)
    return result


def arguments(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--targets',nargs='+',choices=load_targets(),default=['barnard','wise0855','epsilon-indi-b'])
    parser.add_argument('--output',type=Path,default=Path('outputs/m4'))
    parser.add_argument('--offline',action='store_true')
    parser.add_argument('--max-downloads',type=int,default=24)
    parser.add_argument('--timeout',type=float,default=30)
    parser.add_argument('--size-arcmin',type=float,default=3)
    parser.add_argument('--start-mjd',type=float,default=float(Time('2025-01-01').mjd))
    parser.add_argument('--end-mjd',type=float,default=float(Time('2027-01-01').mjd))
    args=parser.parse_args(argv)
    if not (1<=args.max_downloads<=24 and 1<=args.timeout<=180 and 1<=args.size_arcmin<=5
            and np.isfinite([args.start_mjd,args.end_mjd]).all()
            and 0<args.end_mjd-args.start_mjd<=1000):
        parser.error('Invalid campaign bounds')
    # Repeated CLI target IDs must never multiply detector/download allowance.
    args.targets=list(dict.fromkeys(args.targets))
    return args


@contextmanager
def campaign_lock(root: Path):
    """Prevent concurrent campaigns from racing budgets or parallelizing downloads."""
    lock = exclusive_lock(root/'.campaign.lock')
    try:
        lock.__enter__()
    except LockBusyError as exc:
        raise ValueError('Another M4 campaign is active in this output directory') from exc
    try:
        yield
    finally:
        lock.__exit__(None, None, None)


def main(argv=None):
    args=arguments(argv)
    args.output.mkdir(parents=True,exist_ok=True)
    registry=load_targets()
    campaign={'started_utc':utc_now(),'command':[sys.executable,*sys.argv],
              'parameters':{k:str(v) if isinstance(v,Path) else v for k,v in vars(args).items()},
              'thresholds':{'min_days':MIN_DAYS,'min_coverage':MIN_COVERAGE,
                            'max_wave_offset_bandwidths':MAX_OFFSET,'max_bandwidth_ratio':1.2},
              'implementation_sha256':{p.name:hashlib.sha256(p.read_bytes()).hexdigest()
                  for p in [Path(__file__),Path(__file__).with_name('targets.py'),
                            Path(__file__).with_name('data')/'m4-targets.json']},
              'versions':{'astropy':astropy.__version__,'numpy':np.__version__,
                          'reproject':reproject.__version__},'candidates':[]}
    try:
        with campaign_lock(args.output):
            for name in args.targets:
                print(f'Investigating {name} (offline={args.offline})',flush=True)
                campaign['candidates'].append(candidate_run(args,registry[name],args.output))
    except KeyboardInterrupt:
        campaign.update(status='incomplete',error='Interrupted; detector progress files retained',
                        finished_utc=utc_now())
        persist(args.output,campaign)
        return 130
    except ValueError as exc:
        print(f'Campaign blocked: {exc}',file=sys.stderr)
        return 3
    incomplete=any(c['status'] in ('blocked','incomplete') for c in campaign['candidates'])
    accepted=sum(c.get('accepted_pairs',0) for c in campaign['candidates'])
    campaign.update(status='incomplete' if incomplete else 'completed',finished_utc=utc_now())
    persist(args.output,campaign)
    print(f"Campaign {campaign['status']}: {accepted} comparable pairs; {args.output/'manifest.json'}")
    return 3 if incomplete else 0 if accepted else 2


if __name__=='__main__':
    raise SystemExit(main())
