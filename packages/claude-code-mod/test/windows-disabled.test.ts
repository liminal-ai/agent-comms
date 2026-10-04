import test from 'node:test';
import assert from 'node:assert/strict';
import {register} from '../hooks/register.ts';
test('Windows standalone hook remains off without a verified private host transport',async()=>{
 const handlers=new Map();register((event: string,handler: any)=>handlers.set(event,handler));
 const result={cwd:'fixture'};
 const host={env:{get:async(name: string)=>name==='AGENT_COMMS_PARTICIPANT'?'fixture':name==='OS'?'Windows_NT':undefined}};
 assert.equal(await handlers.get('session.start')(host,{},async()=>result),result);
});
