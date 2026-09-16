import type { CombatEvent } from '../model.ts';
import { COMBAT_TIMING } from '../combat-content.ts';
import { JevArena, demoChoice } from './jev-arena-model.ts';
import { JEV_LIMITS, type ArenaObservation, type JevDecision } from './jev-protocol.ts';

export type JevTransport=(observation:ArenaObservation,signal:AbortSignal)=>Promise<JevDecision>;
export interface PilotOptions {provider:'jev'|'demo';}
export interface DecisionRecord {observation:ArenaObservation;choice:string;confidence:number|null;latencyMs:number;accepted:boolean;rejection:string|null;probabilities:Record<string,number>;inputTokens:number;outputTokens:number;}
/** Real-time tactical decisions run alongside the motor. One request in flight; bounded history, no usage budget. */
export class ArenaPilot {
  readonly arena:JevArena;
  readonly options:PilotOptions;
  readonly records:DecisionRecord[]=[];
  running=false;pending=false;requests=0;status='Ready';
  accepted=0;rejected=0;responses=0;inputTokens=0;outputTokens=0;latencyTotal=0;
  lastObservation:ArenaObservation|null=null;
  private epoch=0;private abort:AbortController|null=null;private nextRequestAt=0;private accumulator=0;
  private transport:JevTransport;private now:()=>number;
  constructor(arena:JevArena,options:PilotOptions,transport:JevTransport,now:()=>number){this.arena=arena;this.options={...options};this.transport=transport;this.now=now;}
  start(){if(this.arena.outcome!=='fighting')return;this.running=true;this.status='Running';this.accumulator=0;}
  pause(reason='Paused'){this.running=false;this.status=reason;this.epoch++;this.abort?.abort();this.abort=null;this.pending=false;this.accumulator=0;this.arena.clearAction();}
  tick(dt:number):CombatEvent[]{
    if(!this.running)return [];
    if(this.arena.outcome!=='fighting'){this.pause(this.arena.outcome);return [];}
    if(!this.pending&&this.now()>=this.nextRequestAt)void this.decide();
    this.accumulator+=Math.max(0,Math.min(.05,dt));const events:CombatEvent[]=[];
    while(this.accumulator+1e-10>=COMBAT_TIMING.fixedStep){
      events.push(...this.arena.step());this.accumulator-=COMBAT_TIMING.fixedStep;
      if(this.arena.outcome!=='fighting'){this.pause(this.arena.outcome);break;}
    }return events;
  }
  private async decide(){
    const observation=this.arena.observation(),epoch=this.epoch,started=this.now();
    this.lastObservation=observation;this.requests++;this.pending=true;this.status=this.options.provider==='jev'?'Jev is reassessing…':'Offline control demo';
    const abort=this.abort=new AbortController();
    try{
      const result=this.options.provider==='jev'?await this.transport(observation,abort.signal):{choice:demoChoice(observation),confidence:0,probabilities:{},inputTokens:0,outputTokens:0};
      if(epoch!==this.epoch||!this.running)return;
      const rejection=this.arena.accept(result.choice,observation.time),latencyMs=Math.round(this.now()-started);
      this.responses++;this.latencyTotal+=latencyMs;this.inputTokens+=result.inputTokens;this.outputTokens+=result.outputTokens;
      if(rejection)this.rejected++;else this.accepted++;
      this.records.push({observation,choice:result.choice,confidence:this.options.provider==='jev'?result.confidence:null,latencyMs,accepted:rejection===null,rejection,probabilities:result.probabilities,inputTokens:result.inputTokens,outputTokens:result.outputTokens});
      this.records.splice(0,Math.max(0,this.records.length-JEV_LIMITS.maxRecords));
      this.status=rejection?`Reconsidering: ${rejection}`:observation.actions.find(a=>a.id===result.choice)?.description??result.choice;
    }catch(error){if(epoch===this.epoch)this.pause(error instanceof Error?error.message:'Decision request failed.');}
    finally{if(epoch===this.epoch){this.pending=false;this.abort=null;this.nextRequestAt=this.now()+JEV_LIMITS.intervalMs;}}
  }
  report(){return {version:2,provider:this.options.provider,timing:'realtime',scenario:this.arena.scenario,loadout:this.arena.loadout,requests:this.requests,accepted:this.accepted,rejected:this.rejected,inputTokens:this.inputTokens,outputTokens:this.outputTokens,retainedDecisions:this.records.length,outcome:this.arena.outcome,status:this.status,elapsed:this.arena.simulation.time,reflexes:this.arena.reflexes,damageTaken:this.arena.damageTaken,damageDealt:this.arena.damageDealt,player:this.arena.observation().player,records:this.records,events:this.arena.events};}
}
