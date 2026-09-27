/**
 * 禁转规则处理。
 *
 * 一条禁转规则是三元组 (from, via, to)：在 via 节点上，
 * 不允许从 from→via 这条边直接拐上 via→to 这条边。
 */

import { Edge, NodeId } from './graph';

export interface TurnRestriction {
  from: NodeId;
  via: NodeId;
  to: NodeId;
}

export class RestrictionSet {
  /** 进入方向 (from→via) → 该方向上所有被禁止拐上的出口节点。 */
  private readonly banned = new Map<string, Set<NodeId>>();
  /** 去重后的规则条数（同一三元组重复写只计一次）。 */
  private count = 0;

  constructor(restrictions: TurnRestriction[] = []) {
    for (const r of restrictions) {
      const key = approachKey(r.from, r.via);
      let bannedExits = this.banned.get(key);
      if (bannedExits === undefined) {
        bannedExits = new Set<NodeId>();
        this.banned.set(key, bannedExits);
      }
      // 必须按出口逐个收集：同一进入方向上可以同时禁掉多个出口，
      // 早先实现只存单个出口，后写的规则会把先写的覆盖掉。
      if (bannedExits.has(r.to)) continue;
      bannedExits.add(r.to);
      this.count++;
    }
  }

  get size(): number {
    return this.count;
  }

  /**
   * 是否允许「沿 inEdge 进入节点、紧接着沿 outEdge 离开」这个转向。
   * inEdge 为 null 表示当前在起点、尚未来自任何边，此时不受禁转约束。
   * 判定只看端点：同一对端点间的任何平行边一并受约束。
   */
  isTurnAllowed(inEdge: Edge | null, outEdge: Edge): boolean {
    if (inEdge === null) return true;
    return !this.banned.get(approachKey(inEdge.from, outEdge.from))?.has(outEdge.to);
  }
}

export function approachKey(from: NodeId, via: NodeId): string {
  return JSON.stringify([from, via]);
}
