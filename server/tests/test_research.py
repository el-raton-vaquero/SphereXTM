"""Offline M4 science and resource-bound tests; fixtures are explicitly synthetic."""
from argparse import Namespace
import hashlib
import json
from pathlib import Path

from astropy import units as u
from astropy.coordinates import SkyCoord
from astropy.time import Time
import numpy as np
import pytest

from spherex import research as r
from spherex.targets import load_targets, predict, trajectory_region
from spherex.alignment import common_grid
from spherex.archive import parse_sia


def test_barnard_motion_uses_catalog_epoch_and_ra_cosdec():
    t=load_targets()['barnard']
    c0=predict(t,Time(2016,format='jyear',scale='tcb').utc.mjd)
    c1=predict(t,Time(2017,format='jyear',scale='tcb').utc.mjd)
    dra,ddec=SkyCoord(c0.ra,c0.dec).spherical_offsets_to(SkyCoord(c1.ra,c1.dec))
    assert dra.to_value(u.mas)==pytest.approx(t['pm_ra_cosdec_masyr'],rel=0.001)
    assert ddec.to_value(u.mas)==pytest.approx(t['pm_dec_masyr'],rel=0.001)
    assert c0.ra.deg==pytest.approx(t['ra_deg'],abs=1e-9)


def test_high_declination_cosine_and_ra_wrap():
    t=load_targets()['barnard'] | dict(ra_deg=359.9999,dec_deg=60,
        pm_ra_cosdec_masyr=1000,pm_dec_masyr=0,radial_velocity_kms=0)
    epoch=Time(t['epoch'],format='jyear',scale='tcb')
    c0=predict(t,epoch.utc.mjd)
    c1=predict(t,(epoch+1*u.yr).utc.mjd)
    assert c1.ra.deg<1  # wrap is handled by spherical Astropy propagation
    assert c0.separation(c1).arcsec==pytest.approx(1,abs=1e-5)
    assert ((c1.ra.deg-c0.ra.deg)%360)*3600==pytest.approx(2,abs=1e-4)


def test_trajectory_cone_and_fixed_grid_enclose_both_epochs():
    target=load_targets()['wise0855']
    start,end=60676.,61406.
    center,radius=trajectory_region(target,start,end)
    grid,shape=common_grid(center,3,6.2)
    for t in np.linspace(start,end,31):
        p=predict(target,t)
        assert p.separation(center).deg<radius
        x,y=grid.world_to_pixel(p)
        assert 0<x<shape[1]-1 and 0<y<shape[0]-1
    assert radius<=0.03


def test_deduplication_preserves_different_release_products():
    def row(url): return {'access_url':url,'t_min':'60000','obs_id':'same'}
    assert len(r.deduplicate([row('dr1'),row('dr1'),row('qr3')]))==2


@pytest.mark.parametrize('limit',[0,25,-1])
def test_sample_bounds(limit):
    with pytest.raises(ValueError): r.sample_indices(100,limit)


def test_time_sampling():
    indices=r.sample_indices(100,24)
    assert len(indices)==24 and indices[0]==0 and indices[-1]==99
    assert r.sample_indices(0,24)==[]


def test_campaign_budget_and_cached_products(tmp_path):
    path=tmp_path/'one.fits'
    path.write_bytes(b'123')
    path.with_suffix('.json').write_text('{}')
    with pytest.raises(ValueError,match='budget'): r.check_budget(tmp_path,max_products=1)
    with pytest.raises(ValueError,match='budget'): r.check_budget(tmp_path,max_bytes=r.MAX_FILE_BYTES+2)
    assert r.check_budget(tmp_path)['cached_bytes']==3


def test_offline_replay_no_network_and_tamper_rejection(tmp_path):
    path=tmp_path/'query.xml'
    payload=b'<response/>'
    calls=[]
    def fetch(*args): calls.append(args); return payload
    records=[]
    assert r.saved_response('https://example.test',path,1,False,records,fetch)==payload
    assert len(calls)==1
    def forbidden(*args): pytest.fail('offline contacted network')
    assert r.saved_response('https://example.test',path,1,True,[],forbidden)==payload
    with pytest.raises(ValueError,match='provenance'):
        r.saved_response('https://different.test',path,1,True,[],forbidden)
    path.write_bytes(b'tampered')
    with pytest.raises(ValueError,match='provenance'):
        r.saved_response('https://example.test',path,1,True,[],forbidden)


def test_sia_error_overflow_and_empty_are_distinct():
    xml='''<VOTABLE><RESOURCE><INFO name="QUERY_STATUS" value="{}"/>
      <TABLE><FIELD name="obs_id"/><FIELD name="access_url"/>
      <FIELD name="t_min"/><FIELD name="energy_bandpassname"/>
      <DATA><TABLEDATA/></DATA></TABLE></RESOURCE></VOTABLE>'''
    assert parse_sia(xml.format('OK'))==[]
    for status in ('ERROR','OVERFLOW'):
        with pytest.raises(ValueError,match='do not infer absence'):
            parse_sia(xml.format(status))


def test_remote_failure_recorded_not_empty(tmp_path):
    def failed(*args): raise RuntimeError('HTTP 503')
    records=[]
    with pytest.raises(RuntimeError):
        r.saved_response('https://example.test',tmp_path/'q.xml',1,False,records,failed)
    assert records[0]['status']=='remote_or_cache_error'
    assert 'rows' not in records[0]


def test_mask_at_prediction_including_edges():
    grid,shape=common_grid(SkyCoord(10,20,unit='deg'),1,6)
    mask=np.ones(shape,dtype=bool)
    mask[4,4]=False
    assert not r.mask_at(grid,mask,grid.pixel_to_world(4,4))
    assert r.mask_at(grid,mask,grid.pixel_to_world(5,5))
    assert not r.mask_at(grid,mask,grid.pixel_to_world(-1,4))


def test_native_mask_diagnostic_rejects_flagged_prediction(tmp_path):
    from astropy.io import fits
    from spherex.fits import Observation
    grid,shape=common_grid(SkyCoord(10,20,unit='deg'),1,6)
    valid=np.ones(shape,dtype=bool); valid[4,4]=False
    image=np.ones(shape)
    obs=Observation({'pixel_scale_arcsec':[6,6],'psf_fwhm_arcsec':7},grid,image,valid,image,image)
    flags=np.zeros(shape,dtype=np.uint32); flags[4,4]=128
    path=tmp_path/'synthetic.fits'
    fits.HDUList([fits.PrimaryHDU(),fits.ImageHDU(image,name='VARIANCE'),
                  fits.ImageHDU(flags,name='FLAGS')]).writeto(path)
    diag=r.local_diagnostic(obs,path,grid.pixel_to_world(4,4))
    assert not diag['native_valid'] and diag['native_flags']==128
    assert diag['pixel_contrast_over_native_sigma_exploratory'] is None


def test_cli_thresholds_cannot_be_relaxed():
    assert (r.MIN_DAYS,r.MIN_COVERAGE,r.MAX_OFFSET)==(30,0.8,0.25)
    with pytest.raises(SystemExit): r.arguments(['--min-coverage','0.5'])
    with pytest.raises(SystemExit): r.arguments(['--max-downloads','25'])
    assert r.arguments(['--targets','barnard','barnard']).targets==['barnard']


def test_all_pairs_recorded_after_acceptance(monkeypatch,tmp_path):
    from spherex.fits import Observation
    target=load_targets()['barnard']
    center,_=trajectory_region(target,60676,61406)
    grid,shape=common_grid(center,3,6)
    image=np.ones(shape); mask=np.ones(shape,dtype=bool)
    observations=[]
    for i in range(3):
        meta={'obs_id':str(i),'detector':2,'mjd_obs':60700+i*40,
              'wavelength_um_approx':1.5,'bandwidth_um_approx':0.04,
              'pixel_scale_arcsec':[6,6],'psf_fwhm_arcsec':7,
              'predicted_local':{'native_valid':True}}
        observations.append(Observation(meta,grid,image,mask,image*1.5,image*0.04))
    monkeypatch.setattr(r,'save_comparison',lambda *args:{})
    monkeypatch.setattr(r,'save_predicted_figure',lambda *args:None)
    attempts=r.evaluate_pairs(observations,target,center,tmp_path,3)
    assert len(attempts)==3
    assert all(a['status']=='comparable_pair_validated' for a in attempts)
    assert all(a['motion_status']=='potentially_evaluable_not_measured' for a in attempts)
    assert sum('figure' in a for a in attempts)==1


def test_candidate_offline_missing_cache_is_incomplete_not_negative(tmp_path):
    args=r.arguments(['--offline'])
    result=r.candidate_run(args,load_targets()['barnard'],tmp_path)
    assert result['status']=='incomplete'
    assert all(q['status']=='error_or_incomplete' for q in result['queries'])
    assert result['accepted_pairs']==0
    assert list((tmp_path/'barnard'/'runs').glob('*.json'))


def test_campaign_lock_prevents_parallel_downloads(tmp_path):
    with r.campaign_lock(tmp_path):
        with pytest.raises(ValueError,match='Another M4 campaign'):
            with r.campaign_lock(tmp_path):
                pytest.fail('Concurrent campaign acquired lock')
    with r.campaign_lock(tmp_path):
        pass


def test_epsilon_uses_2mass_observation_epoch_not_j2000(monkeypatch,tmp_path):
    target=load_targets()['epsilon-indi-b']
    payload=b'ra,dec,jdate,err_maj,err_min,designation\n331.0,-56.0,2451000.5,0.1,0.1,22041052-5646577\n'
    monkeypatch.setattr(r,'saved_response',lambda *args:payload)
    resolved=r.resolve_target(target,tmp_path,Namespace(timeout=1,offline=True),[])
    assert resolved['epoch']==51000 and resolved['epoch_format']=='mjd'
    assert resolved['pm_ra_cosdec_masyr']==3987.41
    assert resolved['identifier']=='2MASS J22041052-5646577'


def test_catalog_identity_mismatch_blocks_target(monkeypatch,tmp_path):
    monkeypatch.setattr(r,'saved_response',lambda *args:b'source_id,ra\n1,10\n')
    with pytest.raises(ValueError,match='unique Gaia'):
        r.resolve_target(load_targets()['lalande21185'],tmp_path,
                         Namespace(timeout=1,offline=True),[])
