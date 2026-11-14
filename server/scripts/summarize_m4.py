"""Export a compact auditable M4 evidence snapshot, without FITS/cache payloads.

Run from server/: uv run --locked python scripts/summarize_m4.py \
  --output ../docs/m4-evidence.json
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path


def summarize(root):
    candidates=[]
    for path in sorted(root.glob('*/manifest.json')):
        result=json.loads(path.read_text())
        candidate={k:result.get(k) for k in ('target','started_utc','finished_utc','status',
            'error','offline','queries','catalog_requests','fixed_grid_center',
            'trajectory_endpoints','discovery_radius_deg','deduplicated_products',
            'all_detector_counts','accepted_pairs')}
        candidate['manifest_sha256']=hashlib.sha256(path.read_bytes()).hexdigest()
        candidate['detectors']=[]
        for det in result.get('detectors',[]):
            records=det['downloads']
            attempts=det['pair_attempts']
            observations=[record['observation'] for record in records if 'observation' in record]
            rejected=Counter(p.get('reason',p['status']) for p in attempts
                             if p['status']!='comparable_pair_validated')
            flags=Counter(flag for obs in observations
                          for flag in obs['predicted_local'].get('native_flag_names',[]))
            summary={k:det.get(k) for k in ('detector','status','candidate_count','sample_limited',
                                             'accepted_pairs','started_utc','finished_utc')}
            summary.update(attempted=len(records),inspected=len(observations),
                local_valid=sum(o['predicted_local']['native_valid'] for o in observations),
                local_flag_occurrences=dict(flags),pair_rejections=dict(rejected),
                pairs_evaluated=len(attempts),
                errors=[{k:record.get(k) for k in ('obs_id','error')} for record in records if 'error' in record],
                accepted=[p for p in attempts if p['status']=='comparable_pair_validated'],
                products=[{k:record.get(k) for k in ('obs_id','url','sha256','bytes','retrieved_utc')}
                          for record in records if 'observation' in record],
                observations=[{k:obs.get(k) for k in ('obs_id','collection','date_obs_utc','mjd_obs',
                    'detector','wavelength_um_approx','bandwidth_um_approx','pixel_scale_arcsec',
                    'psf_fwhm_arcsec','variance_units','predicted_local')} for obs in observations])
            candidate['detectors'].append(summary)
        candidates.append(candidate)
    products=[p for p in root.rglob('*.fits') if p.with_suffix('.json').exists()]
    return {'data_kind':'observed_spherex_with_catalog_predictions',
            'root':str(root),'cached_products':len(products),
            'cached_bytes':sum(p.stat().st_size for p in products),'candidates':candidates}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,default=Path('outputs/m4'))
    parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    args.output.write_text(json.dumps(summarize(args.root),indent=2,ensure_ascii=False,allow_nan=False)+'\n')
