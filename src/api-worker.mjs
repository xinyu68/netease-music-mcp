import { createRequire } from 'node:module';
for (const method of ['log', 'warn', 'error']) console[method] = () => {};
process.env.DOTENV_CONFIG_QUIET = 'true';
const api = createRequire(import.meta.url)('@neteasecloudmusicapienhanced/api');
const allowed = new Set([
  'login_status',
  'user_account',
  'user_playlist',
  'playlist_detail',
  'song_detail',
  'song_url_v1',
  'lyric',
  'cloudsearch',
]);
process.on('message', async (message) => {
  if (!message || !allowed.has(message.method) || !Number.isInteger(message.id)) return;
  try {
    const result = await api[message.method]({
      ...message.params,
      unblock: 'false',
      timestamp: Date.now(),
    });
    process.send?.({ id: message.id, ok: true, body: result.body || result });
  } catch (error) {
    process.send?.({
      id: message.id,
      ok: false,
      code: Number(error?.body?.code) || Number(error?.status) || 0,
    });
  }
});
process.on('disconnect', () => process.exit(0));
