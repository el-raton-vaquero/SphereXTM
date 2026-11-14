/* eslint-disable @typescript-eslint/no-require-imports -- optional external browser harness */
// No application dependency change. Set PLAYWRIGHT_MODULE to an existing
// Playwright installation, or install the test tool outside this repository.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const base=process.env.SPHEREX_BROWSER_URL || 'http://127.0.0.1:3000';
const output=process.env.SPHEREX_BROWSER_OUTPUT || '/tmp/opencode/m45-browser';
fs.mkdirSync(output,{recursive:true});

(async()=>{
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});
 const errors=[];
 const report={base,checks:[],screenshots:[]};
 try {
  const page=await browser.newPage({viewport:{width:1440,height:1000},timezoneId:'America/Mexico_City'});
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`${base}/?api=real`);
  await page.waitForFunction(()=>document.querySelector('.active-date')?.textContent.includes('2026-05-17'));
  assert.equal(await page.locator('.viewer-viewport canvas').getAttribute('width'),'30');
  report.checks.push('M101 default: real 30x30 observations');
  const inventory=await (await page.request.get(`${base}/api/datasets`)).json();
  assert.equal(inventory.length,4);
  assert.ok(inventory.every(item=>item.available),'Prepare all four real cases for this browser suite');
  for(const id of ['wise0855-d6','barnard-d2','barnard-d6','m101']){
   await page.getByLabel('Caso científico real',{exact:true}).selectOption(id);
   const actual=await (await page.request.get(`${base}/api/datasets/${id}/frames`)).json();
   await page.waitForFunction(date=>document.querySelector('.active-date')?.textContent.includes(date),actual.epochs[0].date.slice(0,10));
   assert.ok((await page.locator('.field-heading h1').innerText()).includes(id==='m101'?'M101':id.startsWith('wise')?'WISE':"Barnard"));
   assert.equal(await page.locator('.viewer-viewport canvas').getAttribute('width'),'30');
   if(id==='barnard-d2') assert.match(await page.locator('.epoch-selector strong').nth(1).innerText(),/18.*2026/);
   if(id!=='m101'){
    assert.ok((await page.locator('.scientific-cases').innerText()).includes('predicho'));
    assert.equal(await page.locator('.viewer-viewport .catalog-overlay circle').count(),1);
    const marker=actual.catalogPredictions.positions[0];
    const cx=Number(await page.locator('.viewer-viewport .catalog-overlay circle').getAttribute('cx'));
    assert.ok(Math.abs(cx-(marker.x+.5))<1e-9);
    await page.getByLabel('Mostrar posiciones predichas de catálogo (no detecciones)').uncheck();
    assert.equal(await page.locator('.catalog-overlay').count(),0);
    await page.getByLabel('Mostrar posiciones predichas de catálogo (no detecciones)').check();
   } else assert.equal(await page.locator('.catalog-overlay').count(),0);
   await page.getByRole('button',{name:'Lado a lado',exact:true}).click();
   assert.equal(await page.locator('.real-side-by-side canvas').count(),2);
   assert.equal(await page.locator('.real-side-by-side figcaption').count(),2);
   if(id==='wise0855-d6'){
    const filename=path.join(output,'m45-wise-desktop.png');
    await page.screenshot({path:filename,fullPage:true});report.screenshots.push(filename);
   }
   await page.getByRole('button',{name:'Lado a lado',exact:true}).click();
   await page.getByRole('button',{name:'Parpadeo',exact:true}).click();
   await page.waitForFunction(date=>document.querySelector('.active-date')?.textContent.includes(date),actual.epochs[1].date.slice(0,10));
   await page.getByRole('button',{name:'Parpadeo',exact:true}).click();
   await page.getByRole('button',{name:'Diferencia',exact:true}).click();
   assert.equal(await page.getByRole('button',{name:'Diferencia',exact:true}).getAttribute('aria-pressed'),'true');
   report.checks.push(`${id}: identities ${actual.frames.map(f=>f.id).join('/')} verified; overlays, side-by-side, blink and difference`);
  }
  // Deep-link reload and mobile layout, using actual backend observations.
  await page.setViewportSize({width:390,height:844});
  await page.goto(`${base}/?api=real&dataset=barnard-d2`);
  await page.waitForFunction(()=>document.querySelector('.active-date')?.textContent.includes('2025-08-25'));
  assert.equal(await page.getByLabel('Caso científico real',{exact:true}).inputValue(),'barnard-d2');
  assert.ok((await page.locator('.scientific-cases').innerText()).includes('OVERFLOW'));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Mobile overflow');
  const mobile=path.join(output,'m45-barnard-mobile.png');
  await page.screenshot({path:mobile,fullPage:true});report.screenshots.push(mobile);
  await page.getByLabel('Caso científico real',{exact:true}).selectOption('wise0855-d6');
  await page.waitForFunction(()=>document.querySelector('.active-date')?.textContent.includes('2025-05-05'));
  await page.getByRole('button',{name:'Lado a lado',exact:true}).click();
  assert.equal(await page.locator('.real-side-by-side canvas').count(),2);
  await page.getByLabel('Caso científico real',{exact:true}).selectOption('m101');
  await page.waitForFunction(()=>document.querySelector('.active-date')?.textContent.includes('2026-05-17'));
  report.checks.push('Mobile 390x844: deep link, UTC, masked-source warning, WISE/M101 selection and side-by-side; no horizontal overflow');
  // Fault injection is explicitly a TEST ERROR, not simulated science data.
  await page.route('**/api/datasets',route=>route.fulfill({
   status:200,contentType:'application/json',body:JSON.stringify(inventory.map(item=>item.id==='wise0855-d6'
    ? {...item,available:false,status:'unavailable',reason:'TEST: missing prepared artifacts'}:item)),
  }));
  await page.route('**/api/datasets/wise0855-d6/frames',route=>route.fulfill({
   status:503,contentType:'application/json',body:JSON.stringify({detail:'TEST: dataset unavailable'}),
  }));
  await page.goto(`${base}/?api=real&dataset=wise0855-d6`);
  await page.getByText('Error en API SPHEREx: TEST: dataset unavailable',{exact:true}).waitFor();
  await page.getByText(/Dataset no preparado: TEST: missing prepared artifacts/).waitFor();
  assert.ok((await page.locator('.field-heading h1').innerText()).includes('WISE'));
  assert.equal(await page.locator('.epoch-selector button').count(),0);
  assert.equal(await page.locator('.catalog-overlay').count(),0);
  report.checks.push('Unavailable inventory + 503: explicit status/error, cleared epochs/overlays, no synthetic fallback');
  await page.goto(`${base}/?api=mock&target=wise0855`);
  await page.waitForFunction(()=>document.querySelector('.viewer-viewport canvas')?.width===256);
  assert.equal(await page.locator('.scientific-cases').count(),0);
  assert.equal(await page.locator('.epoch-selector button').count(),4);
  report.checks.push('Mock: separate 256x256, four generated epochs; scientific cases hidden');
  assert.deepEqual(errors,[]);
  report.status='passed';
  fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
 } finally {await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
