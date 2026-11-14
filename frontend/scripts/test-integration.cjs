/* eslint-disable @typescript-eslint/no-require-imports -- isolated CommonJS test harness */
// Compiles pure TS modules into an isolated temporary directory; no new runner dependency.
const fs=require('fs'),os=require('os'),path=require('path'),ts=require('typescript'),assert=require('node:assert/strict');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'spherex-tests-'));
for(const file of fs.readdirSync(path.join(__dirname,'../lib')).filter(f=>f.endsWith('.ts'))){const code=fs.readFileSync(path.join(__dirname,'../lib',file),'utf8');fs.writeFileSync(path.join(temp,file.replace('.ts','.js')),ts.transpileModule(code,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText);}
global.ImageData=class {constructor(w,h){this.width=w;this.height=h;this.data=new Uint8ClampedArray(w*h*4);}};
const {computeProcessedBuffer,renderImage}=require(path.join(temp,'renderEngine.js'));
const make=(ep,values,mask=[1,1,1,1,1,1])=>({id:`frame${ep}`,width:3,height:2,epochIndex:ep,detector:2,pixelData:new Float32Array(values),validMask:mask,flags:[],stats:{min:0,max:10},band:{lambda_um:1.49}});
const frames=[make(0,[1,2,3,4,5,6]),make(1,[4,5,6,7,8,9],[0,1,1,1,1,1])];const detectors=[false,true];
assert.deepEqual([...computeProcessedBuffer(frames,1,detectors,'diff','first').buffer],[3,3,3,3,3,3]);
assert.equal(computeProcessedBuffer(frames,1,detectors,'diff','first').validMask[0],0);
const stretch={min:0,max:10,fn:'linear'};
const image=renderImage(frames,1,detectors,'diff','first',stretch,'inferno');assert.equal(image.width,3);assert.equal(image.height,2);assert.deepEqual([...image.data.slice(0,4)],[43,61,91,255]);
const normal=renderImage(frames,1,detectors,'normal','first',stretch,'inferno');const left=renderImage(frames,1,detectors,'normal','first',stretch,'inferno',false,0);assert.deepEqual(left.data,normal.data);
const medianFrames=[make(0,[1,1,1,1,1,1]),make(1,[3,3,3,3,3,3]),make(2,[100,100,100,100,100,100]),make(3,[9,9,9,9,9,9])];assert.equal(computeProcessedBuffer(medianFrames,3,detectors,'diff','median').buffer[1],6);
(async()=>{const {api}=require(path.join(temp,'apiAdapter.js'));let count=0;global.fetch=async()=>{count++;return {ok:true,json:async()=>({frames,epochs:[{},{}]})};};const q={ra:210.80227,dec:54.34895,fov:3};await api.getFrames(q);await api.getFrames(q);assert.equal(count,1);await api.getFrames({...q,ra:q.ra+0.000001});assert.equal(count,2);
 global.fetch=async()=>({ok:true,json:async()=>({frames:[{...frames[0],pixelData:[1]}],epochs:[{}]})});await assert.rejects(api.getFrames({...q,ra:22}),/incompatible/);
 const c=new AbortController();c.abort();await assert.rejects(api.getFrames({...q,ra:23},c.signal),{name:'AbortError'});
 fs.mkdirSync(path.join(temp,'lib'));for(const f of fs.readdirSync(temp).filter(f=>f.endsWith('.js')))fs.linkSync(path.join(temp,f),path.join(temp,'lib',f));
 fs.mkdirSync(path.join(temp,'store'));fs.symlinkSync(path.join(__dirname,'../node_modules'),path.join(temp,'node_modules'));
 const storeCode=fs.readFileSync(path.join(__dirname,'../store/useSpherexStore.ts'),'utf8');fs.writeFileSync(path.join(temp,'store/useSpherexStore.js'),ts.transpileModule(storeCode,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText);
 const {spherexStore}=require(path.join(temp,'store/useSpherexStore.js'));const pending=[];global.fetch=()=>new Promise(resolve=>pending.push(resolve));
 const older=spherexStore.loadFrames();const newer=spherexStore.setTarget({ra:211});
 const response=(id)=>({ok:true,json:async()=>({frames:frames.map(f=>({...f,id})),epochs:[{},{}],wcs:{size:[3,2]},fovArcmin:3,provenance:{data_origin:'observed_spherex'}})});
  pending[1](response('newer'));await newer;pending[0](response('older'));await older;assert.equal(spherexStore.getState().frames[0].id,'newer');
  const {predictionMarkers}=require(path.join(temp,'catalogOverlay.js'));
  const predictions={kind:'catalog_predicted',motionMeasured:false,positions:[
   {obsId:'a',epochIndex:0,x:13.2,y:14.6,inBounds:true},
   {obsId:'b',epochIndex:1,x:14.4,y:14.2,inBounds:true},
  ]};
  assert.equal(predictionMarkers(predictions,0).length,1);
  assert.equal(predictionMarkers(predictions,1)[0].obsId,'b');
  assert.equal(predictionMarkers(predictions)[0].svgX,13.7);
  assert.equal(predictionMarkers(predictions)[0].svgY,15.1);
  assert.deepEqual(predictionMarkers(undefined),[]);
  const {celestialToPixel,pixelToCelestial}=require(path.join(temp,'wcs.js'));
  const {formatObservationDateUTC}=require(path.join(temp,'observationTime.js'));
  const oldTimezone=process.env.TZ;process.env.TZ='America/Mexico_City';
  assert.match(formatObservationDateUTC('2026-08-18T20:48:38.781','en'),/Aug 18, 2026/);
  if(oldTimezone)process.env.TZ=oldTimezone;else delete process.env.TZ;
  const exactWcs={crval:[133.76012153222,-7.2421271477745],crpix:[15,15],screenCrpix:[14.5,14.5],cdelt:.0017118919351926,size:[30,30]};
  // These expected coordinates are independently computed by Astropy on the
  // authentic M4 grid; no canvas coordinate approximation or mock trajectory.
  const pixel=celestialToPixel(133.76160634742013,-7.242255158803245,exactWcs);
  assert.ok(Math.abs(pixel.x-13.639566398168576)<1e-7);
  assert.ok(Math.abs(pixel.y-14.574778922773652)<1e-7);
  const sky=pixelToCelestial(pixel.x,pixel.y,exactWcs);assert.ok(Math.abs(sky.ra-133.76160634742013)<1e-10);
  const caseA={id:'unit-case-a',name:'Unit case A',ra:1,dec:2,fovArcmin:3,observationIds:frames.map(f=>f.id)};
  const caseB={...caseA,id:'unit-case-b',name:'Unit case B'};
  const requests=[];
  const caseResponse=(dataset)=>({ok:true,json:async()=>({
   frames,epochs:[{},{}],target:{ra:1,dec:2,name:dataset.name},wcs:exactWcs,
   fovArcmin:3,dataset,provenance:{data_origin:'observed_spherex'},
  })});
  global.fetch=(url)=>new Promise(resolve=>requests.push({url,resolve}));
  const firstCase=spherexStore.selectDataset(caseA);
  assert.equal(spherexStore.getState().frames.length,0);
  const secondCase=spherexStore.selectDataset(caseB);
  assert.ok(requests[0].url.endsWith('/datasets/unit-case-a/frames'));
  assert.ok(requests[1].url.endsWith('/datasets/unit-case-b/frames'));
  requests[1].resolve(caseResponse(caseB));await secondCase;
  requests[0].resolve(caseResponse(caseA));await firstCase;
  assert.equal(spherexStore.getState().datasetId,caseB.id);
  assert.equal(spherexStore.getState().target.name,caseB.name);
  global.fetch=async()=>({ok:false,status:503,statusText:'Unavailable',json:async()=>({detail:'No prepared real data'})});
  await spherexStore.selectDataset({...caseA,id:'unit-unavailable'});
  assert.equal(spherexStore.getState().frames.length,0);
  assert.equal(spherexStore.getState().catalogPredictions,undefined);
  assert.match(spherexStore.getState().error,/No prepared real data/);
  global.fetch=async()=>caseResponse(caseA);
  await assert.rejects(api.getFrames({...q,datasetId:'different-pair'}),/Identidad/);
  global.fetch=async()=>({ok:true,json:async()=>({
   frames:frames.map(f=>({...f,id:'wrong-observation'})),epochs:[{},{}],
   dataset:caseA,provenance:{data_origin:'observed_spherex'},
  })});
  await assert.rejects(api.getFrames({...q,ra:222,datasetId:caseA.id}),/par de observaciones/);
  process.env.NEXT_PUBLIC_USE_REAL_API='false';const mock=await api.getFrames(q);assert.notEqual(mock.frames[0].id,frames[0].id);
  console.log('PASS: dataset selection/races/identity, unavailable without synthetic fallback, epoch overlays and Astropy WCS, real/mock separation, rectangular dimensions, difference sign, median, masks, curtain, cache keys, cancellation');
})().catch(e=>{console.error(e);process.exitCode=1;});
