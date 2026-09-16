import { COMBAT_TIMING, ENEMY_DEFINITIONS, PLAYER_ABILITIES, enemyAttackDefinition } from '../combat-content.ts';
import { hasLineOfSight } from '../combat-geometry.ts';
import { enemyInCombatViewport, type CombatViewport } from '../combat-visibility.ts';
import { DungeonGeometry, type DungeonFloor } from '../dungeon.ts';
import { deriveAttackStats } from '../equipment.ts';
import { generateItem } from '../items.ts';
import { refreshCharacter } from '../character.ts';
import { Simulation } from '../simulation.ts';
import { resolveSkill } from '../skill-progression.ts';
import { SKILL_DEFINITIONS, skillWeapon } from '../skill-content.ts';
import { unlockedSkills } from '../skill-tree.ts';
import type { CombatEvent, Enemy, Input, WorldQuery } from '../model.ts';
import type { SkillId } from '../character-types.ts';
import { JEV_LIMITS, type ArenaAction, type ArenaEnemy, type ArenaObservation } from './jev-protocol.ts';
import { ArenaTactics, ARENA_DIRECTIONS, bearing, busy, canDodge, directionVector, distance, weaponProfile, type Point } from './jev-tactics.ts';

export type ArenaScenario = 'duel'|'mixed'|'archer'|'routing';
export type ArenaLoadout = 'sword'|'bow'|'wand';
export const ARENA_LOADOUTS:Record<ArenaLoadout,{name:string;weapon:string;skills:SkillId[]}>={
  sword:{name:'Longsword + Iron Buckler',weapon:'longsword',skills:['cleave','shieldBash','bulwark','lunge','brace']},
  bow:{name:'Thorn Shortbow',weapon:'thorn-shortbow',skills:['volley','piercingShot','vaultingShot','smokeVeil','brace']},
  wand:{name:'Cinder Wand + Iron Buckler',weapon:'cinder-wand',skills:['fireball','frostLance','iceNova','runicWard','brace']},
};
export const ARENA_FLOOR:DungeonFloor=Object.freeze({seed:7319,theme:'astral',rooms:[{id:0,x:-320,y:-220,width:640,height:440,kind:'combat' as const}],edges:[],corridors:[],members:[],props:[],entry:{x:-280,y:190},exit:{x:-280,y:190},chests:[]});
const ROUTING_FLOOR:DungeonFloor=Object.freeze({...ARENA_FLOOR,rooms:[{...ARENA_FLOOR.rooms[0],outline:[{x:-320,y:-220},{x:-40,y:-220},{x:-40,y:50},{x:40,y:50},{x:40,y:-220},{x:320,y:-220},{x:320,y:220},{x:-320,y:220}]}]});
const searchPoints:Point[]=[{x:-240,y:-140},{x:240,y:-140},{x:240,y:140},{x:-240,y:140},{x:0,y:140}];
const round=(n:number)=>Math.round(n*100)/100;
const neutral=(p:Point & {angle:number}):Input=>({moveX:0,moveY:0,aimX:p.x+Math.cos(p.angle),aimY:p.y+Math.sin(p.angle),attack:false,dodge:false,heal:false,skillSlot:null});
const targetIdFor=(id:string):number|null=>{
  const [kind,value,target]=id.split(':');
  if(kind==='skill')return Number(target)||null;
  return ['engage','attack','kite','orbitLeft','orbitRight','investigate'].includes(kind)?Number(value):null;
};
interface Intent {id:string;remaining:number;pressed:boolean;start:Point;dealt:number;taken:number;startDistance:number;}

/** Jev selects bounded tactical intents. The motor layer uses normal input, never combat mutations. */
export class JevArena {
  readonly simulation:Simulation;
  readonly scenario:ArenaScenario;
  readonly loadout:ArenaLoadout;
  readonly world:WorldQuery;
  readonly floor:DungeonFloor;
  readonly tactics:ArenaTactics;
  viewport:CombatViewport={x:-480,y:-320,width:960,height:640};
  private action:Intent|null=null;
  private known=new Map<number,{enemy:Enemy;seen:number}>();
  private visited=new Set<number>();
  private waypoint:Point|null=null;
  private nextSteerAt=0;
  private movement:Point={x:0,y:0};
  private reflexUntil=0;
  private reflexDirection=0;
  private focusTargetId:number|null=null;
  private recent:ArenaObservation['memory']['recent']=[];
  execution='Ready';
  reflexes=0;
  damageTaken=0;
  damageDealt=0;
  readonly events:Array<{time:number;type:string}>=[];
  constructor(scenario:ArenaScenario='duel',loadout:ArenaLoadout='sword'){
    this.scenario=scenario;this.loadout=loadout;this.floor=scenario==='routing'?ROUTING_FLOOR:ARENA_FLOOR;
    const geometry=new DungeonGeometry(this.floor);
    this.world={seed:7319,dungeonLevel:10,dungeonBiome:'deadwood',dungeonTheme:'astral',blocked:(x,y,r)=>geometry.blocked(x,y,r),move:(x,y,dx,dy,r)=>geometry.move(x,y,dx,dy,r)};
    this.tactics=new ArenaTactics(this.world);
    const sim=this.simulation=new Simulation(this.world,{spawn:false,seed:7319,startX:-100,startY:scenario==='routing'?110:0});sim.dungeonFloor=this.floor;
    const p=sim.player,kit=ARENA_LOADOUTS[loadout];p.level=10;
    p.character.attributes[loadout==='sword'?'strength':loadout==='bow'?'dexterity':'intelligence']+=27;p.character.attributes.vitality+=18;
    p.character.allocatedNodes=['origin',...kit.skills.map(id=>`skill:${id}`)];p.character.skillSlots=[...kit.skills];
    for(const id of kit.skills)p.character.skillRanks[id]=1;
    p.character.equipped.weapon=generateItem(1024,10,'weapon',kit.weapon,'common');
    p.character.equipped.offhand=loadout==='bow'?null:generateItem(2048,10,'shield','iron-buckler','common');
    refreshCharacter(p);p.hp=p.maxHp;p.mana=p.maxMana;
    if(scenario==='archer')sim.spawnEnemy('archer',-100,-170);
    else if(scenario==='routing')sim.spawnEnemy('archer',170,-100);
    else {sim.spawnEnemy('goblin',55,0);if(scenario==='mixed'){sim.spawnEnemy('stalker',100,85);sim.spawnEnemy('archer',160,-95);}}
    sim.setCombatViewport(this.viewport);sim.drainEvents();
  }
  get outcome():'fighting'|'won'|'defeated'|'time limit'{
    if(this.simulation.player.dead)return 'defeated';
    if(this.simulation.enemies.every(e=>e.hp<=0))return 'won';
    return this.simulation.time>=JEV_LIMITS.duration?'time limit':'fighting';
  }
  get acting(){return this.action!==null;}
  get currentWaypoint(){return this.waypoint;}
  clearAction(){this.action=null;this.movement={x:0,y:0};this.waypoint=null;this.reflexUntil=0;this.simulation.clearInput();}
  private visible(e:Enemy){const p=this.simulation.player;return e.hp>0&&enemyInCombatViewport(e,this.viewport)&&hasLineOfSight(this.world,p.x,p.y,e.x,e.y);}
  private visibleEnemies(){return this.simulation.enemies.filter(e=>this.visible(e));}
  private visibleShots(){const p=this.simulation.player,v=this.viewport;return this.simulation.projectiles.filter(s=>s.owner==='enemy'&&s.life>0&&s.x>=v.x&&s.x<=v.x+v.width&&s.y>=v.y&&s.y<=v.y+v.height&&hasLineOfSight(this.world,p.x,p.y,s.x,s.y)).slice(0,16);}
  private remember(){
    const sim=this.simulation,p=sim.player;
    for(const e of this.visibleEnemies())this.known.set(e.id,{enemy:{...e},seen:sim.time});
    for(const [id,k] of this.known){
      const observedDead=sim.enemies.some(e=>e.id===id&&e.hp<=0&&enemyInCombatViewport(e,this.viewport)&&hasLineOfSight(this.world,p.x,p.y,e.x,e.y));
      if(sim.time-k.seen>5||observedDead)this.known.delete(id);
    }
    searchPoints.forEach((q,i)=>{if(distance(p,q)<40)this.visited.add(i);});
    if(this.visited.size===searchPoints.length)this.visited.clear();
  }
  private skillActions(enemies:readonly Enemy[]):ArenaAction[]{
    const p=this.simulation.player;if(busy(p))return [];
    const unlocked=unlockedSkills(p.character.allocatedNodes),out:ArenaAction[]=[];
    p.character.skillSlots.forEach((id,slot)=>{
      if(!id||!unlocked.includes(id))return;
      const weapon=skillWeapon(id,p.equipment);if(!weapon)return;
      const s=resolveSkill(id,p.derived,p.character),r=s.recipe,d=SKILL_DEFINITIONS[id];
      if(s.mana>p.mana||(p.skillCooldowns[id]??0)>0||r.kind==='aura')return;
      if(r.kind==='guard'&&p.guardTime>0||r.kind==='ward'&&(p.skillEffects?.ward?.remaining??0)>0||r.kind==='stance'&&(p.skillEffects?.brace?.remaining??0)>0)return;
      const base=deriveAttackStats(p.stats,weapon).range;
      const range=r.kind==='sweep'||r.kind==='backstab'?base*r.reachMultiplier:r.kind==='cone'||r.kind==='radial'?('targetRange' in r?r.targetRange??r.radius:r.radius):r.kind==='dash'?r.duration*r.speed:base;
      const self=r.kind==='guard'||r.kind==='ward'||r.kind==='stance';
      const targets=self?[null]:enemies.filter(e=>distance(p,e)<=range+e.radius);
      for(const e of targets)out.push({id:`skill:${slot}:${e?.id??0}`,description:`${d.name}${e?` on ${e.id} (in reach)`:' on self'}: ${d.description} Costs ${s.mana} mana, ${s.cooldown}s cooldown. ${s.damageMultiplier}x damage.`});
    });return out;
  }
  observation():ArenaObservation {
    this.remember();const sim=this.simulation,p=sim.player,w=weaponProfile(p),visible=this.visibleEnemies(),shots=this.visibleShots();
    const enemies:ArenaEnemy[]=[...this.known.values()].map(k=>{
      const e=k.enemy,isVisible=visible.some(v=>v.id===e.id),d=distance(p,e),route=this.tactics.approach(p,e),definition=enemyAttackDefinition(e);
      return {id:e.id,name:ENEMY_DEFINITIONS[e.kind].name,x:round(e.x),y:round(e.y),hp:round(e.hp),maxHp:e.maxHp,distance:round(d),radius:e.radius,
        inBasicRange:isVisible&&d<=w.range+e.radius,visible:isVisible,lastSeenSeconds:round(sim.time-k.seen),dx:round(e.x-p.x),dy:round(e.y-p.y),bearing:bearing(e.x-p.x,e.y-p.y),role:definition.role,vx:round(e.vx),vy:round(e.vy),
        state:isVisible?e.state:'last seen',warningSeconds:isVisible&&e.state==='windup'?round(Math.max(0,e.stateDuration-e.stateTime)):0,attackRange:definition.range,
        attackAngle:isVisible&&(e.state==='windup'||e.state==='attack')?round(e.attackAngle):null,attackTarget:isVisible&&(e.state==='windup'||e.state==='attack')?{x:round(e.attackTargetX),y:round(e.attackTargetY)}:null,
        route:route?{x:round(route.target.x),y:round(route.target.y),distance:round(route.distance)}:null,
        priority:round((isVisible?30:0)+(d<=w.range+e.radius?30:0)+(definition.role==='ranged'?10:0)+(e.id===this.focusTargetId?12:0)+20*(1-e.hp/e.maxHp)-Math.max(0,(route?.distance??1000)-w.range)/12)};
    }).sort((a,b)=>b.priority-a.priority);
    const escapes=this.tactics.options(p,visible,shots,true).sort((a,b)=>a.risk-b.risk);
    const actions:ArenaAction[]=[{id:'wait',description:'Hold still only if no productive combat, potion, investigate or search action is appropriate. Does not search, attack or evade.'}];
    if(this.outcome==='fighting'){
      for(const e of enemies){
        if(!e.visible){if(e.route)actions.push({id:`investigate:${e.id}`,description:`Route to last seen ${e.name} at (${e.x}, ${e.y}), ${e.lastSeenSeconds}s ago. Search only; never shoot through walls.`});continue;}
        if(e.route||e.inBasicRange)actions.push({id:`engage:${e.id}`,description:`Focus ${e.name} ${e.id} ${e.bearing}, ${e.distance} away: route in both axes, stop at ${w.style==='melee'?'melee':'ranged'} reach, aim and repeat basics (${w.mana} mana each). Evade imminent threats.`});
        for(const mode of ['kite','orbitLeft','orbitRight'] as const)actions.push({id:`${mode}:${e.id}`,description:`${mode==='kite'?'Retreat from':mode==='orbitLeft'?'Circle counterclockwise around':'Circle clockwise around'} ${e.name} ${e.id}; aim and fire in range, evade imminent attacks. ${mode==='kite'?'Use when too close or under pressure.':'Use to reposition around incoming fire.'}`});
        if(!busy(p)&&e.inBasicRange&&p.mana>=w.mana)actions.push({id:`attack:${e.id}`,description:`One stationary basic on ${e.id}: already in ${w.name} reach; autoaim. ${w.damage} nominal damage, ${w.mana} mana.`});
      }
      actions.push(...this.skillActions(visible));
      if(visible.length||shots.length){
        actions.push({id:'evade',description:'Take the lowest-risk collision-checked walking escape, without attacking. No dodge charge.'});
        if(canDodge(p))for(const e of escapes)actions.push({id:`dodge:${e.direction}`,description:`Dodge ${ARENA_DIRECTIONS[e.direction]} once to (${round(e.x)}, ${round(e.y)}). Forecast risk ${round(e.risk)}, travel ${round(e.travel)}. Spends one charge.`});
      }
      if(p.flasks>0&&p.healCooldown<=0&&(p.hp<p.maxHp||p.mana<p.maxMana))actions.push({id:'potion',description:`${p.hp<=p.maxHp*.35?'URGENT: life at '+round(p.hp/p.maxHp*100)+'%! Drink now. ':''}Restore up to ${round(p.maxHp*PLAYER_ABILITIES.potion.lifeFraction)} life and ${round(p.maxMana*PLAYER_ABILITIES.potion.manaFraction)} mana. ${p.flasks} charges.`});
      if(!visible.length)searchPoints.forEach((q,i)=>{const route=this.tactics.route(p,q);if(!this.visited.has(i)&&route)actions.push({id:`search:${i}`,description:`Search unvisited sector ${bearing(q.x-p.x,q.y-p.y)} at (${q.x}, ${q.y}), route ${round(route.distance)} units. Follow a body-safe path to find enemies; do this rather than wait when none are visible.`});});
    }
    return {time:round(sim.time),player:{x:round(p.x),y:round(p.y),hp:round(p.hp),maxHp:p.maxHp,mana:round(p.mana),maxMana:p.maxMana,potions:p.flasks,dodges:p.dodgeCharges,busy:busy(p),basicDamage:w.damage,basicRange:w.range,weapon:w.name,combatStyle:w.style,basicMana:w.mana,preferredMin:w.min,preferredMax:w.max},
      enemies,projectiles:shots.map(s=>({x:round(s.x),y:round(s.y),vx:round(s.vx),vy:round(s.vy),radius:s.radius,life:round(s.life)})),
      threats:this.tactics.threats(p,visible,shots).slice(0,32).map(t=>({...t,seconds:round(t.seconds),damage:round(t.damage)})),escapes:escapes.map(e=>({...e,x:round(e.x),y:round(e.y),travel:round(e.travel),risk:round(e.risk)})),
      memory:{focusTargetId:this.focusTargetId,lastAction:this.action?.id??this.recent.at(-1)?.action??'',execution:this.execution,stuck:this.recent.length>=2&&this.recent.slice(-2).every(r=>/^(engage|investigate|search|kite|orbit)/.test(r.action)&&r.moved<3&&r.damageDealt===0),recent:this.recent.map(r=>({...r}))},actions};
  }
  accept(id:string,observedAt:number):string|null {
    if(this.outcome!=='fighting')return 'Encounter already ended.';
    if(!Number.isFinite(observedAt)||observedAt>this.simulation.time+.02||this.simulation.time-observedAt>JEV_LIMITS.staleSeconds)return 'Observation expired.';
    if(!this.observation().actions.some(a=>a.id===id))return 'Action is no longer available.';
    const reflexUntil=this.reflexUntil,reflexDirection=this.reflexDirection;
    if(this.action)this.finish(this.action);else this.clearAction();
    const p=this.simulation.player,target=this.known.get(targetIdFor(id)??-1)?.enemy;
    this.focusTargetId=target?.id??this.focusTargetId;this.nextSteerAt=0;
    const intent=/^(engage|kite|orbitLeft|orbitRight|investigate|search|evade)(:|$)/.test(id);
    if(intent){this.reflexUntil=reflexUntil;this.reflexDirection=reflexDirection;}
    this.action={id,remaining:intent?JEV_LIMITS.intentSeconds:JEV_LIMITS.actionSeconds,pressed:false,start:{x:p.x,y:p.y},dealt:this.damageDealt,taken:this.damageTaken,startDistance:target?distance(p,target):0};return null;
  }
  private aim(input:Input,e:Enemy,speed:number){
    const p=this.simulation.player,lead=speed>0?Math.min(.18,distance(p,e)/speed)*.7:0;
    const scale=Math.min(1,18/Math.max(1,Math.hypot(e.vx*lead,e.vy*lead)));
    let point={x:e.x+e.vx*lead*scale,y:e.y+e.vy*lead*scale};
    if(!hasLineOfSight(this.world,p.x,p.y,point.x,point.y))point=e;
    input.aimX=point.x;input.aimY=point.y;
  }
  private steerTo(target:Point & {radius?:number},combat=false){
    const sim=this.simulation,p=sim.player;
    if(sim.time>=this.nextSteerAt||!this.waypoint||distance(p,this.waypoint)<2){
      const route=combat?this.tactics.approach(p,{...target,radius:target.radius??0}):this.tactics.route(p,target);
      this.waypoint=route?.target??null;this.nextSteerAt=sim.time+.12;
    }
    this.movement=this.waypoint?this.tactics.steer(p,this.waypoint):{x:0,y:0};
  }
  private reflex(input:Input):boolean {
    const sim=this.simulation,p=sim.player;
    if(p.dodgeTime>0)return true;
    if(sim.time<this.reflexUntil){const v=directionVector(this.reflexDirection);input.moveX=v.x;input.moveY=v.y;return true;}
    const enemies=this.visibleEnemies(),shots=this.visibleShots(),threats=this.tactics.threats(p,enemies,shots,{x:0,y:0},.22);
    const risk=threats.reduce((n,t)=>n+t.damage,0);if(!risk)return false;
    const dodge=canDodge(p),options=this.tactics.options(p,enemies,shots,dodge).sort((a,b)=>a.risk-b.risk||b.travel-a.travel),best=options[0];
    if(!best||best.risk>=risk)return false;
    const v=directionVector(best.direction);input.moveX=v.x;input.moveY=v.y;input.dodge=dodge;
    this.reflexDirection=best.direction;this.reflexUntil=sim.time+(dodge?PLAYER_ABILITIES.dodge.duration:.18);this.reflexes++;
    this.execution=`${dodge?'Dodge':'Sidestep'} ${ARENA_DIRECTIONS[best.direction]}: imminent ${threats[0].kind}`;return true;
  }
  private finish(action:Intent){
    const p=this.simulation.player,target=this.known.get(targetIdFor(action.id)??-1)?.enemy;
    this.recent.push({action:action.id,moved:round(distance(p,action.start)),damageDealt:round(this.damageDealt-action.dealt),damageTaken:round(this.damageTaken-action.taken),distanceChange:target?round(distance(p,target)-action.startDistance):0});
    this.recent.splice(0,Math.max(0,this.recent.length-6));this.clearAction();
  }
  step():CombatEvent[]{
    if(this.outcome!=='fighting')return [];
    const sim=this.simulation,p=sim.player,input=neutral(p),action=this.action;
    this.remember();
    if(action){
      const [kind,value]=action.id.split(':'),targetId=targetIdFor(action.id)??0,e=this.visibleEnemies().find(e=>e.id===targetId),w=weaponProfile(p);
      if(kind==='engage'||kind==='kite'||kind==='orbitLeft'||kind==='orbitRight'){
        if(!e){action.remaining=0;this.execution='Target lost; reconsider';}
        else {this.aim(input,e,w.speed);
          if(!this.reflex(input)){
            const d=distance(p,e),inRange=d<=w.range+e.radius;
            if(kind==='engage'&&(!inRange||w.style==='melee'&&d>this.tactics.attackDistance(p,e))){this.steerTo(e,true);this.execution=`Close into attack reach · ${e.id} ${bearing(e.x-p.x,e.y-p.y)}`;}
            else if(kind!=='engage'||w.style==='ranged'&&d<w.min){
              if(sim.time>=this.nextSteerAt){const option=this.tactics.positioning(p,e,this.visibleEnemies(),this.visibleShots(),kind==='engage'||kind==='kite'?'retreat':kind);this.movement=option?directionVector(option.direction):{x:0,y:0};this.waypoint=option;this.nextSteerAt=sim.time+.12;}
              this.execution=`${kind==='engage'?'Keep ranged distance':kind} · ${e.id}`;
            }else {this.movement={x:0,y:0};this.waypoint=null;this.execution=`Attack ${e.id}`;}
            input.moveX=this.movement.x;input.moveY=this.movement.y;
            // Normal held basic input repeats at the equipment cadence and pays normal costs.
            input.attack=inRange&&!busy(p)&&p.mana>=w.mana;
          }
        }
      }else if(kind==='search'||kind==='investigate'){
        const target=kind==='search'?searchPoints[Number(value)]:this.known.get(targetId)?.enemy;
        const reached=target&&(kind==='investigate'?hasLineOfSight(this.world,p.x,p.y,target.x,target.y)&&distance(p,target)<=this.tactics.attackDistance(p,{...target,radius:this.known.get(targetId)?.enemy.radius??0})+2:distance(p,target)<20);
        if(!target||reached||this.visibleEnemies().length){action.remaining=0;this.execution='Search ended; reconsider';}
        else {this.steerTo(target,kind==='investigate');input.moveX=this.movement.x;input.moveY=this.movement.y;this.execution='Follow search route';}
      }else if(kind==='evade'){
        if(sim.time>=this.nextSteerAt){const best=this.tactics.options(p,this.visibleEnemies(),this.visibleShots()).sort((a,b)=>a.risk-b.risk||b.travel-a.travel)[0];this.movement=best?directionVector(best.direction):{x:0,y:0};this.waypoint=best??null;this.nextSteerAt=sim.time+.12;}
        input.moveX=this.movement.x;input.moveY=this.movement.y;this.execution='Walk out of danger';
      }else if(kind==='dodge'&&!action.pressed){const v=directionVector(Number(value));input.moveX=v.x;input.moveY=v.y;input.dodge=true;this.execution=`Dodge ${ARENA_DIRECTIONS[Number(value)]}`;
      }else if(kind==='attack'||kind==='skill'){
        if(e){const id=kind==='skill'?p.character.skillSlots[Number(value)]:null,recipe=id?resolveSkill(id,p.derived,p.character).recipe:null;this.aim(input,e,recipe?.kind==='projectile'?recipe.speed:w.speed);}
        if(!action.pressed&&(e||kind==='skill'&&targetId===0)){input.attack=kind==='attack';input.skillSlot=kind==='skill'?Number(value):null;this.execution=kind==='attack'?`Single attack ${targetId}`:`Cast ${p.character.skillSlots[Number(value)]}`;}
      }else if(!action.pressed){input.heal=kind==='potion';this.execution=kind==='potion'?'Drink potion':'Hold position';}
      action.pressed=true;action.remaining-=COMBAT_TIMING.fixedStep;
    }
    sim.setCombatViewport(this.viewport);sim.update(COMBAT_TIMING.fixedStep,input);
    const events=sim.drainEvents();
    for(const e of events){if(e.type==='hurt')this.damageTaken+=e.actualValue??0;if(e.type==='hit')this.damageDealt+=e.actualValue??e.value;this.events.push({time:round(sim.time),type:e.type});}
    this.events.splice(0,Math.max(0,this.events.length-150));
    if(action&&action.remaining<=1e-8)this.finish(action);
    return events;
  }
}

/** Explicit deterministic demo for testing the motor, never reported as Jev. */
export function demoChoice(o:ArenaObservation):string {
  const has=(id:string)=>o.actions.some(a=>a.id===id);
  if((o.player.hp<o.player.maxHp*.5||o.player.mana<o.player.basicMana)&&has('potion'))return 'potion';
  const target=o.enemies.find(e=>e.visible);
  if(target&&has(`engage:${target.id}`))return `engage:${target.id}`;
  return o.actions.find(a=>a.id.startsWith('investigate:')||a.id.startsWith('search:'))?.id??'wait';
}
