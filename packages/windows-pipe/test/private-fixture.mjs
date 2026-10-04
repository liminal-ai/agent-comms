import {mkdtemp,writeFile,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {powershellPath} from '../src/runtime.mjs';
export async function privateFixture(content){
 const dir=await mkdtemp(join(tmpdir(),'comms-private-fixture-'));
 const path=join(dir,'fixture.txt');
 const cleanup=async()=>{await unlink(path).catch(error=>{if(error.code!=='ENOENT')throw error;});await rmdir(dir);};
 try{
  await writeFile(path,content,{flag:'wx',mode:0o600});
  if(process.platform==='win32')execFileSync(powershellPath(),['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./private-fixture.ps1',import.meta.url)),'-LiteralPath',path],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  return {path,cleanup};
 }catch(error){await cleanup();throw error;}
}
