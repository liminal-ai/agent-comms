import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {powershellPath} from '../src/runtime.mjs';
import {Bridge,windowsEndpoint} from '../src/index.mjs';
const exec=promisify(execFile);
const windows=process.platform==='win32';
for(const name of ['private-pipe.ps1','http-interop.ps1','secret-negative.ps1','secret.ps1','bridge.mjs','comms.mjs'])test(name,{skip:!windows,timeout:60000},async()=>{
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
