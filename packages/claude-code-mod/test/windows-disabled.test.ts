import test from 'node:test';
import assert from 'node:assert/strict';
import {register} from '../hooks/register.ts';
for (const {os, system, supported} of [
 {os:'Windows_NT',system:'Linux',supported:false},
 {os:'wInDoWs_nT',system:'Linux',supported:false},
 {os:undefined,system:'MINGW64_NT-10.0',supported:false},
 {os:undefined,system:'CYGWIN_NT-10.0',supported:false},
 {os:undefined,system:undefined,supported:false},
 {os:undefined,system:'Linux',supported:true},
 {os:undefined,system:'Darwin',supported:true},
]) test(`standalone hook platform guard: OS=${os}, uname=${system}`,async()=>{
 const handlers=new Map();register((event: string,handler: any)=>handlers.set(event,handler));
 const result={cwd:'fixture'};
 const commands:string[][]=[];
 let sessionReads=0;
 const values:Record<string,string|undefined>={AGENT_COMMS_PARTICIPANT:'fixture',OS:os,AGENT_COMMS_SOCKET:'explicit-socket'};
 const host={
  env:{get:async(name: string)=>values[name]},
  process:{run:async(argv:string[])=>{
   commands.push(argv);
   return {exitCode:system===undefined?1:0,stdout:system??''};
  }},
  session:{id:async()=>{sessionReads++;throw Error('Stop before state or connector access');}},
 };
 assert.equal(await handlers.get('session.start')(host,{},async()=>result),result);
 assert.equal(sessionReads,supported?1:0);
 assert.deepEqual(commands,os ? [] : [['uname','-s']]);
});
