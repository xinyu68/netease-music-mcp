import path from 'node:path';
import { projectRoot } from '../src/config.mjs';
console.log(
  `[mcp_servers.netease_music]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(path.join(projectRoot, 'src/server.mjs'))}]\nstartup_timeout_sec = 15\ntool_timeout_sec = 60`
);
