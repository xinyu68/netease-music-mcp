import test from 'node:test';
import assert from 'node:assert/strict';
import { MpvEngine } from '../src/mpv-engine.mjs';
import { validateConfig } from '../src/config.mjs';

test('cancellation between IPC acknowledgements cannot load a stopped source or unpause after a cancelled seek', async () => {
  for (const stage of ['pause', 'seek']) {
    const engine = new MpvEngine(validateConfig());
    const abort = new AbortController();
    const commands = [];
    const source = { url: 'https://m801.music.126.net/test.mp3' };
    engine.start = async () => {};
    engine.snapshot = async () => ({ idle: false, duration: 180, audioReady: true });
    engine.property = async () => source.url;
    engine.command = async (command) => {
      commands.push(command);
      if (
        (stage === 'pause' && command[1] === 'pause') ||
        (stage === 'seek' && command[0] === 'seek')
      )
        abort.abort();
    };
    await assert.rejects(
      engine.load(source, { position: 10, generation: 1, signal: abort.signal }),
      (error) => error.code === 'CANCELLED'
    );
    assert.ok(!commands.some((command) => command[1] === 'pause' && command[2] === false));
    if (stage === 'pause') assert.ok(!commands.some((command) => command[0] === 'loadfile'));
  }
});
