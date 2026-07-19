def process_order(order_id: str) -> str:
    return f"processed:{order_id}"


def process_order_batch(order_ids: list[str]) -> list[str]:
    return [process_order(order_id) for order_id in order_ids]


def retry_order(order_id: str) -> str:
    return process_order(order_id)
