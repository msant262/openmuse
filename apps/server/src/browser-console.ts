/** The console renders only a screenshot; remote page code never runs in this document. */
export function browserConsole(previewUrl: string) {
  const preview = JSON.stringify(previewUrl).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenMuse browser</title><style>
*{box-sizing:border-box}body{margin:0;background:#fcfcfc;color:#172125;font:14px -apple-system,BlinkMacSystemFont,system-ui,sans-serif}
header{padding:12px;display:flex;align-items:center;justify-content:space-between;gap:12px}#status{color:#697176;font-size:12px}#status.live{color:#248258}
button,input{font:inherit;border:1px solid #e9edef;border-radius:24px;padding:10px 14px;background:white;color:inherit;min-height:42px}
button{cursor:pointer}button:hover{background:#edf7fd}button:disabled{opacity:.45;cursor:default}button:focus-visible,input:focus-visible{outline:2px solid #1473c8;outline-offset:2px}
form{padding:0 12px 10px;display:flex;gap:8px}input{flex:1;min-width:0;background:#f1f3f4;border-color:transparent}#type{background:#c8e7ff}
nav{display:flex;gap:6px;padding:0 12px 12px;flex-wrap:wrap}nav button{font-size:12px;min-height:36px;padding:7px 12px}
#stage{overflow:hidden;background:#eef1f3;border-radius:18px;min-height:160px;margin:0 8px}img{display:block;width:100%;height:auto;cursor:crosshair;touch-action:pan-y}img.stale{opacity:.45;pointer-events:none}
#error{margin:0 12px 12px;color:#984a41;background:#fbefed;padding:12px;border-radius:14px}#error:empty{display:none}footer{padding:12px;color:#697176;font-size:12px;line-height:1.5}
</style><header><strong>Browser</strong><span id="status" role="status">Connecting…</span><button id="refresh" aria-label="Refresh browser preview">↻</button></header>
<nav><button id="take">Take control</button><button id="handback" hidden>Hand back to agent</button><span id="mode" role="status">Watching the agent</span></nav>
<form><input id="text" aria-label="Text to type in browser" placeholder="Type into the selected field" autocomplete="off"><button id="type" type="submit">Send text</button></form>
<nav aria-label="Browser keyboard"><button data-key="Enter">Enter ↵</button><button data-key="Tab">Tab ⇥</button><button data-key="Backspace">Delete ⌫</button><button id="up">Scroll ↑</button><button id="down">Scroll ↓</button></nav>
<div id="error" role="alert"></div><div id="stage"><img id="screen" class="stale" alt="Live browser session, click to interact" draggable="false"></div>
<footer>Tap the page to select a field, then send text above. Watch live, take control to intervene, then hand back. Closing this view keeps your chosen control mode. Durable tasks resume after handback; send “continue” in chat if its reply has paused.</footer><script>
const image=document.querySelector('#screen'),error=document.querySelector('#error'),status=document.querySelector('#status'),field=document.querySelector('#text');
let refreshing=false,sending=false,imageUrl,live=false,previewError=false,human=false,timer,previousPixels,unchanged=0;
function schedule(){clearTimeout(timer);if(!document.hidden)timer=setTimeout(refresh,unchanged>=3?6000:2000);}
function controls(){document.querySelectorAll('[data-key],#up,#down,#type').forEach(button=>button.disabled=sending||!live||!human);image.classList.toggle('stale',!live||sending);document.querySelector('#take').hidden=human;document.querySelector('#handback').hidden=!human;document.querySelector('#mode').textContent=human?'You are in control':'Watching the agent';document.querySelector('#take').disabled=sending;document.querySelector('#handback').disabled=sending;}
async function refresh(){if(refreshing||sending||document.hidden)return;refreshing=true;try{
const state=await fetch(location.href,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:'status'}),signal:AbortSignal.timeout(20000)});if(!state.ok)throw new Error('Browser control state unavailable. Reopen this view.');human=(await state.json()).control==='human';
const r=await fetch(${preview},{cache:'no-store',signal:AbortSignal.timeout(20000)});
if(!r.ok)throw new Error(r.status===401?'Session access expired. Close this view and open the browser again.':'Browser disconnected. Reopen the session from OpenMuse.');
const blob=await r.blob(),pixels=new Uint8Array(await blob.arrayBuffer());unchanged=previousPixels&&pixels.length===previousPixels.length&&pixels.every((byte,i)=>byte===previousPixels[i])?unchanged+1:0;previousPixels=pixels;const next=URL.createObjectURL(blob);await new Promise((resolve,reject)=>{const probe=new Image();probe.onload=resolve;probe.onerror=()=>{URL.revokeObjectURL(next);reject(new Error('The browser preview could not be displayed.'));};probe.src=next;});
if(imageUrl)URL.revokeObjectURL(imageUrl);imageUrl=next;image.src=next;live=true;status.textContent='Live';status.className='live';if(previewError){error.textContent='';previewError=false;}
}catch(e){live=false;previewError=true;status.textContent='Disconnected';status.className='';error.textContent=e.message;}finally{refreshing=false;controls();schedule();}}
async function input(body){unchanged=0;if(sending||!live||!human)return false;sending=true;controls();error.textContent='';status.textContent='Updating…';let ok=false;try{
const r=await fetch(location.href,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
if(!r.ok){const data=await r.json();throw new Error(typeof data.error==='string'?data.error:'Browser action failed. Your text is still here.');}ok=true;
}catch(e){error.textContent=e.message;}finally{sending=false;controls();await refresh();}return ok;}
image.onclick=e=>{if(!live||sending||!human)return;const r=image.getBoundingClientRect();input({type:'click',x:Math.min(1279,Math.max(0,Math.floor((e.clientX-r.left)*1280/r.width))),y:Math.min(799,Math.max(0,Math.floor((e.clientY-r.top)*800/r.height)))});};
document.querySelector('form').onsubmit=async e=>{e.preventDefault();const text=field.value;if(text&&await input({type:'text',text})&&field.value===text)field.value='';};
document.querySelectorAll('[data-key]').forEach(b=>b.onclick=()=>input({type:'key',key:b.dataset.key}));
document.querySelector('#up').onclick=()=>input({type:'scroll',deltaY:-600});document.querySelector('#down').onclick=()=>input({type:'scroll',deltaY:600});
async function changeControl(control){if(sending)return;sending=true;controls();error.textContent='';try{const r=await fetch(location.href,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({control}),signal:AbortSignal.timeout(45000)});if(!r.ok)throw new Error('Control change failed. Reconnect and check the current mode.');human=(await r.json()).control==='human';}catch(e){error.textContent=e.message;}finally{sending=false;controls();await refresh();}}
document.querySelector('#take').onclick=()=>changeControl('human');document.querySelector('#handback').onclick=()=>changeControl('agent');
document.querySelector('#refresh').onclick=()=>{error.textContent='';refresh();};document.addEventListener('visibilitychange',()=>{clearTimeout(timer);live=false;controls();if(!document.hidden){unchanged=0;refresh();}});
controls();refresh();window.addEventListener('pagehide',()=>{clearTimeout(timer);live=false;controls();previousPixels=undefined;if(imageUrl)URL.revokeObjectURL(imageUrl);});
</script></html>`;
}
