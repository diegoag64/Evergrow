import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadEnv, type Plugin } from 'vite';
import { JEV_LIMITS, jevRequest, parseJevDecision, parseObservation } from '../src/tools/jev-protocol.ts';

interface ProxyOptions { getKey:()=>string; fetch?:typeof fetch; now?:()=>number; }
/** Loopback-only, same-origin, local-development route; never included in a shipped build. */
export function createJevHandler(options:ProxyOptions){
  const requestFetch=options.fetch??fetch,now=options.now??Date.now;
  let busy=false,nextRequest=0;
  return async (request:IncomingMessage,response:ServerResponse):Promise<void>=>{
    const send=(status:number,data:unknown)=>{if(response.destroyed)return;response.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});response.end(JSON.stringify(data));};
    const host=request.headers.host??'',origin=request.headers.origin;
    if(!/^127\.0\.0\.1:\d+$/.test(host)||request.headers['x-evergrow-jev']!=='arena'||(origin!==undefined&&origin!==`http://${host}`)||request.method==='POST'&&origin!==`http://${host}`){send(403,{error:'Only the local arena can access this endpoint.'});return;}
    if(request.method==='GET'){send(200,{configured:!!options.getKey(),model:'jev-latest'});return;}
    if(request.method!=='POST'){send(405,{error:'Method not allowed.'});return;}
    if(request.headers['content-type']?.split(';')[0]!=='application/json'){send(415,{error:'Expected JSON.'});return;}
    if(busy||now()<nextRequest){send(429,{error:'A decision is pending or the request interval has not elapsed. Resume after a moment.'});return;}
    const key=options.getKey();
    if(!key){send(503,{error:'Set TYPESAFE_API_KEY in game/.env.local, then click Check connection.'});return;}
    busy=true;
    const abort=new AbortController(),timeout=setTimeout(()=>{abort.abort();if(!request.complete)request.destroy();},JEV_LIMITS.timeoutMs);
    const disconnected=()=>{if(!response.writableEnded)abort.abort();};
    response.on('close',disconnected);
    try{
      let bytes=0;const chunks:Buffer[]=[];
      for await(const chunk of request){bytes+=Buffer.byteLength(chunk);if(bytes>JEV_LIMITS.bodyBytes){send(413,{error:'Observation is too large.'});return;}chunks.push(Buffer.from(chunk));}
      let observation;
      try{observation=parseObservation(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{send(400,{error:'Invalid arena observation.'});return;}
      nextRequest=now()+JEV_LIMITS.intervalMs;
      const upstream=await requestFetch('https://api.typesafe.ai/v1/systemone',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(jevRequest(observation)),signal:abort.signal,redirect:'error'});
      if(!upstream.ok){
        const message=upstream.status===401?'Typesafe rejected the API key.':upstream.status===429||upstream.status===529?'Typesafe is rate limited or busy. Wait before resuming.':`Typesafe request failed (HTTP ${upstream.status}).`;
        await upstream.body?.cancel();send(502,{error:message});return;
      }
      const body=await upstream.text();
      if(body.length>100000)throw new Error('Oversized response');
      send(200,parseJevDecision(JSON.parse(body),observation.actions));
    }catch{
      // Never relay provider response bodies, exception text, request headers or credentials.
      send(502,{error:abort.signal.aborted?'Jev request timed out or was cancelled.':'Jev connection failed or returned an invalid decision.'});
    }finally{clearTimeout(timeout);response.off('close',disconnected);busy=false;}
  };
}
export function jevProxy():Plugin {
  return {name:'local-jev-arena',apply:'serve',configureServer(server){
    const handler=createJevHandler({getKey:()=>process.env.TYPESAFE_API_KEY?.trim()||loadEnv(server.config.mode,server.config.root,'TYPESAFE_').TYPESAFE_API_KEY?.trim()||''});
    server.middlewares.use('/__jev-arena',(request,response)=>{void handler(request,response);});
  }};
}
