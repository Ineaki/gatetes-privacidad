import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { credentials } from '../src/server.mjs';
import { control } from './control.mjs';

if(process.platform!=='win32') throw Error('Windows installer; use CLI serve on other systems');
const c=config(),store=new Store(c);store.close();credentials(c);
const account=execFileSync('whoami.exe',[],{encoding:'utf8',windowsHide:true}).trim();
execFileSync('icacls.exe',[c.vault,'/inheritance:r','/grant:r',`${account}:(OI)(CI)F`,'*S-1-5-18:(OI)(CI)F'],{stdio:'pipe',windowsHide:true});
if(process.argv.includes('--autostart')) {
  const cli=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../src/cli.mjs');
  const launcher=path.join(c.vault,'startup.vbs');
  const vbsQuote=value=>'"'+value.replaceAll('"','""')+'"';
  const q=String.fromCharCode(34);
  const command=`${q}${process.execPath}${q} ${q}${cli}${q} serve`;
  const content=`Set sh = CreateObject("WScript.Shell")\r\nsh.Environment("PROCESS")("AGENT_VAULT") = ${vbsQuote(c.vault)}\r\nsh.Environment("PROCESS")("AGENT_REPO") = ${vbsQuote(c.repo)}\r\nsh.Run ${vbsQuote(command)}, 0, False\r\n`;
  fs.writeFileSync(launcher,content,{mode:0o600});
  // Fixed COM setup command; paths are passed through environment, never interpolated into shell code.
  const setup="$p=Join-Path ([Environment]::GetFolderPath('Startup')) 'Gatetes Local Agents.lnk'; if(Test-Path -LiteralPath $p){throw 'Startup shortcut exists; inspect before replacing'}; $s=(New-Object -ComObject WScript.Shell).CreateShortcut($p); $s.TargetPath=Join-Path $env:WINDIR 'System32/wscript.exe'; $s.Arguments='\"'+$env:AGENT_LAUNCHER+'\"'; $s.WindowStyle=7; $s.Save()";
  execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',setup],{env:{...process.env,AGENT_LAUNCHER:launcher},windowsHide:true,stdio:'pipe'});
  console.log('Current-user startup shortcut installed. Windows execution policy unchanged.');
}
await control('start',c);
