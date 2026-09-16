import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server } from 'node:http';
import { JevArena, demoChoice } from '../src/tools/jev-arena-model.ts';
import { ArenaPilot, type JevTransport } from '../src/tools/jev-pilot.ts';
import { JEV_LIMITS, jevRequest, parseJevDecision, parseObservation, type ArenaObservation, type JevDecision } from '../src/tools/jev-protocol.ts';
import { createJevHandler } from '../scripts/jev-proxy.ts';

const responseFor=(observation:ArenaObservation,choice='wait')=>({answers:{action:{type:'choice',choice,confidence:.8,probabilities:Object.fromEntries(observation.actions.map(a=>[a.id,a.id===choice?1:0]))}},usage:{input_tokens:100,output_tokens:10}});
const decisionFor=(observation:ArenaObservation,choice='wait'):JevDecision=>parseJevDecision(responseFor(observation,choice),observation.actions);
const flush=async()=>{await Promise.resolve();await Promise.resolve();};
test('Jev arena uses finite ordinary characters and a fixed isolated roster',()=>{
  const a=new JevArena('mixed'),b=new JevArena('mixed'),p=a.simulation.player;
  assert.deepEqual(a.observation(),b.observation());assert.equal(p.level,10);assert.ok(p.maxHp<1000);assert.ok(p.maxMana<1000);
  assert.equal(p.character.equipped.weapon?.recipe.profileId,'longsword');assert.equal(a.simulation.enemies.length,3);
  assert.ok(a.simulation.enemies.every(e=>e.level===10));assert.equal(a.world.getEnemyCamps,undefined);assert.equal(a.world.getContainers,undefined);
  assert.equal(a.world.blocked(1000,1000,9),true);assert.equal(a.simulation.groundItems.length,0);
});
test('observation filters dead, hidden and occluded enemies and private simulation fields',()=>{
  const arena=new JevArena('mixed');
  arena.simulation.enemies[0].hp=0;arena.simulation.enemies[1].x=9999;
  arena.simulation.enemies[2].x=-500;arena.simulation.enemies[2].y=0;
  const o=arena.observation();assert.equal(o.enemies.length,0);assert.ok(!o.actions.some(a=>/^(attack|bash|cleave):/.test(a.id)));
  assert.doesNotMatch(JSON.stringify(o),/lootSeed|character|allocatedNodes|randomState/);
});
test('single action pulses use the real combat path and do not hold attacks or skills',()=>{
  for(const action of ['attack','skill:0','skill:1']){
    const arena=new JevArena(),sim=arena.simulation,e=sim.enemies[0];
    e.x=sim.player.x+30;e.y=sim.player.y;e.prevX=e.x;e.stagger=100;e.hp=e.maxHp=10000;
    const mana=sim.player.mana;assert.equal(arena.accept(`${action}:${e.id}`,0),null);
    let swings=0;
    for(let tick=0;tick<180;tick++)swings+=arena.step().filter(e=>e.type==='swing'||e.type==='cast').length;
    assert.equal(swings,1,action);assert.ok(e.hp<10000,action);assert.equal(arena.acting,false);
    if(action!=='attack')assert.ok(sim.player.mana<mana,action);
  }
});
test('model reach includes the enemy body and those edge-of-reach attacks actually hit in every direction',()=>{
  for(const [dx,dy] of [[60,0],[-60,0],[0,60],[0,-60]]){
    const arena=new JevArena(),p=arena.simulation.player,e=arena.simulation.enemies[0];
    e.x=p.x+dx;e.y=p.y+dy;e.prevX=e.x;e.prevY=e.y;e.stagger=100;e.hp=e.maxHp=10000;
    const o=arena.observation();assert.ok(o.enemies[0].distance>o.player.basicRange);
    assert.equal(o.enemies[0].radius,e.radius);assert.equal(o.enemies[0].inBasicRange,true);
    assert.equal(o.actions.some(a=>a.id===`attack:${e.id}`),true);assert.deepEqual(parseObservation(o),o);
    assert.equal(arena.accept(`attack:${e.id}`,0),null);
    for(let i=0;i<72;i++)arena.step();assert.ok(e.hp<10000,`${dx}, ${dy} must hit`);
  }
});
test('reach flags and attack eligibility agree at the exact boundary and during recovery',()=>{
  const arena=new JevArena(),p=arena.simulation.player,e=arena.simulation.enemies[0];
  const range=arena.observation().player.basicRange;e.y=p.y;e.x=p.x+range+e.radius;
  assert.equal(arena.observation().enemies[0].inBasicRange,true);
  e.x+=.001;let o=arena.observation();assert.equal(o.enemies[0].inBasicRange,false);assert.ok(!o.actions.some(a=>a.id.startsWith('attack:')));
  e.x=p.x+30;e.stagger=100;assert.equal(arena.accept(`attack:${e.id}`,0),null);arena.step();o=arena.observation();
  assert.equal(o.player.busy,true);assert.equal(o.enemies[0].inBasicRange,true);assert.ok(!o.actions.some(a=>a.id.startsWith('attack:')));
  assert.throws(()=>parseObservation({...o,enemies:o.enemies.map(e=>({...e,inBasicRange:'true'}))}));
  assert.throws(()=>parseObservation({...o,enemies:o.enemies.map(e=>({...e,radius:NaN}))}));
});
test('potion and dodge spend exactly one charge, unavailable and stale actions are rejected',()=>{
  const arena=new JevArena(),p=arena.simulation.player;
  assert.ok(!arena.observation().actions.some(a=>a.id==='potion'));
  p.hp/=2;const flasks=p.flasks;assert.equal(arena.accept('potion',0),null);
  arena.step();assert.equal(p.flasks,flasks-1);assert.ok(p.hp>p.maxHp/2);
  for(let i=0;i<72;i++)arena.step();assert.equal(p.flasks,flasks-1);
  const charges=p.dodgeCharges;assert.equal(arena.accept('dodge:1',arena.simulation.time),null);arena.step();assert.equal(p.dodgeCharges,charges-1);assert.equal(arena.observation().memory.focusTargetId,null,'direction numbers must not select an enemy');
  assert.match(arena.accept('attack:999',arena.simulation.time)!,/no longer/);
  assert.match(arena.accept('wait',-10)!,/expired/);
  assert.match(arena.accept('wait',999)!,/expired/);
});
test('movement respects dungeon boundaries and controller stop clears buffered input',()=>{
  const arena=new JevArena(),p=arena.simulation.player;
  p.x=-290;p.prevX=p.x;assert.equal(arena.accept('dodge:4',0),null);
  for(let i=0;i<72;i++)arena.step();assert.equal(arena.world.blocked(p.x,p.y,p.radius),false);
  arena.clearAction();const x=p.x;for(let i=0;i<12;i++)arena.step();assert.ok(Math.abs(p.x-x)<1);
  const end=new JevArena();end.simulation.time=JEV_LIMITS.duration;const time=end.simulation.time;assert.equal(end.outcome,'time limit');end.step();assert.equal(end.simulation.time,time);
});
test('wire protocol removes extra data and rejects malformed observations and choices',()=>{
  const o=new JevArena().observation(),input={...o,privateSave:'must-not-forward',player:{...o.player,secret:'no'}};
  assert.deepEqual(parseObservation(input),o);
  assert.equal(jevRequest(o).model,'jev-latest');assert.deepEqual(Object.keys(jevRequest(o).questions.action.criteria),o.actions.map(a=>a.id));
  assert.throws(()=>parseObservation({...o,actions:[...o.actions,o.actions[0]]}));
  assert.throws(()=>parseObservation({...o,player:{...o.player,hp:Infinity}}));
  assert.throws(()=>parseObservation({...o,actions:[{id:'arbitrary_code',description:'no'}]}));
  assert.throws(()=>parseJevDecision(responseFor(o,'not-an-action'),o.actions));
  const malformed=responseFor(o);malformed.answers.action.probabilities.wait=NaN;assert.throws(()=>parseJevDecision(malformed,o.actions));
  assert.equal(parseJevDecision(responseFor(o),o.actions).inputTokens,100);
});
test('real-time pilot renews intent while moving, serializes requests and expires control without a reply',async()=>{
  const arena=new JevArena('archer');arena.simulation.enemies[0].stagger=100;let time=0,resolve!:(d:JevDecision)=>void;
  const transport:JevTransport=()=>new Promise(r=>{resolve=r;});
  const pilot=new ArenaPilot(arena,{provider:'jev'},transport,()=>time);
  pilot.start();pilot.tick(.05);const o=pilot.lastObservation!;assert.equal(pilot.requests,1);
  resolve(decisionFor(o,`engage:${o.enemies[0].id}`));await flush();
  for(let i=0;i<10;i++){time+=50;pilot.tick(.05);}
  assert.equal(pilot.pending,true);assert.equal(pilot.requests,2);assert.ok(arena.simulation.player.y<-20);
  for(let i=0;i<50;i++){time+=50;pilot.tick(.05);}
  assert.equal(pilot.requests,2);assert.equal(arena.acting,false);assert.ok(arena.simulation.time>2);pilot.pause();
});
test('real-time pilot keeps combat moving and rejects an old response',async()=>{
  const arena=new JevArena();let time=0,resolve!:(d:JevDecision)=>void;
  const pilot=new ArenaPilot(arena,{provider:'jev'},()=>new Promise(r=>{resolve=r;}),()=>time);
  pilot.start();pilot.tick(.05);
  for(let i=0;i<45;i++){time+=50;pilot.tick(.05);}
  assert.ok(arena.simulation.time>2);assert.equal(pilot.requests,1);
  resolve(decisionFor(pilot.lastObservation!));await flush();assert.equal(pilot.records[0].accepted,false);assert.match(pilot.records[0].rejection!,/expired/);pilot.pause();
});
test('pause cancels pending requests; late replies cannot resurrect an action',async()=>{
  const arena=new JevArena();let resolve!:(d:JevDecision)=>void,signal!:AbortSignal;
  const pilot=new ArenaPilot(arena,{provider:'jev'},(_o,s)=>{signal=s;return new Promise(r=>{resolve=r;});},()=>0);
  pilot.start();pilot.tick(.01);const o=pilot.lastObservation!;pilot.pause('Reset');assert.equal(signal.aborted,true);
  resolve(decisionFor(o,`engage:${o.enemies[0].id}`));await flush();assert.equal(pilot.records.length,0);assert.equal(arena.acting,false);assert.equal(pilot.status,'Reset');
});
test('provider errors pause once and demo never calls the API or claims model confidence',async()=>{
  let calls=0;const fail:JevTransport=async()=>{calls++;throw new Error('Provider unavailable');};
  const pilot=new ArenaPilot(new JevArena(),{provider:'jev'},fail,()=>0);
  pilot.start();pilot.tick(.01);await flush();assert.equal(pilot.running,false);assert.equal(pilot.status,'Provider unavailable');pilot.tick(.05);assert.equal(calls,1);
  const demo=new ArenaPilot(new JevArena(),{provider:'demo'},fail,()=>0);
  demo.start();demo.tick(.01);assert.equal(calls,1);assert.equal(demo.records[0].confidence,null);assert.equal(demo.report().provider,'demo');assert.equal(demo.records[0].choice,demoChoice(demo.lastObservation!));
});

async function listen(server:Server){await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');return `http://127.0.0.1:${address.port}`;}
test('local proxy protects credentials, validates input and constrains the upstream request',async()=>{
  let calls=0,now=0,configured=true,captured:RequestInit|undefined;
  const o=new JevArena().observation();
  const handler=createJevHandler({getKey:()=>configured?'test-secret-never-in-response':'',now:()=>now,fetch:async(url,init)=>{calls++;assert.equal(url,'https://api.typesafe.ai/v1/systemone');captured=init;return new Response(JSON.stringify(responseFor(o)));}});
  const server=createServer((req,res)=>void handler(req,res)),url=await listen(server);
  const headers={'Origin':url,'Content-Type':'application/json','X-Evergrow-Jev':'arena'};
  try{
    assert.equal((await fetch(url)).status,403);
    assert.equal((await fetch(url,{method:'POST',headers:{...headers,Origin:'https://elsewhere.test'},body:JSON.stringify(o)})).status,403);
    const status=await fetch(url,{headers});assert.deepEqual(await status.json(),{configured:true,model:'jev-latest'});assert.equal(calls,0);
    assert.equal((await fetch(url,{method:'POST',headers,body:'{}'})).status,400);assert.equal(calls,0);
    const success=await fetch(url,{method:'POST',headers,body:JSON.stringify({...o,secret:'drop-me'})});assert.equal(success.status,200);
    assert.doesNotMatch(await success.text(),/test-secret/);assert.equal(calls,1);assert.match(JSON.stringify(captured?.headers),/test-secret-never-in-response/);
    assert.doesNotMatch(String(captured?.body),/drop-me/);assert.equal(captured?.redirect,'error');
    assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify(o)})).status,429);assert.equal(calls,1);
    now=1001;configured=false;const missing=await fetch(url,{method:'POST',headers,body:JSON.stringify(o)});assert.equal(missing.status,503);assert.equal(calls,1);
  }finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});
test('proxy does not reflect provider error bodies or exception secrets',async()=>{
  const o=new JevArena().observation();
  const handler=createJevHandler({getKey:()=> 'secret',fetch:async()=>new Response('private provider diagnostic',{status:401})});
  const server=createServer((req,res)=>void handler(req,res)),url=await listen(server);
  try{const response=await fetch(url,{method:'POST',headers:{Origin:url,'Content-Type':'application/json','X-Evergrow-Jev':'arena'},body:JSON.stringify(o)});assert.equal(response.status,502);const text=await response.text();assert.match(text,/rejected the API key/);assert.doesNotMatch(text,/private provider|secret/);}
  finally{await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}
});

test('target pursuit works vertically, horizontally and diagonally, without overshooting melee range',()=>{
  for(const [dx,dy] of [[150,0],[-150,0],[0,150],[0,-150],[110,110],[-110,-110]]){
    const arena=new JevArena(),p=arena.simulation.player,e=arena.simulation.enemies[0];
    e.x=p.x+dx;e.y=p.y+dy;e.prevX=e.x;e.prevY=e.y;e.stagger=100;e.hp=e.maxHp=10000;
    const start={x:p.x,y:p.y},initial=Math.hypot(dx,dy);
    assert.equal(arena.accept(`engage:${e.id}`,0),null);
    for(let i=0;i<120;i++)arena.step();
    const progress=(p.x-start.x)*dx+(p.y-start.y)*dy;
    assert.ok(progress>initial*40,`${dx},${dy}: pursue target, not sideways`);
    assert.ok(Math.hypot(e.x-p.x,e.y-p.y)<=arena.observation().player.basicRange+e.radius+5);
    assert.ok(e.hp<10000,`${dx},${dy}: attack after closing`);
  }
});
test('bow and wand basics pay their real costs and hit northward ranged targets without melee pursuit',()=>{
  for(const loadout of ['bow','wand'] as const){
    const arena=new JevArena('archer',loadout),p=arena.simulation.player,e=arena.simulation.enemies[0];
    e.stagger=100;e.hp=e.maxHp=10000;const o=arena.observation(),mana=p.mana;
    assert.equal(o.player.combatStyle,'ranged');assert.ok(o.player.basicRange>300);
    assert.equal(o.actions.some(a=>a.id==='skill:0:1'),true);assert.ok(!o.actions.some(a=>a.description.includes('Cleave')));
    assert.equal(arena.accept(`attack:${e.id}`,0),null);arena.step();
    assert.ok(Math.abs(p.mana-(mana-o.player.basicMana))<.02);
    for(let i=0;i<100;i++)arena.step();
    assert.ok(e.hp<10000,loadout);assert.ok(Math.abs(p.y)<1);assert.equal(parseObservation(arena.observation()).player.combatStyle,'ranged');
  }
});
test('ranged engage opens space against a nearby target while melee engage holds a reachable target',()=>{
  for(const loadout of ['sword','bow','wand'] as const){
    const a=new JevArena('duel',loadout),p=a.simulation.player,e=a.simulation.enemies[0];e.x=p.x+35;e.y=p.y;e.stagger=100;e.hp=e.maxHp=10000;
    const x=p.x;assert.equal(a.accept(`engage:${e.id}`,0),null);
    for(let i=0;i<30;i++)a.step();
    if(loadout==='sword')assert.ok(Math.abs(p.x-x)<1);else assert.ok(p.x<x-10,loadout);
  }
});
test('wand cannot offer unaffordable basic or skill presses',()=>{
  const a=new JevArena('archer','wand');a.simulation.player.mana=0;
  const o=a.observation();assert.ok(!o.actions.some(a=>a.id.startsWith('attack:')||a.id.startsWith('skill:')));
  assert.equal(a.accept('attack:1',0),'Action is no longer available.');
});
test('routing detours around a real dungeon wall with body clearance',()=>{
  const a=new JevArena('routing'),p=a.simulation.player;p.x=-100;p.y=0;
  const target={x:100,y:0};assert.equal(a.world.blocked(0,0,p.radius),true);
  let maxY=p.y;
  for(let i=0;i<400&&Math.hypot(p.x-target.x,p.y-target.y)>5;i++){
    const route=a.tactics.route(p,target);assert.ok(route,'detour exists');
    const v=a.tactics.steer(p,route.target),point=a.world.move(p.x,p.y,v.x*5,v.y*5,p.radius);
    assert.equal(a.world.blocked(point.x,point.y,p.radius),false);p.x=point.x;p.y=point.y;maxY=Math.max(maxY,p.y);
  }
  assert.ok(Math.hypot(p.x-target.x,p.y-target.y)<6);assert.ok(maxY>60,'route passes below wall');
});
test('target memory records only last-seen positions, expires, and never enables attacks through walls',()=>{
  const a=new JevArena('mixed'),e=a.simulation.enemies[0];a.observation();const oldX=e.x;
  a.viewport={x:-480,y:-320,width:450,height:640};e.x=250;
  const o=a.observation(),known=o.enemies.find(v=>v.id===e.id)!;
  assert.equal(known.visible,false);assert.equal(known.x,oldX);assert.ok(!o.actions.some(v=>v.id===`attack:${e.id}`||v.id===`engage:${e.id}`));
  assert.ok(o.actions.some(v=>v.id===`investigate:${e.id}`));
  a.simulation.time=5.1;assert.equal(a.observation().enemies.length,0);assert.ok(a.observation().actions.some(v=>v.id.startsWith('search:')));
});
test('perception includes projectile approach and a local dodge avoids the incoming shot using normal charges',()=>{
  const a=new JevArena(),p=a.simulation.player,e=a.simulation.enemies[0];e.stagger=100;
  a.simulation.projectiles.push({id:900,sourceLevel:10,x:p.x,y:p.y-45,prevX:p.x,prevY:p.y-45,vx:0,vy:235,angle:Math.PI/2,radius:3,damage:20,life:2,maxLife:2,owner:'enemy',hitIds:new Set()});
  const o=a.observation();assert.ok(o.threats.some(t=>t.source==='shot:900'&&t.seconds<.22));
  const safe=o.escapes.filter(v=>v.risk===0);assert.ok(safe.length);
  const charges=p.dodgeCharges;assert.equal(a.accept(`engage:${e.id}`,0),null);a.step();assert.equal(p.dodgeCharges,charges-1);assert.equal(a.reflexes,1);
  for(let i=0;i<45;i++)a.step();assert.equal(a.damageTaken,0);assert.equal(a.world.blocked(p.x,p.y,p.radius),false);
});
test('projectiles moving away and interrupted telegraphs do not trigger reflexes',()=>{
  const a=new JevArena(),p=a.simulation.player,e=a.simulation.enemies[0];e.x=p.x+35;e.state='windup';e.stateTime=0;e.stateDuration=.15;e.stagger=100;
  const shot={id:900,sourceLevel:10,x:p.x,y:p.y-60,prevX:p.x,prevY:p.y-60,vx:0,vy:-235,angle:-Math.PI/2,radius:3,damage:20,life:2,maxLife:2,owner:'enemy' as const,hitIds:new Set<number>()};
  a.simulation.projectiles.push(shot);assert.equal(a.observation().threats.length,0);
  assert.equal(a.accept(`engage:${e.id}`,0),null);a.step();assert.equal(a.reflexes,0);
});
test('melee windup risk uses the attack arc rather than fleeing every adjacent enemy',()=>{
  const a=new JevArena(),p=a.simulation.player,e=a.simulation.enemies[0];e.x=p.x+24;e.y=p.y;e.state='windup';e.stateDuration=.15;e.stateTime=0;e.attackAngle=Math.PI;
  assert.ok(a.observation().threats.some(t=>t.kind==='melee'));
  e.attackAngle=0;assert.ok(!a.observation().threats.some(t=>t.kind==='melee'));
});
test('live target death stops the chosen intent and never silently switches to a different enemy',()=>{
  const a=new JevArena('mixed'),e=a.simulation.enemies[0];assert.equal(a.accept(`engage:${e.id}`,0),null);e.hp=0;
  a.step();assert.equal(a.acting,false);assert.match(a.execution,/Target lost/);assert.equal(a.simulation.player.attack,null);
});
test('decision history stays bounded without imposing a request budget and totals survive truncation',async()=>{
  let time=0;const a=new JevArena(),pilot=new ArenaPilot(a,{provider:'jev'},async o=>decisionFor(o),()=>time);pilot.start();
  for(let i=0;i<JEV_LIMITS.maxRecords+5;i++){pilot.tick(0);await flush();time+=JEV_LIMITS.intervalMs+1;}
  assert.equal(pilot.requests,JEV_LIMITS.maxRecords+5);assert.equal(pilot.records.length,JEV_LIMITS.maxRecords);assert.equal(pilot.running,true);
  assert.equal(pilot.inputTokens,pilot.requests*100);assert.equal(pilot.outputTokens,pilot.requests*10);assert.equal(pilot.report().retainedDecisions,JEV_LIMITS.maxRecords);pilot.pause();
});

test('melee pursuit keeps closing during windup and hits an archer retreating at normal speed',()=>{
  for(const [dx,dy] of [[1,0],[0,-1],[-1,0],[0,1]]){
    const a=new JevArena('archer'),p=a.simulation.player,e=a.simulation.enemies[0];
    e.x=p.x+dx*60;e.y=p.y+dy*60;e.prevX=e.x;e.prevY=e.y;e.stagger=100;e.hp=e.maxHp=10000;
    assert.equal(a.accept(`engage:${e.id}`,0),null);
    for(let tick=0;tick<72;tick++){
      // Controlled moving target: normal archer speed, no unrelated AI or attack choices.
      e.x+=dx*96/120;e.y+=dy*96/120;e.prevX=e.x;e.prevY=e.y;a.step();
    }
    assert.ok(e.hp<10000,`${dx},${dy}: first swing must connect while the target retreats`);
    assert.ok(Math.hypot(p.x-e.x,p.y-e.y)<60,'do not hover at the maximum contact boundary');
  }
});
test('wall-hugging archers have reachable attack positions and receive sustained melee hits',()=>{
  for(const [x,y] of [[-100,-225],[-315,-180],[300,200]]){
    const a=new JevArena('archer'),p=a.simulation.player,e=a.simulation.enemies[0];
    e.x=x;e.y=y;e.prevX=x;e.prevY=y;e.stagger=100;e.hp=e.maxHp=10000;p.x=x*.65;p.y=y*.65;p.prevX=p.x;p.prevY=p.y;
    assert.equal(a.world.blocked(e.x,e.y,e.radius),false,'fixture is a legal wall-adjacent enemy');
    const route=a.tactics.approach(p,e);assert.ok(route);
    assert.equal(a.world.blocked(route.target.x,route.target.y,p.radius),false,'route to a body-safe attack position');
    for(let tick=0;tick<240;tick++){
      if(tick%48===0)assert.equal(a.accept(`engage:${e.id}`,a.simulation.time),null);
      a.step();assert.equal(a.world.blocked(p.x,p.y,p.radius),false,'player never walks into the wall');
    }
    assert.ok(a.damageDealt>=100,`${x},${y}: close and land repeated hits`);
  }
});
test('combat approach navigates around the wall to a visible firing or melee position',()=>{
  const a=new JevArena('routing'),p=a.simulation.player;p.x=-100;p.y=0;const target={x:100,y:0,radius:10};
  let maxY=p.y;
  for(let i=0;i<400&&Math.hypot(p.x-target.x,p.y-target.y)>a.tactics.attackDistance(p,target)+2;i++){
    const route=a.tactics.approach(p,target);assert.ok(route,'attack-position route exists');
    const v=a.tactics.steer(p,route.target),point=a.world.move(p.x,p.y,v.x*4,v.y*4,p.radius);
    assert.equal(a.world.blocked(point.x,point.y,p.radius),false);p.x=point.x;p.y=point.y;maxY=Math.max(maxY,p.y);
  }
  assert.ok(maxY>60);assert.ok(Math.hypot(p.x-target.x,p.y-target.y)<=a.tactics.attackDistance(p,target)+2);
});
