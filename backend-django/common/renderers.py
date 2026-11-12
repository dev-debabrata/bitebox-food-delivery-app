from djangorestframework_camel_case.render import CamelCaseJSONRenderer as _CamelCaseJSONRenderer


class CamelCaseJSONRenderer(_CamelCaseJSONRenderer):
    """
    JSON with camelCase keys (Python code stays snake_case). Views already return the
    `{ success, message, data }` envelope via `common.api.ok`, so this only renders.
    """

    charset = "utf-8"
