import assert from 'node:assert/strict';
import {createServer,request,Agent} from 'node:http';
import {windowsEndpoint,listenWindows,connectWindows} from '../src/index.mjs';
const endpoint=windowsEndpoint('bridge-test-'+Date.now());
let release;const gate=new Promise(resolve=>release=resolve);
const server=createServer(async(req,res)=>{if(req.url==='/slow')await gate;if(req.url==='/fast')release();res.end(req.url==='/large'?'x'.repeat(1048576):req.url);});
const close=await listenWindows(server,endpoint);
const agent=new Agent({keepAlive:false});agent.createConnection=(_options,callback)=>connectWindows(endpoint,callback);
function call(path){return new Promise((resolve,reject)=>{const req=request({socketPath:endpoint,path,agent},res=>{let body='';res.on('data',x=>body+=x);res.on('end',()=>resolve(body));});req.setTimeout(10000,()=>req.destroy(Error('timeout')));req.on('error',reject);req.end();});}
try {
 const results=await Promise.all(['/slow','/fast','/third'].map(call));assert.deepEqual(results,['/slow','/fast','/third']);
 assert.equal((await call('/large')).length,1048576);
 console.log('Concurrent identity-checked Node HTTP bridge: pass');
}finally{agent.destroy();await close();}
