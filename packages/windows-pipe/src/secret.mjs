import {readFileSync} from 'node:fs';
import {powershellPath} from './runtime.mjs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
export function readPrivateWindowsSecret(path){return execFileSync(powershellPath(),['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./validate-secret.ps1',import.meta.url)),'-LiteralPath',path],{windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','pipe']});}

export function readCredential(path){return process.platform==='win32'?readPrivateWindowsSecret(path):readFileSync(path,'utf8');}
