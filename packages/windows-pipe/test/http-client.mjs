import assert from 'node:assert/strict';
import {request} from 'node:http';
const socketPath=process.argv[2];
const response=await new Promise((resolve,reject)=>{
 const req=request({socketPath,path:'/comms/test',method:'POST',headers:{'content-type':'application/json'}},res=>{let text='';res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));});
 req.setTimeout(3000,()=>req.destroy(new Error('Pipe request timeout')));
 req.on('error',reject);req.end(JSON.stringify({probe:'node-http'}));
});
assert.deepEqual(response,{status:200,body:{ok:true,probe:'node-http'}});
console.log('Node HTTP over protected Windows pipe: pass');
