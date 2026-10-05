import {Agent} from 'node:http';
import {connectWindows} from './index.mjs';
const agents=new Map();
/** Reuse verified same-user connections; idle handles must not keep a CLI alive. */
export function createWindowsAgent(endpoint){
 let agent=agents.get(endpoint);if(agent)return agent;
 agent=new Agent({keepAlive:true,maxSockets:16,maxFreeSockets:2,timeout:5000});
 agent.createConnection=(_options,callback)=>connectWindows(endpoint,callback);
 const destroy=agent.destroy.bind(agent);agent.destroy=()=>{agents.delete(endpoint);destroy();};
 agents.set(endpoint,agent);return agent;
}
