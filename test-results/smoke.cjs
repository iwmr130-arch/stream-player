const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { app, BrowserWindow } = require('electron');
const root = path.resolve(__dirname, '..');
const logFile = path.join(__dirname, 'run.log');
fs.writeFileSync(logFile, 'start\n');
console.log = (...args) => fs.appendFileSync(logFile, args.join(' ')+'\n');
console.error = console.log;
process.on('uncaughtException', e => { console.error(e.stack); app.exit(2); });
process.on('unhandledRejection', e => { console.error(String(e)); app.exit(2); });
require.extensions['.ts'] = (mod, file) => mod._compile(require('esbuild').transformSync(fs.readFileSync(file, 'utf8'), { loader: 'ts', format: 'cjs' }).code, file);
const { parseOnlineUrl } = require('../src/shared/media.ts');
const { normalizeState } = require('../src/main/normalize.ts');
const { Store } = require('../src/main/store.ts');
const results = [];
const delay = ms => new Promise(r => setTimeout(r, ms));
async function test(name, fn) { try { await fn(); results.push({ name, pass: true }); } catch(e) { results.push({ name, pass: false, error: String(e) }); } console.log(JSON.stringify(results.at(-1))); }
async function until(fn) { for(let i=0;i<100;i++) { if(await fn()) return; await delay(100); } throw Error('timeout'); }
const profile = fs.mkdtempSync(path.join(__dirname, 'profile-'));
app.setPath('userData', profile);
const wav = path.join(profile, '無音.wav');
const data = Buffer.alloc(44 + 8000 * 2 * 8);
data.write('RIFF'); data.writeUInt32LE(data.length-8,4); data.write('WAVEfmt ',8); data.writeUInt32LE(16,16); data.writeUInt16LE(1,20); data.writeUInt16LE(1,22); data.writeUInt32LE(8000,24); data.writeUInt32LE(16000,28); data.writeUInt16LE(2,32); data.writeUInt16LE(16,34); data.write('data',36); data.writeUInt32LE(data.length-44,40); fs.writeFileSync(wav,data);
const state = normalizeState({ main: [{id:'a',kind:'local',source:wav,title:'無音テスト',endAction:'stop'}], bgm:[{id:'b',path:wav,title:'BGMテスト'}], settings:{fadeMs:0} });
fs.writeFileSync(path.join(profile,'state.json'), JSON.stringify(state));
const errors=[];
app.on('web-contents-created', (_, wc) => { wc.on('preload-error',(_,p,e)=>errors.push(String(e))); wc.on('render-process-gone',(_,d)=>errors.push(JSON.stringify(d))); });
require('../dist/main/main.js');
setTimeout(()=>{ console.error('global timeout'); app.exit(2); },90000).unref();
(async()=>{
await test('YouTube 通常・短縮・Shorts・開始時刻',()=>{ for(const url of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m30s','https://youtu.be/dQw4w9WgXcQ?t=90','https://youtube.com/shorts/dQw4w9WgXcQ?start=90']) { const r=parseOnlineUrl(url); assert.equal(r.id,'dQw4w9WgXcQ'); assert.equal(r.start,90); } });
await test('Vimeo 公開・限定公開',()=>{ assert.equal(parseOnlineUrl('https://vimeo.com/123456').id,'123456'); assert.equal(parseOnlineUrl('https://vimeo.com/123456/abcdef').url,'https://vimeo.com/123456/abcdef'); assert.equal(parseOnlineUrl('https://player.vimeo.com/video/123456?h=abcdef').url,'https://vimeo.com/123456/abcdef'); });
await test('不正URL拒否',()=>{ for(const s of ['bad','javascript:alert(1)','https://example.com/watch?v=dQw4w9WgXcQ','https://youtube.com/watch?v=x']) assert.equal(parseOnlineUrl(s),null); });
await test('設定補完・範囲補正・ID重複解消',()=>{ const s=normalizeState({main:[{id:'x',source:'a'},{id:'x',source:'b'},null],settings:{mainVolume:999,bgmVolume:-1}}); assert.equal(s.main.length,2); assert.notEqual(s.main[0].id,s.main[1].id); assert.equal(s.settings.mainVolume,100); assert.equal(s.settings.bgmVolume,0); assert.deepEqual(normalizeState(null).main,[]); });
await test('保存と再読込',()=>{ const dir=path.join(profile,'store-test'); const s=new Store(dir); s.setState(state); s.setWindowBounds('output',{x:1,y:2,width:960,height:540}); s.flush(); const t=new Store(dir); assert.deepEqual(t.getState(),state); assert.equal(t.getWindowState().output.width,960); });
await app.whenReady();
let control, output;
await until(()=>{ const ws=BrowserWindow.getAllWindows(); control=ws.find(w=>w.webContents.getURL().includes('/control/')); output=ws.find(w=>w.webContents.getURL().includes('/output/')); return control && output && !control.webContents.isLoading() && !output.webContents.isLoading(); });
const c = code=>control.webContents.executeJavaScript(code);
const o = code=>output.webContents.executeJavaScript(code);
const click=id=>c(`document.getElementById(${JSON.stringify(id)}).click()`);
await until(()=>c('document.querySelectorAll("#main-list li").length === 1'));
await test('2画面起動・preload',()=>{assert.equal(BrowserWindow.getAllWindows().length,2); assert.deepEqual(errors,[]);});
const base = await c('window.api.getMediaBase()');
await test('HTTP 全体取得・HEAD・Range・末尾Range・範囲外',async()=>{ const url=base+'?p='+encodeURIComponent(wav); let r=await fetch(url); assert.equal(r.status,200); assert.equal((await r.arrayBuffer()).byteLength,data.length); r=await fetch(url,{method:'HEAD'}); assert.equal(r.headers.get('content-length'),String(data.length)); r=await fetch(url,{headers:{Range:'bytes=10-19'}}); assert.equal(r.status,206); assert.deepEqual(Buffer.from(await r.arrayBuffer()),data.subarray(10,20)); r=await fetch(url,{headers:{Range:'bytes=-10'}}); assert.equal((await r.arrayBuffer()).byteLength,10); r=await fetch(url,{headers:{Range:'bytes=999999-'}}); assert.equal(r.status,416); });
await test('HTTP 不正トークン・相対パス・POST拒否',async()=>{ assert.equal((await fetch(base+'bad?p='+encodeURIComponent(wav))).status,404); assert.equal((await fetch(base+'?p=relative.wav')).status,400); assert.equal((await fetch(base,{method:'POST'})).status,405); });
await test('WAV 再生と音声時の待機画面',async()=>{await click('main-play'); await until(()=>o('!!document.querySelector("video") && !document.querySelector("video").paused && document.querySelector("video").currentTime > 0')); assert.equal(await o('document.getElementById("video-layer").hidden'),true);});
await test('一時停止・シーク・再開',async()=>{ await click('main-play'); await until(()=>o('document.querySelector("video").paused')); await c('window.api.sendOutputCommand({type:"seek",time:4})'); await until(()=>o('Math.abs(document.querySelector("video").currentTime-4)<0.2')); await click('main-play'); await until(()=>o('!document.querySelector("video").paused')); });
await test('再生中ループ切替',async()=>{ await c('window.api.sendOutputCommand({type:"setLoop",loop:true})'); await until(()=>o('document.querySelector("video").loop')); await c('window.api.sendOutputCommand({type:"setLoop",loop:false})'); await until(()=>o('!document.querySelector("video").loop')); });
await test('停止と待機への復帰',async()=>{ await click('main-stop'); await until(()=>o('!document.querySelector("video")')); await until(()=>c('document.getElementById("main-state").dataset.state === "idle"')); });
await test('BGM 再生・一時停止',async()=>{await click('bgm-play'); await until(()=>c('document.getElementById("bgm-state").textContent.includes("再生")')); await click('bgm-play'); await until(()=>c('!document.getElementById("bgm-state").textContent.includes("再生")'));});
const bgmCode = require('esbuild').transformSync(fs.readFileSync(path.join(root,'src/renderer/control/bgm.ts'),'utf8'),{loader:'ts',format:'cjs'}).code;
await c(`{const module={exports:{}}; ${bgmCode}; window.TestBgmPlayer=module.exports.BgmPlayer; undefined;}`);
await test('BGM ダッキング lower・pause・none と復帰',async()=>{
  const value=await c(`(async()=>{const settings=${JSON.stringify(state.settings)}; const p=new window.TestBgmPlayer({items:()=>[{id:'x',path:'x',title:'x'}],settings:()=>settings,urlFor:()=>${JSON.stringify(base+'?p='+encodeURIComponent(wav))},onChange:()=>{},onError:()=>{}}); p.playItem('x'); await p.audio.play(); p.setDucked(true); const lower=p.audio.volume; p.setDucked(false); const restored=p.audio.volume; settings.duckingMode='pause'; p.setDucked(true); await Promise.resolve(); const paused=p.audio.paused; p.setDucked(false); await p.audio.play(); const resumed=!p.audio.paused; settings.duckingMode='none'; p.setDucked(true); const none=p.audio.volume; p.unload(); return {lower,restored,paused,resumed,none};})()`);
  assert.deepEqual(value,{lower:0.1,restored:0.5,paused:true,resumed:true,none:0.5});
});
await test('BGM 曲終了時に欠落ファイルを飛ばして次の有効曲へ進む',async()=>{
  const value=await c(`(async()=>{const items=[{id:'first',title:'first'},{id:'missing',title:'missing'},{id:'last',title:'last'}];const errors=[];const p=new window.TestBgmPlayer({items:()=>items,settings:()=>(${JSON.stringify(state.settings)}),urlFor:i=>i.id==='missing'?null:${JSON.stringify(base+'?p='+encodeURIComponent(wav))},onChange:()=>{},onError:e=>errors.push(e)});p.playItem('first');await p.audio.play();p.audio.dispatchEvent(new Event('ended'));await new Promise(r=>setTimeout(r,700));const result={id:p.currentId,errors};p.unload();return result;})()`);
  assert.equal(value.id,'last',JSON.stringify(value));
});
await test('出力を閉じて再表示',async()=>{output.close(); assert.equal(output.isDestroyed(),false); assert.equal(output.isVisible(),false); await click('btn-show-output'); await until(()=>output.isVisible());});
for (const scenario of ['natural', 'consecutive', 'previous-paused', 'all-missing']) {
  await test(`BGM 修正確認 ${scenario}`, async()=>{
    const value=await c(`(async()=>{
      const scenario=${JSON.stringify(scenario)};
      const items=['first','missing1','missing2','last'].map(id=>({id,title:id}));
      let allMissing=false;const errors=[];
      const p=new window.TestBgmPlayer({items:()=>items,settings:()=>(${JSON.stringify(state.settings)}),urlFor:i=>allMissing||i.id.startsWith('missing')?null:${JSON.stringify(base+'?p='+encodeURIComponent(wav))},onChange:()=>{},onError:e=>errors.push(e)});
      try {
        p.playItem(scenario==='previous-paused'?'last':'first');await p.audio.play();
        if(scenario==='natural'){p.audio.currentTime=7.7;await new Promise(r=>setTimeout(r,1200));}
        if(scenario==='consecutive'){p.next();await new Promise(r=>setTimeout(r,300));}
        if(scenario==='previous-paused'){await p.pause();p.audio.currentTime=0;p.prev();await new Promise(r=>setTimeout(r,100));}
        if(scenario==='all-missing'){await p.pause();allMissing=true;p.next();}
        return {id:p.currentId,paused:p.audio.paused,wantPlay:p.wantPlay,time:p.audio.currentTime,errors};
      }finally{p.unload();}
    })()`);
    if(scenario==='all-missing'){assert.equal(value.wantPlay,false);assert.equal(value.paused,true);assert(value.errors.some(e=>e.includes('再生可能な曲がありません')));assert(value.errors.length<=5);}
    else if(scenario==='previous-paused'){assert.equal(value.id,'first');assert.equal(value.paused,true);assert.equal(value.wantPlay,false);}
    else{assert.equal(value.id,'last',JSON.stringify(value));assert.equal(value.paused,false);assert(value.time>0);}
  });
}
await test('プレビュー画像受信',async()=>{await until(()=>c('document.getElementById("preview").src.startsWith("data:image/jpeg")'));});
await test('レンダラ再読込後のリスト復元',async()=>{control.reload(); await until(()=>!control.webContents.isLoading()); await until(()=>c('document.querySelectorAll("#main-list li").length===1'));});
fs.writeFileSync(path.join(__dirname,'control.png'),(await control.webContents.capturePage()).toPNG());
fs.writeFileSync(path.join(__dirname,'results.json'),JSON.stringify({date:new Date().toISOString(),results,errors},null,2));
console.log(`RESULT ${results.filter(r=>r.pass).length}/${results.length}`);
app.exit(results.every(r=>r.pass)?0:1);
})().catch(e=>{console.error(e);app.exit(2);});

