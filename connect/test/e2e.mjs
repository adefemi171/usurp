// Real packaged install + browser + OS keychain + signed fixture ingestion.
// Run only against the isolated development website on localhost:3107.
import { chromium } from "../../desktop/node_modules/playwright/index.mjs";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
const exec = promisify(execFile);
const website = "http://localhost:3107";
const root = await mkdtemp(join(tmpdir(), "usurp-package-e2e-"));
const prefix = join(root, "installed"), data = join(root, "service"), fixtures = join(root, "fixtures");
const bin = join(prefix, "node_modules/@adefemi171/usurp-connect/dist/main.cjs");
const worker = join(prefix, "node_modules/@adefemi171/usurp-connect/dist/worker.cjs");
const cli = (...args) => exec(process.execPath, [bin, ...args, "--data-dir", data], { cwd: root, timeout: 25000 });
const readRuntime = async () => JSON.parse(await readFile(join(data, "runtime.json"), "utf8"));
let runtime, browser, page, web;
const state = async () => (await fetch(`${runtime.origin}/api/state`, { headers: { authorization: `Bearer ${runtime.token}` } })).json();
const waitFor = async fn => { for (let i=0;i<150;i++) { if (await fn()) return; await new Promise(r=>setTimeout(r,400)); } throw new Error("Timed out waiting for service state"); };
async function openControls() { runtime=await readRuntime(); await page.goto(`${runtime.origin}/#${runtime.token}`); await page.waitForFunction(()=>document.getElementById('status').textContent!=='Loading local service…'); }
try {
  await exec("npm", ["install", "--prefix", prefix, "--no-audit", "--no-fund", `${website}/downloads/usurp-connect-0.1.0.tgz`], {cwd:root,timeout:120000});
  assert.match((await cli("--help")).stdout,/Local|local/);
  console.log("Installed the downloadable archive outside the repository; executable resolves.");
  // Redirect only the test installation's reader homedir to synthetic logs.
  // Production package code, keychain, signing, transport, and browser stay real.
  await mkdir(join(fixtures,".codex/sessions"),{recursive:true});
  const timestamp = new Date(Date.now()-3600000).toISOString();
  await writeFile(join(fixtures,".codex/sessions/test.jsonl"),[
    {timestamp,type:"session_meta",payload:{id:"package-fixture"}},
    {timestamp,type:"turn_context",payload:{model:"gpt-5.6-sol"}},
    {timestamp,type:"event_msg",payload:{type:"token_count",info:{last_token_usage:{input_tokens:1000,cached_input_tokens:900,output_tokens:10},total_token_usage:{total_tokens:1010}}}},
  ].map(JSON.stringify).join("\n"));
  await writeFile(worker, `require('node:os').homedir = () => ${JSON.stringify(fixtures)};\n` + await readFile(worker,"utf8"));
  await cli("start","--no-open","--port","0","--server",website);
  runtime=await readRuntime(); const firstPid=runtime.pid;
  await cli("start","--no-open","--port","0"); assert.equal((await readRuntime()).pid,firstPid);
  assert.equal((await state()).consent,false); assert.equal((await state()).lastUpload,undefined);
  browser=await chromium.launch({channel:"chrome",headless:true});
  page=await browser.newPage({viewport:{width:1160,height:960}}); page.setDefaultTimeout(25000);
  await openControls(); assert.equal(new URL(page.url()).hash,"");
  assert.equal(await page.locator('#sources input:checked').count(),0);
  await page.getByRole('button',{name:'Connect account',exact:true}).click();
  await page.locator('#approve').waitFor({state:'visible'});
  const link=await page.locator('#approve').getAttribute('href');
  const code=await page.locator('#code').innerText();
  await cli("stop"); await waitFor(async()=>!await readRuntime().catch(()=>undefined));
  await cli("start","--no-open","--port","0"); await openControls();
  assert.equal(await page.locator('#code').innerText(),code);
  web=await browser.newPage(); await web.goto(link);
  await web.getByRole('link',{name:'Developer sign-in (local only)'}).click();
  const handle=`service_${Date.now().toString(36)}`;
  await web.getByRole('textbox',{name:'Handle'}).fill(handle);
  await web.getByRole('button',{name:'Sign in',exact:true}).click();
  await web.getByRole('heading',{name:'Is this your code?'}).waitFor();
  assert.ok((await web.locator('main').innerText()).includes(code));
  await web.getByRole('button',{name:'Yes, connect this computer'}).click();
  await web.getByRole('heading',{name:'Computer connected.'}).waitFor();
  await waitFor(async()=>!!(await state()).deviceId);
  assert.equal((await state()).lastUpload,undefined);
  await page.locator('#sources input[value="codex"]').check(); await page.locator('#consent').check();
  await page.getByRole('button',{name:'Save choices & start syncing'}).click();
  await waitFor(async()=>!!(await state()).lastUpload);
  assert.match((await cli("status")).stdout,/Upload confirmed/);
  await web.goto(`${website}/u/${handle}?window=all`);
  const profile=await web.locator('main').innerText();
  assert.ok(profile.toLowerCase().includes('codex')); assert.ok(profile.includes('110')&&profile.includes('900')&&profile.includes('1 native calls'));
  await page.getByRole('button',{name:'Pause',exact:true}).click(); await waitFor(async()=>(await state()).paused);
  await cli("stop");await waitFor(async()=>!await readRuntime().catch(()=>undefined));await cli("start","--no-open","--port","0");await openControls();
  assert.equal((await state()).paused,true);assert.ok((await state()).lastUpload);
  await page.getByRole('button',{name:'Resume sync',exact:true}).click();await waitFor(async()=>!(await state()).paused&&!((await state()).busy));
  await page.getByRole('button',{name:'Pause',exact:true}).click();await waitFor(async()=>(await state()).paused);
  await page.screenshot({path:join(root,'controls-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(root,'controls-mobile.png'),fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await web.screenshot({path:join(root,'uploaded-profile.png'),fullPage:true});
  await web.goto(`${website}/settings#devices`);await web.getByRole('button',{name:'Revoke',exact:true}).click();await web.getByText('revoked',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Save choices & start syncing'}).click();await waitFor(async()=>(await state()).status.includes('Sync incomplete'));
  await page.getByRole('button',{name:'Pause',exact:true}).click(); await waitFor(async()=>(await state()).paused);
  page.on('dialog',d=>d.accept());await page.getByRole('button',{name:'Disconnect',exact:true}).click();await waitFor(async()=>!(await state()).deviceId);
  const c=JSON.parse(await readFile(join(data,'device/config.json'),'utf8'));assert.equal(c.deviceId,undefined);
  console.log(JSON.stringify({passed:true,tested:['HTTP package install outside repo','background start and single-instance reopen','local bearer authentication','pairing survives restart in OS keychain','browser account approval','explicit source consent','real signed synthetic sync','exact hosted fixture totals','pause persists after restart','mobile layout','revoked device refuses upload','disconnect'],artifacts:root}));
}catch(e){
  if(page&&!page.isClosed()){console.error('Local status:',await page.locator('#status').innerText().catch(()=>''));console.error('Local error:',await page.locator('#error').innerText().catch(()=>''));await page.screenshot({path:join(root,'failure.png'),fullPage:true}).catch(()=>{});}
  console.error('Artifacts:',root);throw e;
}finally{
  // Remove only test keyring entries, even after an assertion failure.
  try {runtime=await readRuntime();await fetch(`${runtime.origin}/api/action`,{method:'POST',headers:{authorization:`Bearer ${runtime.token}`,'content-type':'application/json'},body:JSON.stringify({action:'pause'})});if(!(await state()).busy)await fetch(`${runtime.origin}/api/action`,{method:'POST',headers:{authorization:`Bearer ${runtime.token}`,'content-type':'application/json'},body:JSON.stringify({action:(await state()).pairing?'cancel':'disconnect'})});}catch{}
  await cli('stop').catch(()=>{});if(browser)await browser.close();
}
