import './jev-arena.css';
import { toolPage, downloadJSON } from './common.ts';
import { JevArena, ARENA_LOADOUTS, type ArenaScenario, type ArenaLoadout } from './jev-arena-model.ts';
import { ArenaPilot, type PilotOptions, type JevTransport } from './jev-pilot.ts';
import { JEV_LIMITS, parseJevDecision } from './jev-protocol.ts';
import { DungeonWorld } from '../dungeon-world.ts';
import { Renderer } from '../renderer.ts';
import { PostFX } from '../postfx.ts';
import { escapeUI } from '../ui-components.ts';

const root=await toolPage('Jev arena','A real-time combat bot: Jev chooses targets and tactics; the controller routes, aims and evades between replies. Disposable characters, normal combat rules.');
root.insertAdjacentHTML('beforeend',`
  <div class="tool-toolbar jev-controls">
    <label>Controller<select id="provider"><option value="jev">Jev · live API</option><option value="demo">Offline control demo · no AI</option></select></label>
    <label>Encounter<select id="scenario"><option value="duel">One goblin</option><option value="mixed" selected>Mixed group · three enemies</option><option value="archer">Archer directly above</option><option value="routing">Archer beyond a wall</option></select></label>
    <label>Loadout<select id="loadout"><option value="sword">Sword + shield</option><option value="bow">Shortbow</option><option value="wand">Wand + shield</option></select></label>
    <button id="start" disabled>Start</button><button id="pause" disabled>Pause</button><button id="reset">Reset arena</button><button id="export">Export run JSON</button>
  </div>
  <p id="timing-note" class="jev-note"></p>
  <div class="jev-layout">
    <section class="tool-panel jev-stage"><div class="jev-stage-heading"><strong id="controller-label">Jev · live API</strong><span id="loadout-label"></span></div>
      <canvas id="arena" width="960" height="640" aria-label="Disposable Jev combat arena"></canvas>
      <div class="jev-vitals"><label>Life <span id="life-text"></span><progress id="life" max="1" value="1"></progress></label><label>Mana <span id="mana-text"></span><progress id="mana" max="1" value="1"></progress></label></div>
      <p id="combat-readout"></p><p id="motor-readout"></p><p id="status" role="status" aria-live="polite">Ready</p>
    </section>
    <aside class="tool-panel jev-inspector"><h2>Decision desk</h2><div id="metrics" class="jev-metrics"></div>
      <p id="decision">No decision yet. Start when ready.</p><p id="melee-readout"></p><pre id="target-readout"></pre>
      <h3>Latest choices</h3><div id="choices" class="jev-choices">Probabilities appear after a live response.</div>
      <h3>Recent decisions</h3><ol id="history" class="jev-history"></ol>
    </aside>
  </div>
  <details id="setup" open class="tool-panel"><summary>Local API setup</summary>
    <p id="connection" role="status">Checking local configuration…</p>
    <p>Put your Typesafe API key in <code>game/.env.local</code> as <code>TYPESAFE_API_KEY=your-key</code>. This ignored file is read by the local server. Never use a <code>VITE_</code> prefix. The key is not sent to the browser or included in exports.</p>
    <button id="check">Check connection</button>
    <p>Start sends only this disposable arena’s observations to Typesafe. No requests are made on page load beyond checking whether a key is configured. Jev reassesses continuously with one request in flight and a 0.2-second spacing after each response. There is no request budget. Token totals remain visible; pause whenever you want.</p>
  </details>
  <details class="tool-panel"><summary>What the controller can do</summary>
    <p>Jev chooses a target and a tactic: engage, kite, circle, investigate, search, evade, dodge, use an assigned skill, drink a potion, or hold. Engage routes toward the target and repeats normal basic attacks in weapon range. Bow and wand loadouts preserve ranged spacing and lead moving targets. Collision-checked reflexes dodge or sidestep imminent visible attacks during combat intents.</p>
    <p>Each level-10 fixture has five granted rank-one skills and common equipment. This is a combat study, not a legal atlas build. Enemies run normal AI. The wall encounter uses actual dungeon geometry. Only visible enemies, visible projectiles, and five-second last-seen memories reach Jev. The controller never learns an unseen enemy’s current position.</p>
    <p>Combat continues while Jev thinks. Fresh decisions renew short intents; control expires after two simulation seconds without renewal. Pause, tab hiding, errors and encounter completion stop the controller. Runs end at victory, defeat or five simulation minutes. Exports retain the latest 240 decisions plus cumulative usage totals. The offline demo is scripted, not Jev.</p>
  </details>
  <details class="tool-panel"><summary>Latest observation sent to the controller</summary><pre id="observation">No observation sent.</pre></details>
  <details class="tool-panel"><summary>Observed combat events</summary><pre id="events">No events yet.</pre></details>
`);
const get=<T extends HTMLElement>(id:string)=>root.querySelector<T>(`#${id}`)!;
const provider=get<HTMLSelectElement>('provider'),scenario=get<HTMLSelectElement>('scenario'),loadout=get<HTMLSelectElement>('loadout');
const canvas=get<HTMLCanvasElement>('arena'),renderer=new Renderer(),fx=new PostFX(canvas);
let world:DungeonWorld;
const motion=matchMedia('(prefers-reduced-motion: reduce)'),listeners=new AbortController();
let configured=false,disposed=false,frame=0,last=0,lastDraw=0,lastUI=0,lastRecordCount=-1;
const transport:JevTransport=async(observation,signal)=>{
  const timeout=AbortSignal.timeout(JEV_LIMITS.timeoutMs+1000);
  const response=await fetch('/__jev-arena',{method:'POST',headers:{'Content-Type':'application/json','X-Evergrow-Jev':'arena'},body:JSON.stringify(observation),signal:AbortSignal.any([signal,timeout])});
  const data=await response.json();
  if(!response.ok)throw new Error(typeof data.error==='string'?data.error:'Jev request failed.');
  // Recheck the response contract before it can reach an input adapter.
  return parseJevDecision({answers:{action:{type:'choice',...data}},usage:{input_tokens:data.inputTokens,output_tokens:data.outputTokens}},observation.actions);
};
let pilot:ArenaPilot;
function reset(){
  pilot?.pause();
  const arena=new JevArena(scenario.value as ArenaScenario,loadout.value as ArenaLoadout);
  world?.dispose();world=new DungeonWorld(arena.floor,{id:'jev-study',name:'Jev study',seed:7319,level:10,biome:'deadwood',theme:'astral',x:0,y:0});
  pilot=new ArenaPilot(arena,{provider:provider.value as PilotOptions['provider']},transport,()=>performance.now());
  get('loadout-label').textContent=`Level 10 · ${ARENA_LOADOUTS[arena.loadout].name}`;
  renderer.reset();renderer.resize(960,640);renderer.navigationVisible=false;renderer.snapTo(pilot.arena.simulation.player);
  lastRecordCount=-1;get('controller-label').textContent=provider.selectedOptions[0].textContent;
  get('timing-note').textContent='Real time · continuous decisions · target-based routing and local evasive reflexes · no request budget';
  draw(0);updateUI();
}
function updateUI(){
  if(disposed)return;
  const arena=pilot.arena,p=arena.simulation.player,records=pilot.records,latest=records.at(-1);
  get<HTMLButtonElement>('start').disabled=pilot.running||arena.outcome!=='fighting'||provider.value==='jev'&&!configured;
  get('start').textContent=arena.simulation.time>0?'Resume':'Start';get<HTMLButtonElement>('pause').disabled=!pilot.running;
  get('life-text').textContent=`${Math.ceil(p.hp)} / ${p.maxHp}`;get<HTMLProgressElement>('life').value=p.hp/p.maxHp;
  get('mana-text').textContent=`${Math.floor(p.mana)} / ${p.maxMana}`;get<HTMLProgressElement>('mana').value=p.mana/p.maxMana;
  get('combat-readout').textContent=`${arena.simulation.time.toFixed(1)} / ${JEV_LIMITS.duration}s · ${arena.simulation.enemies.filter(e=>e.hp>0).length} enemies · ${p.flasks} potions · ${p.dodgeCharges} dodges · ${Math.round(arena.damageDealt)} damage dealt · ${Math.round(arena.damageTaken)} life lost`;
  get('status').textContent=pilot.status;
  const latency=pilot.responses?Math.round(pilot.latencyTotal/pilot.responses):0;
  const observation=pilot.lastObservation;
  get('melee-readout').textContent=observation?`Last observation: ${observation.enemies.filter(e=>e.inBasicRange).length} in weapon reach · ${observation.player.busy?'action still executing':observation.actions.some(a=>a.id.startsWith('attack:'))?'basic attack available':'no basic attack available'}`:'';
  const waypoint=arena.currentWaypoint;
  get('motor-readout').textContent=`${arena.execution} · ${arena.reflexes} evasive reflexes${waypoint?` · waypoint (${Math.round(waypoint.x)}, ${Math.round(waypoint.y)})`:''}`;
  get('target-readout').textContent=observation?observation.enemies.map(e=>`${e.id} ${e.name} · ${e.role}\n${e.visible?e.bearing:'Last seen'} · ${Math.round(e.distance)} away · ${e.inBasicRange?'in reach':'out of reach'}${e.route?`\nRoute ${Math.round(e.route.distance)} · priority ${e.priority}`:'\nNo route found'}`).join('\n\n'):'Targets appear after the first observation.';
  get('metrics').textContent=`${pilot.requests} decisions requested${pilot.pending?' · Thinking':''}\n${pilot.accepted} accepted · ${pilot.rejected} reconsidered\n${latency} ms average response\n${pilot.inputTokens} input / ${pilot.outputTokens} output tokens (received responses)`;
  if(lastRecordCount!==pilot.responses){
    lastRecordCount=pilot.responses;
    get('decision').textContent=latest?`${latest.choice} · ${latest.confidence===null?'Scripted demo':`${Math.round(latest.confidence*100)}% model confidence`} · ${latest.latencyMs} ms${latest.rejection?` · ${latest.rejection}`:''}`:'No decision yet. Start when ready.';
    get('choices').innerHTML=latest&&Object.keys(latest.probabilities).length?Object.entries(latest.probabilities).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([id,p])=>`<div><span>${escapeUI(id)}</span><meter min="0" max="1" value="${p}"></meter><span>${Math.round(p*100)}%</span></div>`).join(''):'No live probabilities. Model confidence describes its distribution, not a guaranteed chance of success.';
    get('history').replaceChildren(...records.slice(-8).reverse().map(r=>{const li=document.createElement('li');li.textContent=`${r.observation.time.toFixed(1)}s · ${r.choice} · ${r.accepted?'accepted':r.rejection}`;return li;}));
  }
  get('observation').textContent=pilot.lastObservation?JSON.stringify(pilot.lastObservation,null,2):'No observation sent.';
  get('events').textContent=arena.events.slice(-30).map(e=>`${e.time.toFixed(2)}s · ${e.type}`).join('\n')||'No events yet.';
}
function draw(dt:number){
  renderer.render(pilot.arena.simulation,world,dt,{phase:'playing',reducedMotion:motion.matches});
  pilot.arena.viewport=renderer.combatViewport;
  fx.render(renderer.canvas,pilot.arena.simulation.time);
}
function tick(now:number){
  frame=0;if(disposed||document.hidden)return;
  const dt=last?Math.min(.05,(now-last)/1000):0;last=now;
  const before=pilot.arena.simulation.time;
  const events=pilot.tick(dt);renderer.handleEvents(events,motion.matches);
  if(now-lastDraw>=1000/30&&pilot.arena.simulation.time!==before){draw(Math.min(.05,(now-lastDraw)/1000));lastDraw=now;}
  if(now-lastUI>=200){updateUI();lastUI=now;}
  if(pilot.running)frame=requestAnimationFrame(tick);else{draw(0);updateUI();}
}
function run(){if(!frame){last=0;frame=requestAnimationFrame(tick);}}
async function check(){
  const button=get<HTMLButtonElement>('check');button.disabled=true;
  try{
    const response=await fetch('/__jev-arena',{headers:{'X-Evergrow-Jev':'arena'},signal:AbortSignal.timeout(5000)});
    const data=await response.json();configured=response.ok&&data.configured===true;
    if(!disposed){get('connection').textContent=configured?'Key configured locally. The first live request happens when you press Start.':'No API key configured. Add it below, or select Offline control demo to inspect the arena.';get<HTMLDetailsElement>('setup').open=!configured;}
  }catch{configured=false;if(!disposed)get('connection').textContent='Local API route unavailable. Start this page through the normal npm run dev server.';}
  finally{if(!disposed){button.disabled=false;updateUI();}}
}
get('start').addEventListener('click',()=>{pilot.start();updateUI();run();},{signal:listeners.signal});
get('pause').addEventListener('click',()=>{pilot.pause();updateUI();},{signal:listeners.signal});
get('reset').addEventListener('click',reset,{signal:listeners.signal});
for(const control of [provider,scenario,loadout])control.addEventListener('change',reset,{signal:listeners.signal});
get('check').addEventListener('click',()=>void check(),{signal:listeners.signal});
get('export').addEventListener('click',()=>downloadJSON(`evergrow-${pilot.options.provider}-arena.json`,pilot.report()),{signal:listeners.signal});
document.addEventListener('visibilitychange',()=>{if(document.hidden){pilot.pause('Paused because the tab was hidden');cancelAnimationFrame(frame);frame=0;last=0;}else updateUI();},{signal:listeners.signal});
function dispose(){if(disposed)return;disposed=true;pilot.pause();listeners.abort();cancelAnimationFrame(frame);renderer.reset();fx.dispose();world.dispose();}
window.addEventListener('pagehide',dispose,{once:true});if(import.meta.hot)import.meta.hot.dispose(dispose);
reset();void check();
