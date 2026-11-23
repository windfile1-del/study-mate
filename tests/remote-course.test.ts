import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { RemoteCourseMedia, courseCdn } from '../apps/desktop/src/core/remote-course';
import { SourceRegistry } from '../apps/desktop/src/core/sources';
import { workspace } from './helpers';

test('Prepared course tracks retain real cid and desktop credentials, enforce Range, expiry and every redirect', async (t) => {
  const dir = await workspace(t),
    sources = new SourceRegistry(path.join(dir, 'sources.json'));
  await sources.initialize();
  t.after(() => sources.flush());
  const id = sources.bind('https://www.bilibili.com/video/BV1CAxaeHEeH/?p=2').sourceId;
  let now = 1000,
    redirect = false;
  let videoUrl = 'https://cdn.bilivideo.com/video?private-signed-query';
  const fetched: string[] = [];
  const course = new RemoteCourseMedia(
    async (url, init) => {
      fetched.push(url);
      assert.equal(new Headers(init.headers).get('referer'), 'https://www.bilibili.com/');
      assert.equal(new Headers(init.headers).get('authorization'), null);
      if (url.includes('/x/web-interface/view'))
        return Response.json({
          code: 0,
          data: {
            pages: [
              { page: 1, cid: 10 },
              { page: 2, cid: 24680, duration: 500 },
            ],
          },
        });
      if (url.includes('/x/player/playurl')) {
        assert.equal(new URL(url).searchParams.get('cid'), '24680');
        return Response.json({
          code: 0,
          data: {
            dash: {
              duration: 500,
              video: [
                { codecid: 7, baseUrl: videoUrl, height: 720 },
              ],
              audio: [
                { codecs: 'mp4a.40.2', baseUrl: 'https://cdn.bilivideo.com/audio?private-signed-query' },
              ],
            },
          },
        });
      }
      assert.equal(init.redirect, 'manual');
      assert.equal(new Headers(init.headers).get('range'), 'bytes=0-3');
      return redirect
        ? new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } })
        : new Response('abcd', {
            status: 206,
            headers: {
              'content-range': 'bytes 0-3/100',
              'content-length': '4',
              'content-type': 'video/mp4',
              'set-cookie': 'must-not-forward',
            },
          });
    },
    (id) => sources.get(id),
    () => now,
  );
  const descriptor = await course.prepare(id);
  assert.equal(descriptor.kind, 'separate');
  assert.equal(descriptor.tracks.length, 2);
  assert.doesNotMatch(JSON.stringify(descriptor), /bilivideo|private-signed-query/);
  videoUrl = 'https://cdn.bilivideo.com/video?new-signature';
  const rotated = await course.prepare(id);
  assert.notEqual(rotated.tracks[0].path, descriptor.tracks[0].path);
  assert.equal(rotated.tracks[0].cacheKey, descriptor.tracks[0].cacheKey);
  videoUrl = 'https://cdn.bilivideo.com/video-1080?new-signature';
  assert.notEqual((await course.prepare(id)).tracks[0].cacheKey, descriptor.tracks[0].cacheKey);
  const trackId = descriptor.tracks[0].path.split('/').at(-1)!;
  const track = await course.read(id, trackId, 'bytes=0-3', false, new AbortController().signal);
  const bytes: Buffer[] = [];
  for await (const chunk of track.body!) bytes.push(Buffer.from(chunk));
  assert.equal(Buffer.concat(bytes).toString(), 'abcd');
  assert.equal(track.status, 206);
  assert.equal(track.headers['content-range'], 'bytes 0-3/100');
  assert.equal(track.headers['set-cookie'], undefined);
  await assert.rejects(
    course.read(id, trackId, 'bytes=0-1,3-4', false, new AbortController().signal),
    /单段/,
  );
  redirect = true;
  await assert.rejects(course.read(id, trackId, 'bytes=0-3', false, new AbortController().signal), /未授权/);
  assert.ok(!fetched.some((url) => url.includes('127.0.0.1')));
  now += 600001;
  await assert.rejects(course.read(id, trackId, undefined, false, new AbortController().signal), /过期/);
  for (const url of [
    'invalid',
    'http://cdn.bilivideo.com/a',
    'https://bilivideo.com.attacker.test/a',
    'https://user@cdn.bilivideo.com/a',
    'https://cdn.bilivideo.com:444/a',
  ])
    assert.equal(courseCdn(url), false);
  const blocked = new RemoteCourseMedia(
    async () => {
      throw Error('net::ERR_BLOCKED_BY_CLIENT');
    },
    (id) => sources.get(id),
  );
  await assert.rejects(
    blocked.prepare(id),
    (error: any) => error.code === 'BILI_NETWORK' && !error.message.includes('ERR_BLOCKED_BY_CLIENT'),
  );
});
