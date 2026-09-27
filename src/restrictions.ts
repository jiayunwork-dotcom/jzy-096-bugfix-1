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

  constructor(restrictions: TurnRestriction[] = []) {
    for (const r of restrictions) {
      const key = approachKey(r.from, r.via);
      let exits = this.banned.get(key);
      if (exits === undefined) {
        exits = new Set<NodeId>();
        this.banned.set(key, exits);
      }
      // 同一进入方向上可以禁掉多个出口；重复规则自然去重，不会互相覆盖。
      exits.add(r.to);
    }
  }

  /** 生效中的（去重后的）禁转向条数。 */
  get size(): number {
    let n = 0;
    for (const exits of this.banned.values()) n += exits.size;
    return n;
  }

  /**
   * 是否允许「沿 inEdge 进入节点、紧接着沿 outEdge 离开」这个转向。
   * inEdge 为 null 表示当前在起点、尚未来自任何边，此时不受禁转约束。
   */
  isTurnAllowed(inEdge: Edge | null, outEdge: Edge): boolean {
    if (inEdge === null) return true;
    return !this.banned.get(approachKey(inEdge.from, outEdge.from))?.has(outEdge.to);
  }
}

export function approachKey(from: NodeId, via: NodeId): string {
  return JSON.stringify([from, via]);
}
