import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {StubComms} from '../../connector-stub/src/index.ts';
import {run} from '../../comms-cli/src/cli.ts';
import {createWindowsAgent} from '../src/agent.mjs';
import {listenWindows,windowsEndpoint} from '../src/index.mjs';

// Lose the client helper after posting, before the HTTP response. Both a process
// exit and a fatal E frame must use the CLI's existing idempotent retry path.
for(const fault of ['exit','EIO']) {
 const endpoint=windowsEndpoint('client-retry-'+process.pid+'-'+fault.toLowerCase());
 const agent=createWindowsAgent(endpoint);
 const comms=StubComms.fromFixture({machine:'retry-test',participants:[{name:'sender'},{name:'recipient'}]});
 const attempts=[];
 let handlerError;
 const server=createServer((req,res)=>{
  let body='';req.on('data',chunk=>body+=chunk);
  req.on('end',()=>{
   try {
    const request=JSON.parse(body);
    const result=comms.send(request);
    attempts.push({key:request.key,messageId:result.message.id,conversationId:result.message.conversationId});
    if(attempts.length===1) {
     const sockets=Object.values(agent.sockets).flat();
     assert.equal(sockets.length,1);
     const bridge=sockets[0].bridge;
     if(fault==='exit')bridge.child.kill();
     else bridge.child.stdout.emit('data','E\t0\tEIO\n');
     return;
    }
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({ok:true,...result}));
   }catch(error){handlerError=error;res.destroy();}
  });
 });
 const close=await listenWindows(server,endpoint);
 try {
  let stderr='';
  const code=await run(['--socket',endpoint,'send','--as','sender','--continue','@recipient','one message'],{
   env:{},stdout:()=>{},stderr:text=>stderr+=text,readStdin:async()=>'',
  });
  assert.ifError(handlerError);
  assert.equal(code,0,stderr);
  assert.equal(attempts.length,2);
  assert.ok(attempts[0].key);
  assert.deepEqual(attempts[1],attempts[0]);
  const history=comms.read({as:'sender',conversationId:attempts[0].conversationId});
  assert.equal(history.messages.length,1);
 }finally{agent.destroy();await close();}
}
