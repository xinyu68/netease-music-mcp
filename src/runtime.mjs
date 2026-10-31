import { Account } from './account.mjs';
import { AuthStore } from './auth.mjs';
import { ApiClient } from './api-client.mjs';
import { NeteaseCatalog } from './netease.mjs';
import { MediaResolver } from './media-source.mjs';
import { MpvEngine } from './mpv-engine.mjs';
import { PlaybackController } from './playback-controller.mjs';
import { PlaybackPreferences } from './playback-preferences.mjs';
export function createRuntime(config) {
  const auth = new AuthStore(config),
    worker = new ApiClient(config.api),
    account = new Account({ authStore: auth, worker, apiClient: worker.proxy() }),
    catalog = new NeteaseCatalog();
  const engine = new MpvEngine(config),
    resolver = new MediaResolver(account),
    preferences = new PlaybackPreferences(config.stateDir),
    player = new PlaybackController({ engine, resolver, catalog, config, preferences });
  return {
    config,
    auth,
    account,
    catalog,
    engine,
    player,
    async close() {
      await player.close();
      worker.close();
      auth.clear();
    },
  };
}
