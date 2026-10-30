import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { loadConfig } from '../src/config.mjs';
import { AuthStore } from '../src/auth.mjs';
import { Account } from '../src/account.mjs';
const config = await loadConfig(),
  auth = new AuthStore(config),
  account = new Account({ authStore: auth });
try {
  let status;
  try {
    status = await account.status();
  } catch (error) {
    if (!/LOGIN_REQUIRED/.test(error.code || error.message)) throw error;
  }
  if (!status?.loggedIn) {
    await stat(config.auth.loginHelper).catch(() => {
      throw new Error('Native login helper missing; see docs/登录与凭据.md');
    });
    const code = await new Promise((resolve, reject) => {
      const child = spawn(config.auth.loginHelper, [], {
        env: {
          ...process.env,
          NETEASE_MUSIC_STATE_DIR: config.stateDir,
          NETEASE_MUSIC_SESSION_FILE: config.auth.sessionFile,
        },
        stdio: 'ignore',
      });
      child.on('error', () => reject(new Error('Cannot start official-page login helper')));
      child.on('exit', resolve);
    });
    if (code === 11) throw new Error('Login cancelled by user');
    if (code !== 0)
      throw new Error(`Login helper failed (${code}); existing credentials were not removed`);
    auth.clear();
    status = await account.status();
  }
  console.log(
    JSON.stringify({ loggedIn: status.loggedIn, nickname: status.nickname, isVip: status.isVip })
  );
} finally {
  account.close();
}
