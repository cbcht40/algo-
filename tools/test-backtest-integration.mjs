import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, utimes, stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { gzipSync } from 'node:zlib'
import { binaryRecords, atomicJson, loadJson } from '../src/backtest/archive.mjs'
import { ReplayRunner } from '../src/backtest/runner.mjs'
import { ReplayStorage } from '../src/backtest/storage.mjs'
import { PersonalCapture, readCapture } from '../src/backtest/capture.mjs'
import { createBacktestService } from '../src/backtest/service.mjs'
import { instrumentSpec } from '../src/backtest/instruments.mjs'
import { Readable } from 'node:stream'
const origin='https://let-tradejournal.com', owner='00000000-0000-4000-8000-000000000001'
const base=1714521600000000000n, instrument=instrumentSpec('ESM4')
const settings={capital:'50000',commission:'1.25',slippageTicks:1,costsConfirmed:true}
function record({ts=base, action='A',side='B',id=1,price=5000,size=10,flags=128}={}) {
 const b=Buffer.alloc(56); b[0]=14;b[1]=160;b.writeUInt32LE(123,4);b.writeBigUInt64LE(ts,8);b.writeBigUInt64LE(BigInt(id),16);b.writeBigInt64LE(BigInt(Math.round(price*1e9)),24);b.writeUInt32LE(size,32);b[36]=flags;b[38]=action.charCodeAt(0);b[39]=side.charCodeAt(0);b.writeBigUInt64LE(ts,40);return b
}
async function fixture() {
 const root=await mkdtemp(join(tmpdir(),'ltj-backtest-'))
 const chunks=[record({action:'R',flags:0}),record({id:1,side:'B',price:5000,flags:0}),record({id:2,side:'A',price:5000.25})]
 for(let i=1;i<=9;i++) chunks.push(record({ts:base+BigInt(i)*1000000000n,action:'T',id:0,side:i%2?'B':'A',price:5000+i*.25,size:3}))
 const cache=join(root,'source.mbo.gz');await writeFile(cache,gzipSync(Buffer.concat(chunks)))
 const dataset={id:'fixture',name:'fixture',source:'databento',start:base.toString(),end:(base+10000000000n).toString(),fingerprint:'a'.repeat(64)}
 const runner=await new ReplayRunner({file:join(root,'first.json'),cache,dataset,instrument,settings,start:base.toString(),owner}).prepare()
 return {root,runner,cache,dataset}
}
test('DBN binary chunk boundaries and nanosecond IDs remain lossless',async()=>{
 const b=record({id:1});b.writeBigUInt64LE(18446744073709551000n,16)
 const out=[];for await(const r of binaryRecords(Readable.from([b.subarray(0,7),b.subarray(7,38),b.subarray(38)])))out.push(r)
 assert.equal(out.length,1);assert.equal(out[0].orderId,'18446744073709551000');assert.equal(out[0].ts,base.toString())
 await assert.rejects(async()=>{for await(const r of binaryRecords(Readable.from([b.subarray(0,55)])))void r},/tronquée/)
})
test('clock, candles and passive orders expose no future; restored replay is identical',async()=>{
 const {root,runner:r,cache,dataset}=await fixture()
 try {
  assert.equal(r.view().market.bars.length,0)
  await r.action({type:'place',kind:'market',side:'buy',quantity:5,commandId:'entry',stopTicks:8,targetTicks:20})
  assert.equal(r.view().fills.length,0)
  await r.action({type:'step'})
  assert.equal(r.view().fills.length,1);assert.equal(r.view().market.bars.at(-1).high,5000.25)
  await r.action({type:'place',kind:'market',side:'sell',quantity:2,reduceOnly:true,commandId:'partial'})
  await r.action({type:'step'})
  await r.persist();const saved=await loadJson(r.file)
  const restored=await new ReplayRunner({file:join(root,'restored.json'),cache,dataset,instrument,start:r.start,owner,saved}).prepare()
  assert.deepEqual(restored.engine.snapshot(),r.engine.snapshot());assert.deepEqual(restored.market.view(),r.market.view())
  for(const q of [r,restored]){await q.action({type:'flatten',commandId:'close'});await q.action({type:'step'})}
  assert.deepEqual(restored.engine.snapshot(),r.engine.snapshot());assert.equal(r.engine.quantity,0);assert.equal(r.engine.pending.length,0)
  assert.equal(r.view().market.bars.at(-1).high,5000.75)
  await restored.close()
 }finally{await r.close();await rm(root,{recursive:true,force:true})}
})
test('x1, x2, x5, x10, x30 batching preserves identical fills and accounting',async()=>{
 const {root,runner,cache,dataset}=await fixture();const results=[]
 try {
  for(const speed of [1,2,5,10,30]){
   const r=await new ReplayRunner({file:join(root,`speed-${speed}.json`),cache,dataset,instrument,settings,start:base.toString(),owner}).prepare()
   await r.action({type:'speed',speed});await r.action({type:'place',kind:'market',side:'sell',quantity:2,commandId:'entry'})
   await r.advanceTo(base+3000000000n)
   await r.action({type:'flatten',commandId:'exit'})
   const step=BigInt(speed)*100000000n
   for(let t=base+3000000000n+step;t<base+10000000000n;t+=step)await r.advanceTo(t)
   await r.advanceTo(base+10000000000n);results.push(r.engine.snapshot());await r.close()
  }
  for(const result of results.slice(1))assert.deepEqual(result,results[0])
 }finally{await runner.close();await rm(root,{recursive:true,force:true})}
})
test('capture keeps trade order, explicit gaps, unknown aggressors; same engine consumes it',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ltj-capture-'));const file=join(root,'capture.events.gz')
 try{
 const capture=await new PersonalCapture({file,instrument}).open()
 const event={ts:base.toString(),valid:true,bid:{price:'5000000000000',size:10},ask:{price:'5000250000000',size:10},trades:[]}
 await capture.append(event)
 await capture.append({...event,ts:(base+1000000000n).toString(),trades:[{price:'5000250000000',size:2,side:'unknown'}]})
 await capture.append({...event,ts:(base+2000000000n).toString(),valid:false,gap:true,trades:[]})
 const manifest=await capture.close();assert.equal(manifest.capabilities.depth,false)
 const events=[];for await(const e of readCapture(file))events.push(e)
 assert.equal(events.length,3);assert.equal(events[1].trades[0].side,'unknown');assert.equal(events[2].gap,true)
 const r=await new ReplayRunner({file:join(root,'session.json'),cache:file,dataset:{...manifest,id:'capture',name:'capture'},instrument,settings,start:base.toString(),owner}).prepare()
 await r.action({type:'place',kind:'market',side:'buy',quantity:1,commandId:'entry'})
 await r.action({type:'step'});await r.action({type:'step'});assert.equal(r.view().position.unrealized,null);assert.match(r.view().error,/interrompue/);await r.close()
 }finally{await rm(root,{recursive:true,force:true})}
})
test('60-day retention protects saved sessions and never touches originals',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ltj-storage-'))
 try{
 await mkdir(join(root,'sessions'));await mkdir(join(root,'captures'));await mkdir(join(root,'data/cache'),{recursive:true})
 const old=join(root,'captures','old.events.gz'),protectedFile=join(root,'captures','protected.events.gz'),original=join(root,'original.dbn.zst')
 for(const file of [old,protectedFile,original]){await writeFile(file,'untouched');await utimes(file,new Date(0),new Date(0))}
 await atomicJson(join(root,'sessions',owner+'.json'),{cache:protectedFile})
 const storage=await new ReplayStorage(root).load();await storage.reserve(0)
 await assert.rejects(stat(old),{code:'ENOENT'});assert.equal(await readFile(protectedFile,'utf8'),'untouched');assert.equal(await readFile(original,'utf8'),'untouched')
 assert.equal((await storage.status()).protectedBytes,9);await assert.rejects(storage.configure(0));await assert.rejects(storage.reserve(100*1024**3),/protégées/)
 }finally{await rm(root,{recursive:true,force:true})}
})
test('local bridge enforces host, origin, pairing, owner and scoped routes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ltj-service-'))
 const service=await createBacktestService({root,decoder:'/not-used',port:0,authenticate:async token=>token==='edge'?owner:(()=>{throw new Error('Edge requis')})()})
 const url=`http://127.0.0.1:${service.port}`
 const request=(path,body,extra={})=>fetch(url+path,{method:body?'POST':'GET',headers:{Origin:origin,...(body?{'Content-Type':'application/json'}:{}),...extra},body:body?JSON.stringify(body):undefined})
 try{
 assert.equal((await fetch(url+'/v1/status')).status,403)
 assert.equal((await request('/v1/status',null,{Origin:'https://evil.example'})).status,403)
 const page=await fetch(url+'/bridge.html');assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/)
 assert.equal((await request('/bridge.js',null,{Origin:'https://evil.example'})).status,403)
 const bridgeScript=await (await fetch(url+'/bridge.js')).text();assert.match(bridgeScript,/event.source !== parentWindow/);assert.match(bridgeScript,/https:\/\/let-tradejournal.com/);assert.ok(!bridgeScript.includes('__ALLOWED_PARENT_ORIGINS__'))
 assert.equal((await request('/v1/catalog')).status,401)
 assert.equal((await request('/v1/pair',{code:'wrong',accessToken:'edge'})).status,403)
 const p=await request('/v1/pair',{code:service.pairCode(),accessToken:'edge'});assert.equal(p.status,200);const {token}=await p.json()
 const headers={Authorization:`Bearer ${token}`}
 assert.equal((await request('/v1/catalog',null,headers)).status,200)
 assert.equal((await request('/v1/catalog',null,{...headers,Origin:'https://www.let-tradejournal.com'})).status,401)
 assert.equal((await request('/api/order',{side:'buy'},headers)).status,404)
 assert.equal((await request('/v1/sessions/00000000-0000-4000-8000-000000000099',null,headers)).status,400)
 assert.equal((await request('/v1/storage',{limitGB:5},headers)).status,200)
 assert.equal((await request('/v1/disconnect',{},headers)).status,200)
 assert.equal((await request('/v1/catalog',null,headers)).status,401)
 const preflight=await fetch(url+'/v1/catalog',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Private-Network':'true'}})
 assert.equal(preflight.headers.get('access-control-allow-private-network'),'true')
 const localOrigin=`http://localhost:${service.port}`
 const localPair=await request('/v1/pair',{code:service.pairCode(),accessToken:'edge'},{Origin:localOrigin})
 assert.equal(localPair.status,200);const localGrant=await localPair.json()
 assert.equal((await request('/v1/catalog',null,{Authorization:`Bearer ${localGrant.token}`})).status,401,'Popup grants cannot be reused by another origin')
 assert.equal((await request('/v1/catalog',null,{Origin:localOrigin,Authorization:`Bearer ${localGrant.token}`})).status,200)
 }finally{await service.close();await rm(root,{recursive:true,force:true})}
})
