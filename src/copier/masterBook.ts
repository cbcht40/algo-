import type { Order, OrderVersion, Position, PropsEvent } from "../tradovate/types";

/**
 * Local mirror of the master account's order book. Tradovate splits an order
 * into a light `order` entity (id, action, status) and an `orderVersion`
 * entity (qty, type, price). We keep both and expose a joined view.
 */
export class MasterBook {
  private orders = new Map<number, Order>();
  /** orderId -> latest (highest-id) orderVersion */
  private versions = new Map<number, OrderVersion>();
  /** contractId -> net position */
  private positions = new Map<number, number>();

  /**
   * Apply one entity event. Returns the master orderId it affected (so the
   * engine knows which order to re-evaluate), or undefined for non-order data.
   */
  apply(ev: PropsEvent): number | undefined {
    const e = ev.entity as any;
    switch (ev.entityType) {
      case "order": {
        const o = e as Order;
        if (typeof o.id !== "number") return undefined;
        this.orders.set(o.id, o);
        return o.id;
      }
      case "orderVersion": {
        const v = e as OrderVersion;
        if (typeof v.orderId !== "number") return undefined;
        const prev = this.versions.get(v.orderId);
        if (!prev || v.id >= prev.id) this.versions.set(v.orderId, v);
        return v.orderId;
      }
      case "position": {
        const p = e as Position;
        if (typeof p.contractId === "number") this.positions.set(p.contractId, p.netPos ?? 0);
        return undefined;
      }
      default:
        return undefined;
    }
  }

  order(id: number): Order | undefined {
    return this.orders.get(id);
  }
  version(orderId: number): OrderVersion | undefined {
    return this.versions.get(orderId);
  }

  /** Open (working) orders for a given account — used for the start-flat check. */
  workingOrders(accountId: number): Order[] {
    return [...this.orders.values()].filter(
      (o) => o.accountId === accountId && o.ordStatus === "Working",
    );
  }

  openPositions(): Array<{ contractId: number; netPos: number }> {
    return [...this.positions.entries()]
      .filter(([, n]) => n !== 0)
      .map(([contractId, netPos]) => ({ contractId, netPos }));
  }
}
