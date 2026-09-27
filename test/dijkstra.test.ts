import assert from 'node:assert/strict';
import test from 'node:test';
import { plainDijkstra, shortestPath } from '../src/dijkstra';
import { Graph } from '../src/graph';
import { RestrictionSet, TurnRestriction, approachKey } from '../src/restrictions';
import { buildSample } from '../src/sample';
import { assertValidPath, mulberry32, randomGraph } from './helpers';

const NO_RESTRICTIONS = new RestrictionSet();

/** 断言节点序列中任何一个连续三元组都不在禁转规则里。 */
function assertPathHasNoBannedTurn(
  path: string[],
  restrictions: TurnRestriction[],
  label = '',
): void {
  const banned = new Set(restrictions.map((r) => JSON.stringify([r.from, r.via, r.to])));
  for (let i = 1; i + 1 < path.length; i++) {
    const key = JSON.stringify([path[i - 1], path[i], path[i + 1]]);
    assert.ok(!banned.has(key), `${label}: path ${JSON.stringify(path)} uses banned turn ${key}`);
  }
}

/** 去掉完全重复的规则（同一三元组写多遍只算一条）。 */
function dedupeRestrictions(restrictions: TurnRestriction[]): TurnRestriction[] {
  const seen = new Set<string>();
  const out: TurnRestriction[] = [];
  for (const r of restrictions) {
    const key = JSON.stringify([r.from, r.via, r.to]);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(r);
    }
  }
  return out;
}

test('invariant: with no restrictions, state-space search matches plain Dijkstra', () => {
  const rng = mulberry32(20260925);
  for (let iter = 0; iter < 300; iter++) {
    const nodeCount = 2 + Math.floor(rng() * 9);
    const { nodes, graph } = randomGraph(rng, nodeCount, nodeCount * 3, 20);
    const source = nodes[Math.floor(rng() * nodeCount)];
    const target = nodes[Math.floor(rng() * nodeCount)];

    const expected = plainDijkstra(graph, source, target);
    const actual = shortestPath(graph, source, target, NO_RESTRICTIONS);

    assert.equal(actual.reachable, expected.reachable, `reachability mismatch at iter ${iter}`);
    assert.equal(actual.distance, expected.distance, `distance mismatch at iter ${iter}`);
    if (actual.reachable) {
      assertValidPath(graph, actual.path, source, target, actual.distance!);
    }
  }
});

test('invariant: banning a turn used by the shortest path never shortens the route', () => {
  const rng = mulberry32(7);
  for (let iter = 0; iter < 300; iter++) {
    const nodeCount = 3 + Math.floor(rng() * 8);
    const { nodes, graph } = randomGraph(rng, nodeCount, nodeCount * 3, 20);
    const source = nodes[Math.floor(rng() * nodeCount)];
    const target = nodes[Math.floor(rng() * nodeCount)];

    const before = shortestPath(graph, source, target, NO_RESTRICTIONS);
    if (!before.reachable || before.path.length < 3) continue; // 路径上没有可禁的转向

    const i = 1 + Math.floor(rng() * (before.path.length - 2));
    const restriction: TurnRestriction = {
      from: before.path[i - 1],
      via: before.path[i],
      to: before.path[i + 1],
    };
    const after = shortestPath(graph, source, target, new RestrictionSet([restriction]));

    if (!after.reachable) continue; // 禁转后不可达，自然也满足「不会更短」
    assert.ok(
      after.distance! >= before.distance!,
      `distance decreased after adding a restriction: ${before.distance} -> ${after.distance}`,
    );
    // 新路径不得再包含被禁的那个连续三元组。
    for (let k = 1; k + 1 < after.path.length; k++) {
      const triple = [after.path[k - 1], after.path[k], after.path[k + 1]];
      assert.notDeepEqual(
        triple,
        [restriction.from, restriction.via, restriction.to],
        'restricted turn still appears in the new path',
      );
    }
    assertValidPath(graph, after.path, source, target, after.distance!);
  }
});

test('invariant: increasing an edge weight never decreases the shortest distance', () => {
  const rng = mulberry32(99);
  for (let iter = 0; iter < 300; iter++) {
    const nodeCount = 2 + Math.floor(rng() * 9);
    const { nodes, edges, graph } = randomGraph(rng, nodeCount, nodeCount * 3, 20);
    const source = nodes[Math.floor(rng() * nodeCount)];
    const target = nodes[Math.floor(rng() * nodeCount)];

    const before = shortestPath(graph, source, target, NO_RESTRICTIONS);

    const bumped = edges.map((e) => ({ ...e }));
    const idx = Math.floor(rng() * bumped.length);
    bumped[idx] = { ...bumped[idx], weight: bumped[idx].weight + 1 + Math.floor(rng() * 10) };
    const heavier = new Graph(nodes, bumped);

    const after = shortestPath(heavier, source, target, NO_RESTRICTIONS);
    if (!before.reachable) continue; // 原本不可达，调权后怎样都不算变短
    if (!after.reachable) continue; // 变不可达也不是「变短」
    assert.ok(
      after.distance! >= before.distance!,
      `distance decreased after weight increase: ${before.distance} -> ${after.distance}`,
    );
  }
});

test('source equals target: distance 0 and single-node path', () => {
  const { graph, restrictions } = buildSample();
  const result = shortestPath(graph, 'E', 'E', new RestrictionSet(restrictions));
  assert.equal(result.reachable, true);
  assert.equal(result.distance, 0);
  assert.deepEqual(result.path, ['E']);
});

test('unreachable target is reported explicitly', () => {
  const graph = new Graph(
    ['a', 'b', 'c', 'd'],
    [
      { from: 'a', to: 'b', weight: 1 },
      { from: 'c', to: 'd', weight: 1 },
    ],
  );
  const result = shortestPath(graph, 'a', 'd', NO_RESTRICTIONS);
  assert.equal(result.reachable, false);
  assert.equal(result.distance, null);
  assert.deepEqual(result.path, []);
});

test('a naive node-state search would use the banned turn; the state-space search must not', () => {
  // S→A→T 是最短路，但转向 (S,A,T) 被禁。正确解需要折返：S→A→B→A→T，
  // 只有「节点 + 进入边」的扩展状态才能表达「再次经过 A 时来向不同」。
  const graph = new Graph(
    ['S', 'A', 'B', 'T'],
    [
      { from: 'S', to: 'A', weight: 1 },
      { from: 'A', to: 'B', weight: 1 },
      { from: 'B', to: 'A', weight: 1 },
      { from: 'A', to: 'T', weight: 5 },
      { from: 'S', to: 'T', weight: 10 },
    ],
  );
  const banned: TurnRestriction = { from: 'S', via: 'A', to: 'T' };

  const unrestricted = shortestPath(graph, 'S', 'T', NO_RESTRICTIONS);
  assert.equal(unrestricted.distance, 6);
  assert.deepEqual(unrestricted.path, ['S', 'A', 'T']);

  const restricted = shortestPath(graph, 'S', 'T', new RestrictionSet([banned]));
  assert.equal(restricted.distance, 8);
  assert.deepEqual(restricted.path, ['S', 'A', 'B', 'A', 'T']);
});

test('sample grid: the banned left turn forces a strictly longer detour', () => {
  const sample = buildSample();
  const withR = shortestPath(sample.graph, sample.source, sample.target, new RestrictionSet(sample.restrictions));
  const withoutR = shortestPath(sample.graph, sample.source, sample.target, NO_RESTRICTIONS);

  assert.equal(withoutR.distance, 4);
  assert.deepEqual(withoutR.path, ['A', 'B', 'E', 'F', 'I']);
  assert.equal(withR.distance, 8);
  assert.deepEqual(withR.path, ['A', 'B', 'E', 'H', 'I']);
  assert.ok(withR.distance! > withoutR.distance!);
});

test('multiple banned exits on the same approach at one intersection all take effect', () => {
  // 复现调度员报障的 3×3 网格：从 B 驶进 E 以后，(B,E,F) 与 (B,E,H)
  // 两条禁转必须同时生效，不能互相覆盖。
  const sample = buildSample();
  const restrictions: TurnRestriction[] = [
    { from: 'B', via: 'E', to: 'F' },
    { from: 'B', via: 'E', to: 'H' },
  ];

  const result = shortestPath(sample.graph, 'A', 'I', new RestrictionSet(restrictions));
  assert.equal(result.reachable, true);
  assert.equal(result.distance, 12);
  assert.deepEqual(result.path, ['A', 'D', 'G', 'H', 'I']);
  assertPathHasNoBannedTurn(result.path, restrictions, 'both bans');
  assertValidPath(sample.graph, result.path, 'A', 'I', result.distance!);

  // 对照：单写 (B,E,F) → 8；单写 (B,E,H) → 4（原路线本就不走这个转向）。
  const onlyF = shortestPath(sample.graph, 'A', 'I', new RestrictionSet([restrictions[0]]));
  assert.equal(onlyF.distance, 8);
  assert.deepEqual(onlyF.path, ['A', 'B', 'E', 'H', 'I']);
  const onlyH = shortestPath(sample.graph, 'A', 'I', new RestrictionSet([restrictions[1]]));
  assert.equal(onlyH.distance, 4);
  assert.deepEqual(onlyH.path, ['A', 'B', 'E', 'F', 'I']);

  // 同一路口、不同进入方向上各禁一条，两条也都要生效。
  const crossApproach = shortestPath(
    sample.graph,
    'A',
    'I',
    new RestrictionSet([
      { from: 'B', via: 'E', to: 'F' },
      { from: 'D', via: 'E', to: 'F' },
    ]),
  );
  assert.equal(crossApproach.distance, 8);
  assertPathHasNoBannedTurn(
    crossApproach.path!,
    [
      { from: 'B', via: 'E', to: 'F' },
      { from: 'D', via: 'E', to: 'F' },
    ],
    'cross-approach bans',
  );
});

test('banning every exit of an approach does not throw and can make the target unreachable', () => {
  // 从 a 进 v 后 v 的全部出口都被禁；允许掉头回 a，但 a 也是死胡同 → 明确不可达。
  const graph = new Graph(
    ['a', 'v', 't1', 't2'],
    [
      { from: 'a', to: 'v', weight: 1 },
      { from: 'v', to: 'a', weight: 1 },
      { from: 'v', to: 't1', weight: 1 },
      { from: 'v', to: 't2', weight: 1 },
    ],
  );
  const restrictions: TurnRestriction[] = [
    { from: 'a', via: 'v', to: 't1' },
    { from: 'a', via: 'v', to: 't2' },
  ];
  const result = shortestPath(graph, 'a', 't1', new RestrictionSet(restrictions));
  assert.equal(result.reachable, false);
  assert.equal(result.distance, null);
  assert.deepEqual(result.path, []);
});

test('invariant: several exits banned on the same approach, mixed with other intersections', () => {
  const rng = mulberry32(20260927);
  for (let iter = 0; iter < 300; iter++) {
    const nodeCount = 3 + Math.floor(rng() * 8);
    const { nodes, edges, graph } = randomGraph(rng, nodeCount, nodeCount * 3, 20);
    const source = nodes[Math.floor(rng() * nodeCount)];
    const target = nodes[Math.floor(rng() * nodeCount)];

    // 挑一个「进入方向」(p→v)，把从 v 出发的不同出口收集起来。
    const pi = Math.floor(rng() * edges.length);
    const approachEdge = edges[pi];
    const p = approachEdge.from;
    const v = approachEdge.to;
    if (p === v) continue;
    const exits = [...new Set(graph.outgoing(v).map((e) => e.to).filter((to) => to !== v))];
    if (exits.length < 2) continue;

    // 在同一进入方向上随机禁掉至少 2 个（最多全部）出口。
    const shuffled = [...exits].sort(() => rng() - 0.5);
    const banCount = 2 + Math.floor(rng() * (exits.length - 1));
    const mainBans: TurnRestriction[] = shuffled
      .slice(0, banCount)
      .map((to) => ({ from: p, via: v, to }));

    // 混入其他路口（不同进入方向）的禁转。
    const extra: TurnRestriction[] = [];
    const usedApproaches = new Set<string>([approachKey(p, v)]);
    const extraCount = Math.floor(rng() * 4);
    for (let k = 0; k < extraCount; k++) {
      const ei = Math.floor(rng() * edges.length);
      const e = edges[ei];
      if (e.from === e.to) continue;
      if (usedApproaches.has(approachKey(e.from, e.to))) continue;
      const outs = graph.outgoing(e.to);
      if (outs.length === 0) continue;
      const out = outs[Math.floor(rng() * outs.length)];
      usedApproaches.add(approachKey(e.from, e.to));
      extra.push({ from: e.from, via: e.to, to: out.to });
    }

    const full = dedupeRestrictions([...mainBans, ...extra]);

    // 全部禁转生效时：路线里不得出现任何被禁转向；可达时路径要真实且长度匹配。
    const fullResult = shortestPath(graph, source, target, new RestrictionSet(full));
    if (fullResult.reachable) {
      assertPathHasNoBannedTurn(fullResult.path, full, `iter ${iter} full`);
      assertValidPath(graph, fullResult.path, source, target, fullResult.distance!);
    }

    // 只禁其中一部分（真子集）时：禁转越少路径集合越大——
    // 全部禁转可达 ⇒ 部分禁转必可达，且长度不会更大；
    // 部分禁转不可达 ⇒ 全部禁转也必不可达；
    // 全部禁转不可达但部分禁转可达（出口被全部封死）是正常情形。
    const partialCount = 1 + Math.floor(rng() * (full.length - 1));
    const partial = [...full].sort(() => rng() - 0.5).slice(0, partialCount);
    const partialResult = shortestPath(graph, source, target, new RestrictionSet(partial));
    if (partialResult.reachable) {
      assertPathHasNoBannedTurn(partialResult.path, partial, `iter ${iter} partial`);
      assertValidPath(graph, partialResult.path, source, target, partialResult.distance!);
    } else {
      assert.equal(fullResult.reachable, false, `iter ${iter}: partial unreachable but full reachable`);
    }
    if (fullResult.reachable && partialResult.reachable) {
      assert.ok(
        fullResult.distance! >= partialResult.distance!,
        `iter ${iter}: full distance ${fullResult.distance} < partial ${partialResult.distance}`,
      );
    }
  }
});
