import path from 'node:path';
import os from 'node:os';
import { AuthStore } from '../src/auth.mjs';
import { Account } from '../src/account.mjs';
import { loadConfig } from '../src/config.mjs';
const config = await loadConfig(),
  auth = new AuthStore(config),
  account = new Account({ authStore: auth });
const source =
  process.argv[2] ||
  path.join(process.env.LOCALAPPDATA || os.homedir(), 'netease-cloud-uploader', 'session.dpapi');
try {
  await auth.importEncrypted(source);
  const status = await account.status();
  console.log(JSON.stringify({ imported: true, loggedIn: status.loggedIn, isVip: status.isVip }));
} finally {
  account.close();
}
