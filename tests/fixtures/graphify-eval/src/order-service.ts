import { enqueueOrder } from './order-router.js';

export function validateOrder(orderId: string): boolean {
  return orderId.trim().length > 0;
}

export function submitOrder(orderId: string): string {
  if (!validateOrder(orderId)) throw new Error('invalid order');
  return enqueueOrder(orderId);
}

export function submitOrderBatch(orderIds: string[]): string[] {
  return orderIds.map((orderId) => submitOrder(orderId));
}
