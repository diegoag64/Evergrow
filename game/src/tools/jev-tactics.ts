import { COMBAT_TIMING, enemyAttackDefinition, PLAYER_ABILITIES, PLAYER_MOVEMENT, SKILL_CAST_MOTION } from '../combat-content.ts';
import { circleIntersectsSector, hasLineOfSight } from '../combat-geometry.ts';
import { basicAttackManaCost, basicAttackWeapon, deriveAttackStats } from '../equipment.ts';
import type { Enemy, Player, Projectile, WorldQuery } from '../model.ts';
import { hasWalkableSegment, WorldNavigation } from '../world-navigation.ts';

export interface Point { x:number; y:number; }
export const ARENA_DIRECTIONS = ['East','Southeast','South','Southwest','West','Northwest','North','Northeast'] as const;
export const directionVector = (i:number):Point => ({x:Math.cos(i*Math.PI/4),y:Math.sin(i*Math.PI/4)});
export const bearing = (dx:number,dy:number) => ARENA_DIRECTIONS[(Math.round(Math.atan2(dy,dx)/(Math.PI/4))+8)%8];
export const distance = (a:Point,b:Point) => Math.hypot(a.x-b.x,a.y-b.y);
export const busy = (p:Player) => !!p.attack||!!p.dash||p.castTime>0||p.dodgeTime>0;
export const canDodge = (p:Player) => p.dodgeCharges>0&&p.dodgeTime<=0&&(!p.attack||p.attack.elapsed>=p.attack.activeEnd)&&p.castTime<=p.castDuration*SKILL_CAST_MOTION.releaseRemainingFraction;
export function weaponProfile(p:Player) {
  const weapon=basicAttackWeapon(p),attack=deriveAttackStats(p.stats,weapon),melee=weapon.attackKind==='melee';
  return {name:weapon.name,style:melee?'melee' as const:'ranged' as const,kind:weapon.attackKind,
    range:attack.range,damage:attack.damage,mana:basicAttackManaCost(weapon,p.derived),
    speed:weapon.attackKind==='arrow'?560:weapon.attackKind==='bolt'?380:0,
    min:melee?attack.range*.6:Math.min(140,attack.range*.4),max:melee?attack.range*.88:Math.min(280,attack.range*.7)};
}

/** Predictions use only visible shots/telegraphs. Damage is a relative risk score, not a damage guarantee. */
export interface Threat { source:string; kind:'projectile'|'melee'|'ground'; seconds:number; damage:number; }
export interface MotionOption { direction:number; x:number; y:number; travel:number; risk:number; }
export class ArenaTactics {
  private navigation:WorldNavigation;
  readonly world:WorldQuery;
  constructor(world:WorldQuery){this.world=world;this.navigation=new WorldNavigation(world);}
  route(p:Player,target:Point) { return this.navigation.route(p.x,p.y,target.x,target.y,p.radius,1024); }
  attackDistance(p:Player,target:Point & {radius:number}):number {
    const w=weaponProfile(p);
    // Melee needs room inside the contact boundary so a retreating target cannot
    // leave reach during windup. Respect the two actors' bodies as well.
    return Math.min(w.range+target.radius-4,Math.max(p.radius+target.radius+2,w.max));
  }
  /** Route to a walkable attack position, not the enemy's possibly wall-hugging center. */
  approach(p:Player,target:Point & {radius:number}) {
    const standOff=this.attackDistance(p,target);
    if(distance(p,target)<=standOff&&hasLineOfSight(this.world,p.x,p.y,target.x,target.y))
      return {target:{x:p.x,y:p.y},distance:0};
    const angle=Math.atan2(p.y-target.y,p.x-target.x);
    let best:ReturnType<WorldNavigation['route']>=null;
    for(const offset of [0,1,-1,2,-2,3,-3,4]){
      const a=angle+offset*Math.PI/4,goal={x:target.x+Math.cos(a)*standOff,y:target.y+Math.sin(a)*standOff};
      if(this.world.blocked(goal.x,goal.y,p.radius)||!hasLineOfSight(this.world,goal.x,goal.y,target.x,target.y))continue;
      const direct=hasWalkableSegment(this.world,p.x,p.y,goal.x,goal.y,p.radius);
      const route=direct?{target:goal,distance:distance(p,goal)}:this.route(p,goal);
      // The radial point on our side is the shortest possible direct approach.
      if(offset===0&&direct)return route;
      if(route&&(!best||route.distance<best.distance))best=route;
    }
    return best;
  }
  /** Continuous projectile closest approach against a body moving at constant velocity. */
  threats(p:Player,enemies:readonly Enemy[],shots:readonly Projectile[],velocity:Point={x:0,y:0},horizon=.6):Threat[] {
    const threats:Threat[]=[];
    const shotThreat=(s:Point & {vx:number;vy:number;radius:number;life:number;damage:number},source:string,delay=0)=>{
      const start={x:p.x+velocity.x*delay,y:p.y+velocity.y*delay};
      const rx=s.x-start.x,ry=s.y-start.y,vx=s.vx-velocity.x,vy=s.vy-velocity.y,v2=vx*vx+vy*vy;
      const t=Math.max(0,Math.min(Math.max(0,horizon-delay),s.life,v2>0?-(rx*vx+ry*vy)/v2:0));
      if(delay>horizon||Math.hypot(rx+vx*t,ry+vy*t)>p.radius+s.radius+3)return;
      if(!hasLineOfSight(this.world,s.x,s.y,s.x+s.vx*t,s.y+s.vy*t))return;
      threats.push({source,kind:'projectile',seconds:delay+t,damage:s.damage});
    };
    for(const s of shots)if(s.life>0)shotThreat(s,`shot:${s.id}`);
    for(const e of enemies){
      if(e.stagger>0||(e.stunTime??0)>0||e.state!=='windup'&&e.state!=='attack')continue;
      const d=enemyAttackDefinition(e),t=e.state==='windup'?Math.max(0,e.stateDuration-e.stateTime):0;
      if(t>horizon)continue;
      const point={x:p.x+velocity.x*t,y:p.y+velocity.y*t};
      if(d.attack==='projectile'){
        if(e.state!=='windup')continue; // Once released, the actual projectile is authoritative.
        for(const offset of d.shotOffsets){const a=e.attackAngle+offset;shotThreat({...e,vx:Math.cos(a)*d.projectile.speed,vy:Math.sin(a)*d.projectile.speed,radius:d.projectile.radius,life:d.projectile.life,damage:e.attackDamage??e.damage},`enemy:${e.id}`,t);}
      }else if(d.attack==='ground'){
        if(e.state==='windup'&&Math.hypot(point.x-e.attackTargetX,point.y-e.attackTargetY)<=d.blastRadius+p.radius)
          threats.push({source:`enemy:${e.id}`,kind:'ground',seconds:t,damage:e.attackDamage??e.damage});
      }else if(!e.attackHit||e.state==='windup'){
        if(circleIntersectsSector(point.x,point.y,p.radius,e.x,e.y,e.attackAngle,d.range+d.lungeSpeed*Math.min(d.active,.12),d.arc)&&hasLineOfSight(this.world,e.x,e.y,point.x,point.y))
          threats.push({source:`enemy:${e.id}`,kind:'melee',seconds:t,damage:e.attackDamage??e.damage});
      }
    }
    return threats.sort((a,b)=>a.seconds-b.seconds);
  }
  /** Every candidate follows body-sized collision for the entire path, not just its endpoint. */
  options(p:Player,enemies:readonly Enemy[],shots:readonly Projectile[],dodge=false):MotionOption[] {
    const duration=dodge?PLAYER_ABILITIES.dodge.duration:.35;
    const speed=dodge?PLAYER_ABILITIES.dodge.speed:PLAYER_MOVEMENT.speed*p.derived.moveSpeedMultiplier;
    return Array.from({length:8},(_,direction)=>{
      const v=directionVector(direction);let point:Point={x:p.x,y:p.y};
      for(let t=0;t<duration;t+=COMBAT_TIMING.fixedStep)point=this.world.move(point.x,point.y,v.x*speed*COMBAT_TIMING.fixedStep,v.y*speed*COMBAT_TIMING.fixedStep,p.radius);
      const velocity={x:(point.x-p.x)/duration,y:(point.y-p.y)/duration};
      const threats=this.threats(p,enemies,shots,velocity,duration);
      // Do not assume the whole dodge is invulnerable. Check the normal window only.
      const risk=threats.reduce((n,t)=>n+(dodge&&t.seconds>=PLAYER_ABILITIES.dodge.invulnerabilityStart&&t.seconds<=PLAYER_ABILITIES.dodge.invulnerabilityEnd?0:t.damage),0)
        +this.threats({...p,...point},enemies,shots.map(s=>({...s,x:s.x+s.vx*duration,y:s.y+s.vy*duration,life:s.life-duration})),{x:0,y:0},.15).reduce((n,t)=>n+t.damage*.5,0);
      return {direction,...point,travel:distance(p,point),risk};
    }).filter(o=>o.travel>=12);
  }
  /** Target-relative spacing and orbiting; never use an arbitrary horizontal fallback. */
  positioning(p:Player,target:Point,enemies:readonly Enemy[],shots:readonly Projectile[],mode:'retreat'|'orbitLeft'|'orbitRight'):MotionOption|null {
    const profile=weaponProfile(p),dx=target.x-p.x,dy=target.y-p.y,len=Math.max(1,Math.hypot(dx,dy));
    const side=mode==='orbitLeft'?-1:1;
    const ideal=mode==='retreat'?{x:-dx/len,y:-dy/len}:{x:-dy/len*side,y:dx/len*side};
    const options=this.options(p,enemies,shots);
    return options.sort((a,b)=>{
      const score=(o:MotionOption)=>{
        const d=distance(o,target),v=directionVector(o.direction);
        const spacing=mode==='retreat'?-d:Math.abs(d-Math.max(profile.min,Math.min(profile.max,len)));
        return o.risk*20+spacing-(v.x*ideal.x+v.y*ideal.y)*45+(hasLineOfSight(this.world,o.x,o.y,target.x,target.y)?0:100);
      };return score(a)-score(b);
    })[0]??null;
  }
  steer(p:Player,target:Point):Point {
    const dx=target.x-p.x,dy=target.y-p.y,len=Math.hypot(dx,dy);
    // Corner waypoints must actually be reached: a two-unit dead zone can
    // stop short of the clearance needed to turn around a wall.
    if(len<1e-6||!hasWalkableSegment(this.world,p.x,p.y,target.x,target.y,p.radius))return {x:0,y:0};
    return {x:dx/len,y:dy/len};
  }
}
