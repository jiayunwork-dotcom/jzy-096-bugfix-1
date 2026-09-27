import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import test from 'node:test';
import { createApp } from '../src/app';

let baseUrl: string;
let close: () => Promise<void>;

test.before(async () => {
  const server = createApp().listen(0);
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  close = () => new Promise<void>((resolve) => server.close(() => resolve()));
});

test.after(async () => {
  await close();
});

async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

const diamond = {
  graph: {
    nodes: ['S', 'A', 'B', 'T'],
    edges: [
      { from: 'S', to: 'A', weight: 1 },
      { from: 'A', to: 'B', weight: 1 },
      { from: 'B', to: 'A', weight: 1 },
      { from: 'A', to: 'T', weight: 5 },
      { from: 'S', to: 'T', weight: 10 },
    ],
  },
  source: 'S',
  target: 'T',
};

test('GET /health responds ok', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'ok' });
});

test('POST /shortest-path without restrictions', async () => {
  const { status, json } = await post('/shortest-path', { ...diamond, restrictions: [] });
  assert.equal(status, 200);
  assert.deepEqual(json, { source: 'S', target: 'T', reachable: true, distance: 6, path: ['S', 'A', 'T'] });
});

test('POST /shortest-path with a turn restriction reroutes correctly', async () => {
  const { status, json } = await post('/shortest-path', {
    ...diamond,
    restrictions: [{ from: 'S', via: 'A', to: 'T' }],
  });
  assert.equal(status, 200);
  assert.equal(json.distance, 8);
  assert.deepEqual(json.path, ['S', 'A', 'B', 'A', 'T']);
});

test('POST /shortest-path reports unreachable explicitly', async () => {
  const { status, json } = await post('/shortest-path', {
    graph: {
      nodes: ['a', 'b'],
      edges: [{ from: 'a', to: 'a', weight: 1 }],
    },
    source: 'a',
    target: 'b',
    restrictions: [],
  });
  assert.equal(status, 200);
  assert.deepEqual(json, { source: 'a', target: 'b', reachable: false, distance: null, path: [] });
});

test('POST /shortest-path with source == target', async () => {
  const { status, json } = await post('/shortest-path', { ...diamond, source: 'A', target: 'A', restrictions: [] });
  assert.equal(status, 200);
  assert.deepEqual(json, { source: 'A', target: 'A', reachable: true, distance: 0, path: ['A'] });
});

test('POST /compare returns both scenarios and the detour cost', async () => {
  const { status, json } = await post('/compare', {
    ...diamond,
    restrictions: [{ from: 'S', via: 'A', to: 'T' }],
  });
  assert.equal(status, 200);
  assert.equal(json.withRestrictions.distance, 8);
  assert.equal(json.withoutRestrictions.distance, 6);
  assert.equal(json.delta, 2);
});

test('GET /sample: banned left turn makes the detour strictly longer', async () => {
  const res = await fetch(`${baseUrl}/sample`);
  assert.equal(res.status, 200);
  const json: any = await res.json();
  assert.equal(json.comparison.withoutRestrictions.distance, 4);
  assert.deepEqual(json.comparison.withoutRestrictions.path, ['A', 'B', 'E', 'F', 'I']);
  assert.equal(json.comparison.withRestrictions.distance, 8);
  assert.deepEqual(json.comparison.withRestrictions.path, ['A', 'B', 'E', 'H', 'I']);
  assert.equal(json.comparison.delta, 4);
});

test('two bans on the same approach both apply via /shortest-path and /compare', async () => {
  // 直接拿 GET /sample 返回的 graph 原样作为输入：
  // (B,E,F) 与 (B,E,H) 同时生效后只能绕外圈，长度 12，delta 8。
  const sampleRes = await fetch(`${baseUrl}/sample`);
  const sample: any = await sampleRes.json();
  const body = {
    graph: sample.graph,
    source: 'A',
    target: 'I',
    restrictions: [
      { from: 'B', via: 'E', to: 'F' },
      { from: 'B', via: 'E', to: 'H' },
    ],
  };
  const bannedTriples = new Set(body.restrictions.map((r) => JSON.stringify([r.from, r.via, r.to])));

  const sp = await post('/shortest-path', body);
  assert.equal(sp.status, 200);
  assert.deepEqual(sp.json, {
    source: 'A',
    target: 'I',
    reachable: true,
    distance: 12,
    path: ['A', 'D', 'G', 'H', 'I'],
  });
  for (let i = 1; i + 1 < sp.json.path.length; i++) {
    assert.ok(
      !bannedTriples.has(JSON.stringify([sp.json.path[i - 1], sp.json.path[i], sp.json.path[i + 1]])),
      `shortest-path result uses a banned turn: ${JSON.stringify(sp.json.path)}`,
    );
  }

  const cmp = await post('/compare', body);
  assert.equal(cmp.status, 200);
  assert.equal(cmp.json.withRestrictions.reachable, true);
  assert.equal(cmp.json.withRestrictions.distance, 12);
  assert.deepEqual(cmp.json.withRestrictions.path, ['A', 'D', 'G', 'H', 'I']);
  assert.equal(cmp.json.withoutRestrictions.distance, 4);
  assert.deepEqual(cmp.json.withoutRestrictions.path, ['A', 'B', 'E', 'F', 'I']);
  assert.equal(cmp.json.delta, 8);
});

test('invalid inputs are rejected with 400 and a reason', async () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ['unknown node in edge', { ...diamond, graph: { nodes: ['a'], edges: [{ from: 'a', to: 'b', weight: 1 }] } }, /unknown node "b"/],
    ['negative weight', { ...diamond, graph: { nodes: ['a', 'b'], edges: [{ from: 'a', to: 'b', weight: -2 }] } }, /non-positive weight/],
    ['unknown source', { ...diamond, source: 'ghost' }, /source references unknown node/],
    ['restriction on missing edge', { ...diamond, restrictions: [{ from: 'T', via: 'S', to: 'A' }] }, /non-existent edge T→S/],
  ];
  for (const [name, body, pattern] of cases) {
    const { status, json } = await post('/shortest-path', body);
    assert.equal(status, 400, `${name}: expected 400, got ${status}`);
    assert.match(json.error, pattern, `${name}: unexpected message ${json.error}`);
  }
});

test('malformed JSON body gets a 400', async () => {
  const res = await fetch(`${baseUrl}/shortest-path`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(res.status, 400);
  const json: any = await res.json();
  assert.match(json.error, /not valid JSON/);
});

test('concurrent queries are isolated and all correct', async () => {
  // 交错发起「带禁转」与「不带禁转」的请求，各自的搜索状态必须互不干扰。
  const jobs = Array.from({ length: 40 }, (_, i) => {
    const restricted = i % 2 === 0;
    return post('/shortest-path', {
      ...diamond,
      restrictions: restricted ? [{ from: 'S', via: 'A', to: 'T' }] : [],
    }).then(({ status, json }) => {
      assert.equal(status, 200);
      assert.equal(json.distance, restricted ? 8 : 6, `job ${i} got wrong distance`);
    });
  });
  await Promise.all(jobs);
});
