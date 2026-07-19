import { submitOrder } from './order-service.js';

export function enqueueOrder(orderId: string): string {
  return `queued:${orderId}`;
}

export function routeOrder(orderId: string): string {
  return submitOrder(orderId);
}

export function routeOrderBatch(orderIds: string[]): string[] {
  return orderIds.map((orderId) => submitOrder(orderId));
}
