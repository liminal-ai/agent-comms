import assert from 'node:assert/strict';
import {StubComms,startStubServer} from '../../connector-stub/src/index.ts';
import {run} from '../../comms-cli/src/cli.ts';
import {serveLoopback} from '../../connector/src/loopback.ts';
import {windowsEndpoint} from '../src/index.mjs';
const socket=windowsEndpoint('comms-test-'+Date.now());
const state=StubComms.fromFixture({machine:'windows-local-test',participants:[{name:'local-a'},{name:'local-b'}]});
let server=await startStubServer({socketPath:socket,comms:state,pollWaitMs:50});
const evidence=[];
async function cli(args){let stdout='',stderr='';const code=await run(['--socket',socket,...args],{env:{},stdout:t=>stdout+=t,stderr:t=>stderr+=t,readStdin:async()=>''});assert.equal(code,0,stderr);evidence.push({args,stdout,stderr});return stdout;}
try {
 const sent=await cli(['send','--as','local-a','@local-b','windows-local-provenance']);
 const message=sent.match(/sent (m_\d+)/)[1];const conversation=sent.match(/in (c_\d+)/)[1];
 await cli(['reply','--as','local-b',message,'windows-local-reply']);
 const read=await cli(['read','--as','local-a',conversation]);assert.match(read,/windows-local-reply/);
 await Promise.all([cli(['read','--as','local-a',conversation]),cli(['read','--as','local-b',conversation])]);
 await server.close();server=await startStubServer({socketPath:socket,comms:state,pollWaitMs:50});
 assert.match(await cli(['read','--as','local-b',conversation]),/windows-local-provenance/);
 console.log(JSON.stringify({localStubSendReply:'pass',concurrentReads:'pass',transportRestart:'pass',evidence},null,2));
}finally{await server.close();}
// Exercise the production connector HTTP handler with local fake handlers only.
const production=await serveLoopback(socket,{},()=>{});await production.close();console.log('Production connector transport start/close: pass');
