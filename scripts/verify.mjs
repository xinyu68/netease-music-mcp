import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

// This opt-in acceptance test produces sound and uses the current account.
const client = new Client({ name: 'netease-direct-acceptance', version: '0.2.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../src/server.mjs', import.meta.url))],
  stderr: 'pipe',
});
transport.stderr?.on('data', () => {});
const report = {
  observedAt: new Date().toISOString(),
  platform: process.platform,
  backend: 'direct-mpv',
  requiresNeteaseClient: false,
  credentialsRecorded: false,
  physicalEspTested: false,
  calls: [],
};
async function call(name, args = {}) {
  const start = Date.now();
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
  const data = JSON.parse(
    result.content
      .filter((x) => x.type === 'text')
      .map((x) => x.text)
      .join('\n')
  );
  report.calls.push({ name, elapsedMs: Date.now() - start, passed: !result.isError });
  if (result.isError) throw new Error(`${name}: ${data.code}`);
  return data;
}
const mutate = (name, args = {}) => call(name, { ...args, requestId: randomUUID() });
async function waitFor(predicate, timeout = 20000) {
  const end = Date.now() + timeout;
  do {
    const s = await call('netease_status');
    if (predicate(s)) return s;
    await delay(300);
  } while (Date.now() < end);
  throw new Error('Playback state did not reach the expected transition');
}
let connected = false;
try {
  await client.connect(transport);
  connected = true;
  report.toolNames = (await client.listTools()).tools.map((t) => t.name);
  assert.equal(report.toolNames.length, 20);
  const account = await call('netease_account_status');
  assert.equal(account.loggedIn, true);
  report.account = { loggedIn: account.loggedIn, isVip: account.isVip, vipType: account.vipType };
  const lists = await call('netease_playlists');
  const liked = await call('netease_liked_songs', { limit: 100 });
  assert.ok(liked.total > 1);
  report.liked = { total: liked.total, firstPageCount: liked.songs.length, more: liked.more };
  const page = await call('netease_playlist_tracks', {
    playlistId: liked.playlistId,
    offset: 1,
    limit: 2,
  });
  assert.equal(page.songs[0].id, liked.songs[1].id);
  const selected = liked.songs.find(
    (s) => s.available && (account.isVip ? s.fee === 1 : s.fee === 0)
  );
  assert.ok(selected, 'No suitable full-track candidate in the first liked page');
  assert.ok(
    (await call('netease_search', { query: `${selected.title} ${selected.artists[0]}`, limit: 5 }))
      .length
  );
  assert.equal((await call('netease_song_detail', { songId: selected.id })).id, selected.id);
  report.lyricLineCount = (await call('netease_lyrics', { songId: selected.id })).lyrics.length;
  await call('netease_launch');
  await mutate('netease_volume', { volume: 15 });
  const playing = await mutate('netease_play', { songId: selected.id });
  assert.equal(playing.playing, true);
  assert.equal(playing.verified, true);
  const paused = await mutate('netease_pause');
  assert.equal(paused.paused, true);
  assert.equal((await mutate('netease_pause')).changed, false);
  await delay(700);
  assert.ok(Math.abs((await call('netease_status')).position - paused.position) < 0.15);
  const sought = await mutate('netease_seek', { seconds: 10 });
  assert.equal(sought.paused, true);
  assert.ok(Math.abs(sought.position - 10) < 0.35);
  await mutate('netease_seek', { seconds: 0 });
  assert.equal((await mutate('netease_resume')).playing, true);
  console.log(JSON.stringify({ stage: 'direct-stream-pause-seek-resume-passed' }));
  // Real uninterrupted playback past 30 seconds, not a seek masquerading as playback.
  const beyond = await waitFor(
    (s) => s.playing && s.songId === selected.id && s.position >= 32,
    45000
  );
  report.playback = {
    songId: selected.id,
    fee: selected.fee,
    format: beyond.format,
    bitrate: beyond.bitrate,
    verified: beyond.verified,
    position: beyond.position,
    duration: beyond.duration,
    playedBeyond30Seconds: true,
    wholeTrackCompletionTested: false,
  };
  await mutate('netease_seek', { seconds: beyond.duration - 0.7 });
  await waitFor((s) => s.phase === 'ended');
  report.singleTrackEofAfterSeek = true;
  const collection = await mutate('netease_play_liked');
  assert.equal(collection.queue.length, liked.total);
  assert.equal(collection.songId, liked.songs[0].id);
  assert.equal((await call('netease_queue')).index, 0);
  assert.equal((await mutate('netease_next')).songId, liked.songs[1].id);
  const previous = await mutate('netease_previous');
  assert.equal(previous.songId, liked.songs[0].id);
  await mutate('netease_seek', { seconds: previous.duration - 0.7 });
  await waitFor(
    (s) => s.phase === 'playing' && s.queue.index === 1 && s.songId === liked.songs[1].id
  );
  report.queue = {
    length: collection.queue.length,
    next: true,
    previous: true,
    autoAdvanceAfterSeek: true,
  };
  assert.ok(lists.playlists.some((p) => p.id === liked.playlistId));
  assert.equal(
    (await mutate('netease_play_playlist', { playlistId: liked.playlistId })).queue.length,
    liked.total
  );
  const stopped = await mutate('netease_stop');
  assert.equal(stopped.phase, 'stopped');
  assert.equal(stopped.position, 0);
  assert.equal(stopped.playing, false);
  report.stoppedAndUnloaded = true;
  assert.equal(new Set(report.calls.map((c) => c.name)).size, 20);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error =
    error instanceof assert.AssertionError
      ? 'ACCEPTANCE_ASSERTION_FAILED'
      : /^netease_\w+: [A-Z_]+$/.test(error.message)
        ? error.message
        : 'ACCEPTANCE_FAILED';
  process.exitCode = 1;
} finally {
  if (connected)
    try {
      await mutate('netease_stop');
    } catch {}
  const serverPid = transport.pid;
  await client.close();
  await delay(700);
  try {
    process.kill(serverPid, 0);
    report.serverExited = false;
  } catch {
    report.serverExited = true;
  }
  if (!report.serverExited) {
    report.passed = false;
    process.exitCode = 1;
  }
  await mkdir(new URL('../evidence/', import.meta.url), { recursive: true });
  await writeFile(
    new URL('../evidence/direct-live.json', import.meta.url),
    JSON.stringify(report, null, 2)
  );
  console.log(
    JSON.stringify(
      {
        passed: report.passed,
        tools: new Set(report.calls.map((c) => c.name)).size,
        playback: report.playback,
        queue: report.queue,
        serverExited: report.serverExited,
        error: report.error,
        evidence: 'evidence/direct-live.json',
      },
      null,
      2
    )
  );
}
