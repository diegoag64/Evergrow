/** Local study wire format. No character saves, secrets or arbitrary prompts. */
export const JEV_LIMITS = Object.freeze({ actionSeconds:.6, intentSeconds:2, duration:300, maxRecords:240, intervalMs:200, timeoutMs:12000, staleSeconds:2, bodyBytes:65536 });
export interface ArenaAction { id:string; description:string; }
export interface ArenaEnemy {
  id:number; name:string; x:number; y:number; hp:number; maxHp:number; distance:number; radius:number;
  inBasicRange:boolean; visible:boolean; lastSeenSeconds:number; dx:number; dy:number; bearing:string;
  role:string; vx:number; vy:number; state:string; warningSeconds:number; attackRange:number;
  attackAngle:number|null; attackTarget:{x:number;y:number}|null;
  route:{x:number;y:number;distance:number}|null; priority:number;
}
export interface ArenaObservation {
  time:number;
  player:{x:number;y:number;hp:number;maxHp:number;mana:number;maxMana:number;potions:number;dodges:number;busy:boolean;basicDamage:number;basicRange:number;
    weapon:string;combatStyle:'melee'|'ranged';basicMana:number;preferredMin:number;preferredMax:number};
  enemies:ArenaEnemy[];
  projectiles:Array<{x:number;y:number;vx:number;vy:number;radius:number;life:number}>;
  threats:Array<{source:string;kind:string;seconds:number;damage:number}>;
  escapes:Array<{direction:number;x:number;y:number;travel:number;risk:number}>;
  memory:{focusTargetId:number|null;lastAction:string;execution:string;stuck:boolean;recent:Array<{action:string;moved:number;damageDealt:number;damageTaken:number;distanceChange:number}>};
  actions:ArenaAction[];
}
export interface JevDecision { choice:string; confidence:number; probabilities:Record<string,number>; inputTokens:number; outputTokens:number; }
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&Math.abs(v)<=1000000;
const actionId=/^(wait|potion|evade|dodge:[0-7]|search:[0-4]|(?:engage|attack|kite|orbitLeft|orbitRight|investigate):[1-9]\d{0,5}|skill:[0-4]:\d{1,6})$/;
type Decoder=(value:unknown)=>unknown;
const fail=():never=>{throw new Error('Invalid arena observation.');};
const number:Decoder=v=>finite(v)?v:fail();
const bool:Decoder=v=>typeof v==='boolean'?v:fail();
const string:Decoder=v=>typeof v==='string'&&v.length<=280?v:fail();
const nullable=(read:Decoder):Decoder=>v=>v===null?null:read(v);
const array=(read:Decoder,max:number):Decoder=>v=>Array.isArray(v)&&v.length<=max?v.map(read):fail();
const shape=(fields:Record<string,Decoder>):Decoder=>v=>object(v)?Object.fromEntries(Object.entries(fields).map(([k,read])=>[k,read(v[k])])):fail();
const point=shape({x:number,y:number});
const decode=shape({
  time:number,
  player:shape({x:number,y:number,hp:number,maxHp:number,mana:number,maxMana:number,potions:number,dodges:number,busy:bool,basicDamage:number,basicRange:number,weapon:string,combatStyle:v=>v==='melee'||v==='ranged'?v:fail(),basicMana:number,preferredMin:number,preferredMax:number}),
  enemies:array(shape({id:number,name:string,x:number,y:number,hp:number,maxHp:number,distance:number,radius:number,inBasicRange:bool,visible:bool,lastSeenSeconds:number,dx:number,dy:number,bearing:string,role:string,vx:number,vy:number,state:string,warningSeconds:number,attackRange:number,attackAngle:nullable(number),attackTarget:nullable(point),route:nullable(shape({x:number,y:number,distance:number})),priority:number}),3),
  projectiles:array(shape({x:number,y:number,vx:number,vy:number,radius:number,life:number}),16),
  threats:array(shape({source:string,kind:string,seconds:number,damage:number}),32),
  escapes:array(shape({direction:number,x:number,y:number,travel:number,risk:number}),8),
  memory:shape({focusTargetId:nullable(number),lastAction:string,execution:string,stuck:bool,recent:array(shape({action:string,moved:number,damageDealt:number,damageTaken:number,distanceChange:number}),6)}),
  actions:array(shape({id:string,description:string}),64),
});
/** Reconstruct every nested field; unknown data is never forwarded to the provider. */
export function parseObservation(value:unknown):ArenaObservation {
  const o=decode(value) as ArenaObservation;
  if(o.time<0||o.time>JEV_LIMITS.duration+1||!o.actions.length||o.actions.some(a=>!actionId.test(a.id))||new Set(o.actions.map(a=>a.id)).size!==o.actions.length
    ||o.enemies.some(e=>!Number.isInteger(e.id)||e.id<=0||e.id>999999||e.radius<0||e.lastSeenSeconds<0)
    ||o.escapes.some(e=>!Number.isInteger(e.direction)||e.direction<0||e.direction>7))fail();
  return o;
}
export function jevRequest(observation:ArenaObservation) {
  return {model:'jev-latest',state:observation,questions:{action:{type:'choice',
    instructions:`You are the tactical brain of a combat bot. Defeat the known enemies efficiently while surviving. Select exactly one offered action. Read the equipped weapon and combatStyle: do not assume a sword.
Survival and exploration priorities: when life is at or below 35% and potion is offered, choose potion before more offense unless an immediate dodge is needed to survive. When no enemy is visible, choose investigate for a last-seen enemy or search an unvisited sector (prefer a short route); never wait indefinitely in an uncleared chamber.
Prefer engage:TARGET to make progress when an enemy is visible. It routes toward that target in BOTH axes, stops at weapon reach, aims and repeats normal basic attacks for this short intent. It reacts to imminent visible attacks with collision-checked evasion. Jev chooses the target and tactic; the motor layer executes them. Keep a useful focus target across decisions, but switch to a nearby kill, an exposed dangerous ranged enemy, or a more reachable threat when justified. priority is only a heuristic, not an order.
Melee: close the actual gap, then keep hitting during safe openings. Ranged: use your reach; shoot from a safe distance instead of running into melee. kite backs away while firing when possible; orbitLeft/orbitRight circle the selected target while firing in range. Use these only when pressure or blocked positioning warrants them. Do not endlessly kite a harmless distant enemy or circle instead of killing it. attack is a single stationary basic; offered attacks already have range and line of sight, including enemy body radius. All targeted attacks turn and aim automatically.
Use threats (predicted time to impact and nominal risk), escapes (collision-checked dodge endpoints/risk), warningSeconds and enemy roles to avoid real incoming attacks. evade chooses a safe walking direction; dodge spends one charge. Skills are compatible, assigned and ready, with descriptions, costs and ranges. Use damage/control skills for useful kills, interrupts or groups; defensive skills for pressure. Drink a potion for missing life or needed mana. Conserve mana with affordable basics; do not repeatedly engage when unable to pay for one.
route is the next body-safe waypoint and remaining route distance, null means no route found. Enemies marked visible=false are last-known positions only: investigate can search that location, but you cannot attack an unseen enemy. Never assume their current position. memory.recent reports actual movement, damage and distance change (negative means closer). If stuck or the same tactic makes no progress, change the target or positioning tactic. If busy, continuing engage preserves intent through recovery; wait only when there is nothing useful to do.
Coordinates are ground coordinates: north/up is negative y, south/down positive y, east/right positive x. bearing and dx/dy are relative to the player. Target commands handle these coordinates. Combat runs in real time while you think. Target intents continue for up to ${JEV_LIMITS.intentSeconds}s and are renewed by fresh decisions; single presses have a ${JEV_LIMITS.actionSeconds}s window. Commands stop when the target is lost/killed; local reflexes operate only during movement/combat intents. Pause, errors, stale replies and expired intents stop control. No knowledge of hidden enemies or future attacks.`,
    criteria:Object.fromEntries(observation.actions.map(a=>[a.id,a.description]))}}};
}
export function parseJevDecision(value: unknown, actions: readonly ArenaAction[]): JevDecision {
  if (!object(value) || !object(value.answers) || !object(value.answers.action)) throw new Error('Jev returned an invalid answer.');
  const a = value.answers.action, ids = actions.map(v => v.id);
  if (a.type !== 'choice' || typeof a.choice !== 'string' || !ids.includes(a.choice) || !finite(a.confidence) || a.confidence < 0 || a.confidence > 1 || !object(a.probabilities)) throw new Error('Jev returned an invalid choice.');
  const probabilities = a.probabilities;
  if (Object.keys(probabilities).length !== ids.length || !ids.every(id => finite(probabilities[id]) && probabilities[id] >= 0 && probabilities[id] <= 1) || Math.abs(ids.reduce((n,id)=>n+Number(probabilities[id]),0)-1) > .02) throw new Error('Jev returned invalid probabilities.');
  const usage = object(value.usage) ? value.usage : {};
  const tokens = (v: unknown) => finite(v) && Number.isInteger(v) && v >= 0 ? v : 0;
  return { choice:a.choice, confidence:a.confidence, probabilities:Object.fromEntries(ids.map(id=>[id,Number(probabilities[id])])), inputTokens:tokens(usage.input_tokens), outputTokens:tokens(usage.output_tokens) };
}
