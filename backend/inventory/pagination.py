from rest_framework.pagination import PageNumberPagination


class Pagination(PageNumberPagination):
    """Default 30 per page; the app can ask for more with ?page_size= (max 500)."""

    page_size = 30
    page_size_query_param = "page_size"
    max_page_size = 500
