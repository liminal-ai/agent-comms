import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {powershellPath} from '../src/runtime.mjs';
import {Bridge,windowsEndpoint,listenWindows,connectWindows} from '../src/index.mjs';
import {createServer,request,Agent} from 'node:http';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
const exec=promisify(execFile);
const windows=process.platform==='win32';
test('endpoints accept local, domain, and Entra identities without changing the user namespace',async(t)=>{
 const saved=process.env.AGENT_COMMS_POWERSHELL;
 process.env.AGENT_COMMS_POWERSHELL=process.execPath;
 let identity;
 const readSid=t.mock.method(childProcess,'execFileSync',()=>identity);
 syncBuiltinESMExports();
 try {
  let sequence=0;
  for(const sid of ['S-1-5-21-111-222-333-1001','S-1-12-1-111-222-333-444','S-1-5-18']){
   identity=sid;
   const {windowsEndpoint}=await import(`../src/index.mjs?identity-test=${++sequence}`);
   assert.equal(windowsEndpoint('fixture'),`\\\\.\\pipe\\agent-comms-${sid}-fixture`);
   assert.throws(()=>windowsEndpoint('../other'),/suffix/);
  }
  identity='S-1-12-1-111\\other';
  const {windowsEndpoint}=await import('../src/index.mjs?identity-test=invalid');
  assert.throws(()=>windowsEndpoint('fixture'),/SID/);
 }finally{
  readSid.mock.restore();syncBuiltinESMExports();
  if(saved===undefined)delete process.env.AGENT_COMMS_POWERSHELL;else process.env.AGENT_COMMS_POWERSHELL=saved;
 }
});
for(const name of ['private-pipe.ps1','http-interop.ps1','secret-negative.ps1','secret.ps1','bridge.mjs','comms.mjs','client-retry.mjs'])test(name,{skip:!windows,timeout:60000},async()=>{
 const path=fileURLToPath(new URL(name,import.meta.url));
 const ps=name.endsWith('.ps1');
 await exec(ps?powershellPath():process.execPath,ps?['-NoProfile','-NonInteractive','-File',path]:[path],{windowsHide:true,timeout:55000});
});
for(const active of [false,true])test(`helper death is reported after ready, active=${active}`,{skip:!windows,timeout:30000},async()=>{
 const endpoint=windowsEndpoint('death-'+process.pid+'-'+Number(active));
 let failed;const failure=new Promise(resolve=>failed=resolve);
 const server=new Bridge('server',endpoint,()=>{},failed);let client;
 try {
  await server.ready;
  if(active){client=new Bridge('client',endpoint);await client.ready;}
  server.child.kill();
  const error=await Promise.race([failure,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Failure not propagated')),5000);timer.unref();})]);
  assert.match(error.message,/exited/);
 }finally{await client?.close();await server.close();}
});
test('deliberate helper shutdown does not report a fault',{skip:!windows,timeout:20000},async()=>{
 let count=0;const server=new Bridge('server',windowsEndpoint('close-'+process.pid),()=>{},()=>count++);
 await server.ready;await server.close();assert.equal(count,0);
});
test('runtime rejects relative executable configuration',{skip:!windows},()=>{
 const saved=process.env.AGENT_COMMS_POWERSHELL;
 try{process.env.AGENT_COMMS_POWERSHELL='pwsh.exe';assert.throws(powershellPath,/absolute/);}
 finally{if(saved===undefined)delete process.env.AGENT_COMMS_POWERSHELL;else process.env.AGENT_COMMS_POWERSHELL=saved;}
});

test('after-ready E frame cannot swallow an unhandled server failure',{skip:!windows,timeout:20000},async()=>{
 const index=new URL('../src/index.mjs',import.meta.url).href;
 const code=`import {Bridge,windowsEndpoint} from ${JSON.stringify(index)};import {createServer} from 'node:http';const server=createServer();const bridge=new Bridge('server',windowsEndpoint('error-frame-'+process.pid),()=>{},error=>server.emit('error',error));await bridge.ready;bridge.child.stdout.emit('data','E\\t0\\tEIO\\n');`;
 await assert.rejects(exec(process.execPath,['--input-type=module','-e',code],{windowsHide:true,timeout:15000}),error=>error.code===1&&/Windows pipe connection failed: EIO/.test(error.stderr));
});

test('both adapters reject broad-ACL credentials again after file replacement',{skip:!windows,timeout:20000},async()=>{
 const {mkdtemp,writeFile,rm,rmdir}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const {makeT3Client}=await import('../../adapter-t3/src/t3/client.ts');const {makeT3ClientV2}=await import('../../adapter-t3/src/v2/client.ts');
 const dir=await mkdtemp(join(tmpdir(),'comms-reread-'));const authFile=join(dir,'dummy');
 try{for(const factory of [makeT3Client,makeT3ClientV2]){
  const client=factory({baseUrl:'http://127.0.0.1:1',authFile,log:()=>{}});
  try{for(const content of ['dummy-first','dummy-replacement']){await rm(authFile,{force:true});await writeFile(authFile,content);await assert.rejects(client.getThread('fixture'),/private|Secret|validate-secret|Command failed/i);}}finally{await client.close();}
 }}finally{await rm(authFile,{force:true});await rmdir(dir);}
});


test('Windows HTTP enforces header/body deadlines and remains usable',{skip:!windows,timeout:30000},async()=>{
 const endpoint=windowsEndpoint('http-timeouts-'+process.pid);
 const server=createServer({headersTimeout:150,requestTimeout:300,connectionsCheckingInterval:25},(req,res)=>{
  req.resume();req.on('end',()=>res.end('healthy'));
 });
 const close=await listenWindows(server,endpoint);
 const agent=new Agent({keepAlive:false});agent.createConnection=(_options,callback)=>connectWindows(endpoint,callback);
 async function partialRequest(payload){
  const socket=await new Promise((resolve,reject)=>connectWindows(endpoint,(error,socket)=>error?reject(error):resolve(socket)));
  return new Promise((resolve,reject)=>{
   let body='';const timer=setTimeout(()=>{socket.destroy();reject(Error('HTTP deadline did not close partial request'));},3000);
   socket.on('data',chunk=>body+=chunk.toString());socket.once('error',error=>{clearTimeout(timer);reject(error);});
   socket.once('close',()=>{clearTimeout(timer);resolve(body);});socket.write(payload);
  });
 }
 try {
  assert.match(await partialRequest('GET / HTTP/1.1\r\nHost: incomplete'),/^HTTP\/1\.1 408 /);
  assert.match(await partialRequest('POST / HTTP/1.1\r\nHost: local\r\nContent-Length: 4\r\n\r\nx'),/^HTTP\/1\.1 408 /);
  const body=await new Promise((resolve,reject)=>{
   const req=request({socketPath:endpoint,agent},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve(body));});
   req.on('error',reject);req.end();
  });
  assert.equal(body,'healthy');
 }finally{agent.destroy();await close();}
});

test('Windows HTTP closes its lifecycle when bridge startup fails',{skip:!windows,timeout:30000},async()=>{
 const endpoint=windowsEndpoint('http-startup-failure-'+process.pid);
 const owner=new Bridge('server',endpoint,()=>{});await owner.ready;
 const server=createServer();let closed=false;server.once('close',()=>closed=true);
 try {await assert.rejects(listenWindows(server,endpoint));assert.equal(closed,true);}
 finally {await owner.close();}
});
