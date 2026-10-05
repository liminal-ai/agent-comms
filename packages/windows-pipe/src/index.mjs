import {powershellPath} from './runtime.mjs';
import {spawn,execFileSync} from 'node:child_process';
import {Duplex} from 'node:stream';
import {fileURLToPath} from 'node:url';
const script=fileURLToPath(new URL('./bridge.ps1',import.meta.url));
let sid;
export function windowsEndpoint(suffix='connector') {
 sid??=execFileSync(powershellPath(),['-NoProfile','-NonInteractive','-Command','[Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],{encoding:'utf8',windowsHide:true}).trim();
 if(!/^S-1-\d+(?:-\d+){1,15}$/.test(sid))throw Error('Unsupported Windows user SID');
 if(!/^[a-z0-9-]{1,64}$/.test(suffix))throw Error('Invalid pipe suffix');
 return `\\\\.\\pipe\\agent-comms-${sid}-${suffix}`;
}

function parseEndpoint(endpoint) {
 const base=windowsEndpoint('connector').slice(0,-'connector'.length);
 if(!endpoint.startsWith(base))throw Error('Pipe endpoint must belong to the current Windows user');
 const suffix=endpoint.slice(base.length);if(!/^[a-z0-9-]{1,64}$/.test(suffix))throw Error('Invalid pipe endpoint');return suffix;
}
class PipeSocket extends Duplex {
 constructor(bridge,id){super();this.bridge=bridge;this.id=id;this.pending=null;this.remoteAddress='local-pipe';this.encrypted=false;}
 _read(){if(this.readBlocked){this.readBlocked=false;this.bridge.send('B',this.id);}}
 _write(data,encoding,callback){this.touch();const chunks=[];for(let i=0;i<data.length;i+=32768)chunks.push(data.subarray(i,i+32768));this.pending={chunks,callback};this.next();}
 next(){const p=this.pending;if(!p)return;const chunk=p.chunks.shift();if(!chunk){this.pending=null;p.callback();return;}this.bridge.send('D',this.id,chunk.toString('base64'));}
 _final(callback){callback();this.destroy();}
 _destroy(error,callback){clearTimeout(this.idleTimer);this.bridge.sockets.delete(this.id);this.bridge.send('C',this.id);if(this.pending){const p=this.pending;this.pending=null;p.callback(error??Object.assign(Error('Pipe closed'),{code:'ECONNRESET'}));}callback(error);}
 touch(){clearTimeout(this.idleTimer);if(this.timeoutMs){this.idleTimer=setTimeout(()=>this.emit('timeout'),this.timeoutMs);this.idleTimer.unref();}}
 setTimeout(ms,callback){this.timeoutMs=ms;if(callback){if(ms===0)this.removeListener('timeout',callback);else this.once('timeout',callback);}this.touch();return this;}
 setNoDelay(){return this;}
 setKeepAlive(){return this;}
 ref(){if(this.bridge.mode==='client'){this.bridge.child.ref();for(const stream of this.bridge.child.stdio)stream?.ref?.();}return this;} unref(){if(this.bridge.mode==='client'){this.bridge.child.unref();for(const stream of this.bridge.child.stdio)stream?.unref?.();}return this;}
}
export class Bridge {
 constructor(mode,endpoint,onConnection,onFailure){
  this.onFailure=onFailure;this.started=false;this.closing=false;
  this.mode=mode;this.sockets=new Map();this.closed=false;this.buffer='';this.stderr='';
  this.child=spawn(powershellPath(),['-NoProfile','-NonInteractive','-File',script,'-Mode',mode,'-Suffix',parseEndpoint(endpoint)],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  this.ready=new Promise((resolve,reject)=>{this.resolve=resolve;this.reject=reject});
  this.timer=setTimeout(()=>this.fail(Error('Windows pipe bridge startup timed out')),15000);
  this.child.stdout.setEncoding('utf8');this.child.stdout.on('data',chunk=>{try{this.buffer+=chunk;let end;while((end=this.buffer.indexOf('\n'))>=0){const line=this.buffer.slice(0,end).replace(/\r$/,'');this.buffer=this.buffer.slice(end+1);this.frame(line,onConnection);}if(this.buffer.length>50000)throw Error('Oversized bridge frame');}catch(error){this.fail(error)}});
  this.child.stderr.on('data',chunk=>{this.stderr=(this.stderr+chunk).slice(-4000)});
  this.child.on('error',error=>this.fail(error));
  this.child.on('exit',code=>this.fail(Error(`Windows pipe bridge exited ${code}: ${this.stderr.trim()}`)));
  this.child.stdin.on('error',error=>this.fail(error));
 }
 send(op,id,data=''){if(!this.closed)this.child.stdin.write(`${op}\t${id}\t${data}\n`);}
 frame(line,onConnection){if(line.length>50000)throw Error('Oversized bridge frame');const [op,key,data='']=line.split('\t');const id=Number(key);if(!Number.isSafeInteger(id))throw Error('Invalid bridge frame');
  if(op==='R'){this.started=true;clearTimeout(this.timer);this.resolve();return;}
  if(op==='O'){const socket=new PipeSocket(this,id);this.sockets.set(id,socket);socket.on('error',()=>{});clearTimeout(this.timer);this.resolve(socket);onConnection?.(socket);return;}
  if(op==='E'){const error=Error('Windows pipe connection failed: '+data);error.code=['ECONNREFUSED','ENOENT','EACCES','EIO'].includes(data)?data:'EIO';this.fail(error);return;}
  const socket=this.sockets.get(id);if(!socket)return;
  if(op==='D'){socket.touch();if(socket.push(Buffer.from(data,'base64')))this.send('B',id);else socket.readBlocked=true;return;}
  if(op==='A'){socket.next();return;}
  if(op==='C'){socket.push(null);socket.destroy();return;}throw Error('Unknown bridge frame');
 }
 fail(error){
  if(this.closed)return;this.closed=true;clearTimeout(this.timer);this.reject(error);
  // An opened pipe may already have delivered a keyed send. Report connection
  // loss so callers retry with the same key; keep startup failures unchanged.
  const lost=Object.assign(new Error(error.message,{cause:error}),{code:'ECONNRESET'});
  for(const socket of this.sockets.values())socket.destroy(lost);
  this.sockets.clear();this.child.stdin.destroy();this.child.kill();if(this.started&&!this.closing)queueMicrotask(()=>this.onFailure?.(error));
 }
 async close(){if(this.closed)return;this.closing=true;const exit=new Promise(resolve=>this.child.once('exit',resolve));for(const socket of this.sockets.values())socket.destroy();this.child.stdin.end();const timer=setTimeout(()=>this.child.kill(),3000);await exit;clearTimeout(timer);}
}
export async function listenWindows(server,endpoint){
 // HTTP initializes header/request deadline tracking on 'listening'. Initialize
 // before the helper can deliver a connection, even though no net.Server listens.
 let httpClose;
 const closeHttp=()=>httpClose??=new Promise(resolve=>{
  // HTTP close cleans its tracker; net.Server reports NOT_RUNNING because the
  // pipe bridge owns the listener. Its close callback still signals cleanup.
  server.close(()=>resolve());
 });
 server.emit('listening');
 let bridge;
 try {
  bridge=new Bridge('server',endpoint,socket=>server.emit('connection',socket),error=>{
   void closeHttp();server.emit('error',error);
  });
  await bridge.ready;
 } catch(error) {await closeHttp();throw error;}
 return async()=>{try{await bridge.close();}finally{await closeHttp();}};
}
export function connectWindows(endpoint,callback){const bridge=new Bridge('client',endpoint);bridge.ready.then(socket=>{socket.once('close',()=>bridge.close());callback(null,socket)},error=>callback(error));}
