import {isAbsolute,win32} from 'node:path';
import {existsSync} from 'node:fs';
export function powershellPath(){
 const configured=process.env.AGENT_COMMS_POWERSHELL;
 const path=configured??win32.join(process.env.ProgramFiles??'C:\\Program Files','PowerShell','7','pwsh.exe');
 if(!isAbsolute(path)||!existsSync(path))throw Error('Set AGENT_COMMS_POWERSHELL to an installed, trusted absolute PowerShell 7 executable path');
 return path;
}
