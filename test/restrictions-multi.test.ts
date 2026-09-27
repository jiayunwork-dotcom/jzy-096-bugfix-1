/**
 * 同一进入方向上多条禁转规则的回归测试。
 *
 * 历史缺陷：RestrictionSet 曾把每个进入方向只映射到「一个」被禁出口，
 * 同一 (from, via) 上写多条规则时后写的覆盖先写的，被覆盖的转向被放行，
 * compare 算出的绕行代价也跟着变成 0。这里用固定算例 + 随机图两条防线覆盖。
 */

import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import test from 'node:test';
import { createApp } from '../src/app';
import { compareScenarios } from '../src/compare';
import { shortestPath } from '../src/dijkstra';
import { Edge, Graph, NodeId } from '../src/graph';
import { RestrictionSet, TurnRestriction } from '../src/restrictions';
import { buildSample } from '../src/sample';
import { assertValidPath, mulberry32, randomGraph } from './helpers';

/** 路径中是否出现了任一禁转规则所禁止的连续三元组。 */
function findBannedTriple(path: NodeId[], restrictions: TurnRestriction[]): NodeId[] | null {
  const bannedKeys = new Set(restrictions.map((r) => `${r.from}>${r.via}>${r.to}`));
  for (let i = 1; i + 1 < path.length; i++) {
    const key = `${path[i - 1]}>${path[i]}>${path[i + 1]}`;
    if (bannedKeys.has(key)) return [path[i - 1], path[i], path[i + 1]];
  }
  return null;
}

function assertNoBannedTriple(path: NodeId[], restrictions: TurnRestriction[]): void {
  const triple = findBannedTriple(path, restrictions);
  assert.equal(
    triple,
    null,
    `path ${JSON.stringify(path)} contains banned turn ${JSON.stringify(triple)}`,
  );
}

test('fixed case: two bans on the same approach both take effect (A-I grid)', () => {
  const sample = buildSample();
  const restrictions: TurnRestriction[] = [
    { from: 'B', via: 'E', to: 'F' },
    { from: 'B', via: 'E', to: 'H' },
  ];

  const result = shortestPath(sample.graph, sample.source, sample.target, new RestrictionSet(restrictions));

  assert.equal(result.reachable, true);
  // 从 B 进 E 后既不能去 F 也不能去 H，外圈绕行长度 12。
  assert.equal(result.distance, 12);
  assert.deepEqual(result.path, ['A', 'D', 'G', 'H', 'I']);
  assertNoBannedTriple(result.path, restrictions);
  assertValidPath(sample.graph, result.path, sample.source, sample.target, result.distance!);
});

test('fixed case: /compare agrees with /shortest-path and reports delta 8', () => {
  const sample = buildSample();
  const restrictions: TurnRestriction[] = [
    { from: 'B', via: 'E', to: 'F' },
    { from: 'B', via: 'E', to: 'H' },
  ];

  const direct = shortestPath(sample.graph, 'A', 'I', new RestrictionSet(restrictions));
  const cmp = compareScenarios(sample.graph, 'A', 'I', restrictions);

  assert.equal(cmp.withRestrictions.reachable, direct.reachable);
  assert.equal(cmp.withRestrictions.distance, direct.distance);
  assert.deepEqual(cmp.withRestrictions.path, direct.path);
  assert.equal(cmp.withoutRestrictions.distance, 4);
  assert.deepEqual(cmp.withoutRestrictions.path, ['A', 'B', 'E', 'F', 'I']);
  assert.equal(cmp.delta, 8);
  assertNoBannedTriple(cmp.withRestrictions.path, restrictions);
});

test('single bans on the same approach keep their original behavior', () => {
  const sample = buildSample();

  const onlyF = shortestPath(sample.graph, 'A', 'I', new RestrictionSet([{ from: 'B', via: 'E', to: 'F' }]));
  assert.equal(onlyF.distance, 8);
  assert.deepEqual(onlyF.path, ['A', 'B', 'E', 'H', 'I']);

  const onlyH = shortestPath(sample.graph, 'A', 'I', new RestrictionSet([{ from: 'B', via: 'E', to: 'H' }]));
  assert.equal(onlyH.distance, 4);
  assert.deepEqual(onlyH.path, ['A', 'B', 'E', 'F', 'I']);

  // 同一进入方向、但规则落在不同进入方向上时结果不变。
  const differentApproach = shortestPath(
    sample.graph,
    'A',
    'I',
    new RestrictionSet([
      { from: 'B', via: 'E', to: 'F' },
      { from: 'D', via: 'E', to: 'F' },
    ]),
  );
  assert.equal(differentApproach.distance, 8);
  assert.deepEqual(differentApproach.path, ['A', 'B', 'E', 'H', 'I']);
});

test('banning every exit of an approach blocks that approach, not the whole intersection', () => {
  // 从 s 进 v 的两个出口 v→a、v→b 全禁后：
  //  - 从 s 方向进 v 只能折返 v→s，再进 v 还是走不掉 → 不可达（不报错、也不放行）；
  //  - 从另一个进入方向 x→v 进 v 不受这组规则影响。
  // 图的布局：s 唯一的出路是 s→v；x 也能进 v，但 s 到不了 x。
  const graph = new Graph(
    ['s', 'v', 'a', 'b', 'x'],
    [
      { from: 's', to: 'v', weight: 1 },
      { from: 'v', to: 's', weight: 1 },
      { from: 'v', to: 'a', weight: 1 },
      { from: 'v', to: 'b', weight: 1 },
      { from: 'x', to: 'v', weight: 1 },
      { from: 'a', to: 'x', weight: 100 },
    ],
  );
  const restrictions: TurnRestriction[] = [
    { from: 's', via: 'v', to: 'a' },
    { from: 's', via: 'v', to: 'b' },
  ];

  const result = shortestPath(graph, 's', 'b', new RestrictionSet(restrictions));
  assert.equal(result.reachable, false);
  assert.equal(result.distance, null);
  assert.deepEqual(result.path, []);

  const otherApproach = shortestPath(graph, 'x', 'a', new RestrictionSet(restrictions));
  assert.equal(otherApproach.reachable, true);
  assert.deepEqual(otherApproach.path, ['x', 'v', 'a']);
});

test('multiple bans on the same approach cover every parallel edge between the endpoints', () => {
  // v→a 有两条平行边；规则按端点三元组描述，两条平行边必须一并禁掉，
  // 不允许从另一条平行边上「漏」出去。
  const graph = new Graph(
    ['s', 'v', 'a', 'b'],
    [
      { from: 's', to: 'v', weight: 1 },
      { from: 'v', to: 'a', weight: 1 },
      { from: 'v', to: 'a', weight: 2 },
      { from: 'v', to: 'b', weight: 10 },
      { from: 'a', to: 'b', weight: 1 },
    ],
  );
  const restrictions: TurnRestriction[] = [
    { from: 's', via: 'v', to: 'a' },
    { from: 's', via: 'v', to: 'b' },
  ];

  const result = shortestPath(graph, 's', 'b', new RestrictionSet(restrictions));
  assert.equal(result.reachable, false);
  assert.deepEqual(result.path, []);
});

test('HTTP: same fixed case through /shortest-path and /compare', async () => {
  const server = createApp().listen(0);
  await new Promise<void>((resolve) => server.on('listening', resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  async function post(path: string, body: unknown): Promise<{ status: number; json: any }> {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  try {
    // 完全按线上复现配方：GET /sample 返回的 graph 原样拿来当请求输入。
    const sampleRes = await fetch(`${baseUrl}/sample`);
    assert.equal(sampleRes.status, 200);
    const sampleJson: any = await sampleRes.json();

    const body = {
      graph: sampleJson.graph,
      source: sampleJson.source,
      target: sampleJson.target,
      restrictions: [
        { from: 'B', via: 'E', to: 'F' },
        { from: 'B', via: 'E', to: 'H' },
      ],
    };

    const sp = await post('/shortest-path', body);
    assert.equal(sp.status, 200);
    assert.deepEqual(sp.json, {
      source: 'A',
      target: 'I',
      reachable: true,
      distance: 12,
      path: ['A', 'D', 'G', 'H', 'I'],
    });

    const cmp = await post('/compare', body);
    assert.equal(cmp.status, 200);
    assert.deepEqual(cmp.json.withRestrictions, {
      reachable: true,
      distance: 12,
      path: ['A', 'D', 'G', 'H', 'I'],
    });
    assert.deepEqual(cmp.json.withoutRestrictions, {
      reachable: true,
      distance: 4,
      path: ['A', 'B', 'E', 'F', 'I'],
    });
    assert.equal(cmp.json.delta, 8);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// ---------------------------------------------------------------------------
// 随机图性质测试：同一进入方向随机禁掉多个出口，并混入其它路口的禁转。
// ---------------------------------------------------------------------------

function shuffle<T>(rng: () => number, items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 从随机图里挑一个「两条边都存在」的合法禁转规则。 */
function pickRestriction(
  graph: Graph,
  rng: () => number,
  usedKeys: Set<string>,
): TurnRestriction | null {
  const nodes = graph.nodes;
  for (let attempt = 0; attempt < 60; attempt++) {
    const from = nodes[Math.floor(rng() * nodes.length)];
    const via = nodes[Math.floor(rng() * nodes.length)];
    const to = nodes[Math.floor(rng() * nodes.length)];
    if (from === via || via === to) continue; // 随机图里没有自环
    if (graph.edgesBetween(from, via).length === 0) continue;
    if (graph.edgesBetween(via, to).length === 0) continue;
    const key = `${from}>${via}>${to}`;
    if (usedKeys.has(key)) continue;
    usedKeys.add(key);
    return { from, via, to };
  }
  return null;
}

test('random graphs: every ban on a shared approach is honored, and more bans never shorten the route', () => {
  const rng = mulberry32(20260927);
  const iterations = 300;

  for (let iter = 0; iter < iterations; iter++) {
    const nodeCount = 3 + Math.floor(rng() * 9);
    const { nodes, graph } = randomGraph(rng, nodeCount, nodeCount * 3, 20);
    const source = nodes[Math.floor(rng() * nodeCount)];
    const target = nodes[Math.floor(rng() * nodeCount)];

    const unrestricted = shortestPath(graph, source, target, new RestrictionSet());
    if (!unrestricted.reachable || unrestricted.path.length < 3) continue;

    const usedKeys = new Set<string>();
    const restrictions: TurnRestriction[] = [];

    // 锚点：在无禁转最短路上选一个转向作为 (from, via)，
    // 然后把该进入方向上随机多个出口一起禁掉。
    const pivotIndex = 1 + Math.floor(rng() * (unrestricted.path.length - 2));
    const approachFrom = unrestricted.path[pivotIndex - 1];
    const approachVia = unrestricted.path[pivotIndex];
    const exits = [...new Set(graph.outgoing(approachVia).map((e: Edge) => e.to))];
    const banCount = 1 + Math.floor(rng() * Math.min(exits.length, 4));
    for (const to of shuffle(rng, exits).slice(0, banCount)) {
      const key = `${approachFrom}>${approachVia}>${to}`;
      if (usedKeys.has(key)) continue;
      // pivot 位于无禁转最短路上：from→via 边必然存在；exits 来自 via 出边表。
      usedKeys.add(key);
      restrictions.push({ from: approachFrom, via: approachVia, to });
    }

    // 混入其它路口（或同一 via 的其它进入方向）的禁转。
    const extraCount = Math.floor(rng() * 4);
    for (let k = 0; k < extraCount; k++) {
      const r = pickRestriction(graph, rng, usedKeys);
      if (r !== null) restrictions.push(r);
    }
    if (restrictions.length === 0) continue;

    const full = shortestPath(graph, source, target, new RestrictionSet(restrictions));

    // 不变量 1：结果路径里不得出现任何被禁转向；不可达时没有路径，自然满足。
    if (full.reachable) {
      assertNoBannedTriple(full.path, restrictions);
      assertValidPath(graph, full.path, source, target, full.distance!);
    }

    // 不变量 2：禁一整套规则的长度不短于只禁其中一部分规则时的长度。
    // 规则集是对可行路径集合的额外约束：部分可达 ⇒ 全量要么可达且不短于部分，
    // 要么也不可达；部分不可达 ⇒ 全量必然不可达。
    const partials: TurnRestriction[][] = restrictions.map((r) => [r]);
    if (restrictions.length > 1) partials.push(restrictions.slice(0, restrictions.length - 1));
    for (const partial of partials) {
      const sub = shortestPath(graph, source, target, new RestrictionSet(partial));
      if (!sub.reachable) {
        assert.equal(
          full.reachable,
          false,
          `iter ${iter}: a partial ban set is unreachable but the full set is`,
        );
      } else if (full.reachable) {
        assert.ok(
          full.distance! >= sub.distance!,
          `iter ${iter}: full bans (${full.distance}) shorter than partial (${sub.distance})`,
        );
      }
    }

    // 不变量 3：/compare 的开启侧必须与 /shortest-path 完全一致，delta 跟着对。
    const cmp = compareScenarios(graph, source, target, restrictions);
    assert.equal(cmp.withRestrictions.reachable, full.reachable, `iter ${iter}: reachability mismatch`);
    assert.equal(cmp.withRestrictions.distance, full.distance, `iter ${iter}: distance mismatch`);
    assert.deepEqual(cmp.withRestrictions.path, full.path, `iter ${iter}: path mismatch`);
    assert.equal(cmp.withoutRestrictions.distance, unrestricted.distance);
    if (full.reachable) {
      assert.equal(cmp.delta, full.distance! - unrestricted.distance!);
      assert.ok(cmp.delta! >= 0, `iter ${iter}: negative delta ${cmp.delta}`);
    } else {
      assert.equal(cmp.delta, null);
    }
  }
});
