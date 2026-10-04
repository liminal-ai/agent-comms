import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {StubComms,startStubServer} from '../../connector-stub/src/index.ts';
import {windowsEndpoint} from '../src/index.mjs';
const exec=promisify(execFile);
const release=fileURLToPath(new URL('../../../dist/agent-comms-'+(process.argv[2]??'0.1.1-windows-review4')+'/',import.meta.url));
const socket=windowsEndpoint('bundle-test-'+Date.now());
const comms=StubComms.fromFixture({machine:'local-bundle-fixture',participants:[{name:'local-a'},{name:'local-b'}]});
const server=await startStubServer({socketPath:socket,comms,pollWaitMs:20});
async function cli(args){return (await exec(process.execPath,[release+'comms.mjs','--socket',socket,...args],{windowsHide:true,timeout:20000})).stdout;}
try{
 const sent=await cli(['send','--as','local-a','@local-b','bundled-request']);
 const message=sent.match(/sent (m_\d+)/)[1],conversation=sent.match(/in (c_\d+)/)[1];
 await cli(['reply','--as','local-b',message,'bundled-reply']);
 assert.match(await cli(['read','--as','local-a',conversation]),/bundled-reply/);
 console.log('Bundled CLI send/reply/read: pass');
}finally{await server.close();}
