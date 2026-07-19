class OrderRepository:
    def save_order(self, order_id: str) -> str:
        return f"saved:{order_id}"

    def load_order(self, order_id: str) -> str:
        return f"loaded:{order_id}"


class OrderRepositoryArchive:
    def save_order_archive(self, order_id: str) -> str:
        return f"archived:{order_id}"
