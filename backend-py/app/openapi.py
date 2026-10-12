"""OpenAPI document for /docs (development only).

Handlers take a raw `Request` and validate it themselves (see validation.py), so FastAPI cannot see their bodies,
queries or path params. This reads each handler's own `validate(...)`, `receive(...)` and `authenticate(...)` calls
and documents exactly those models, so the docs can never drift from what the endpoint really accepts.
"""
from __future__ import annotations

import ast
import inspect
import textwrap
from typing import Any

from fastapi import FastAPI
from fastapi.openapi.utils import get_openapi
from fastapi.routing import APIRoute, iter_route_contexts

from .uploads import UploadSpec

ROLE_NOTE = {"rider": "Requires a **rider** access token.", "owner_admin": "Requires an **admin** access token.",
             "any": "Requires an access token (rider or admin)."}


def _handler_calls(endpoint: Any) -> dict:
    """Finds the models a handler validates against, the upload it receives and the role it authenticates."""
    found: dict[str, Any] = {}
    tree = ast.parse(textwrap.dedent(inspect.getsource(endpoint)))
    names = endpoint.__globals__
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
            continue
        fn = node.func.id
        if fn == "validate":
            for kw in node.keywords:
                if kw.arg in ("body", "query", "params") and isinstance(kw.value, ast.Name):
                    found[kw.arg] = names.get(kw.value.id)
        elif fn == "receive" and len(node.args) > 1 and isinstance(node.args[1], ast.Name):
            found["upload"] = names.get(node.args[1].id)
        elif fn == "authenticate":
            roles = [a.value for a in node.args[1:] if isinstance(a, ast.Constant)]
            found["role"] = roles[0] if roles else "any"
        elif fn == "_admin":
            found["role"] = "owner_admin"
    return found


class _Schemas:
    """Registers pydantic models under components/schemas, renaming on a clash between same-named models."""

    def __init__(self, store: dict):
        self.store = store
        self.owners: dict[str, type] = {}

    def ref(self, model: type) -> dict:
        name = model.__name__
        if self.owners.get(name) not in (None, model):
            name = f"{model.__module__.rsplit('.', 1)[-1]}_{name}"
        if name not in self.owners:
            self.owners[name] = model
            schema = model.model_json_schema(ref_template="#/components/schemas/{model}")
            for def_name, definition in schema.pop("$defs", {}).items():
                self.store.setdefault(def_name, definition)
            self.store[name] = schema
        return {"$ref": f"#/components/schemas/{name}"}


def _parameters(model: type, where: str) -> list[dict]:
    props = model.model_json_schema(ref_template="#/components/schemas/{model}").get("properties", {})
    return [{"name": name, "in": where, "required": where == "path" or field.is_required(), "schema": props.get(name, {})}
            for name, field in model.model_fields.items()]


def _upload_body(spec: UploadSpec) -> dict:
    allowed = ", ".join(f".{e}" for e in spec.extensions) or ", ".join(spec.mimes)
    return {"required": True, "content": {"multipart/form-data": {"schema": {
        "type": "object", "required": [spec.field],
        "properties": {spec.field: {"type": "string", "format": "binary",
                                    "description": f"{allowed}, up to {spec.max_bytes // (1024 * 1024)} MB"}},
    }}}}


def install_openapi(app: FastAPI) -> None:
    def openapi() -> dict:
        if app.openapi_schema:
            return app.openapi_schema
        schema = get_openapi(title=app.title, version=app.version, routes=app.routes,
                             description="Rider and admin API. Sign in with `POST /api/v1/auth/login`, copy `accessToken`, "
                                         "then press **Authorize** and paste it.")
        components = schema.setdefault("components", {})
        components["securitySchemes"] = {"bearerAuth": {"type": "http", "scheme": "bearer", "bearerFormat": "JWT"}}
        schemas = _Schemas(components.setdefault("schemas", {}))

        # iter_route_contexts resolves included routers to their full paths (app.routes only holds the top level).
        for route in iter_route_contexts(app.routes):
            if not isinstance(route.original_route, APIRoute):
                continue
            calls = _handler_calls(route.endpoint)
            tag = route.path_format.removeprefix("/api/v1/").split("/")[0] if route.path_format.startswith("/api/v1/") else "system"
            for method in route.methods:
                op = schema["paths"][route.path_format][method.lower()]
                op["tags"] = [tag]
                params = []
                if calls.get("params"):
                    params += _parameters(calls["params"], "path")
                if calls.get("query"):
                    params += _parameters(calls["query"], "query")
                if params:
                    op["parameters"] = params
                if calls.get("body"):
                    op["requestBody"] = {"content": {"application/json": {"schema": schemas.ref(calls["body"])}}}
                if calls.get("upload"):
                    op["requestBody"] = _upload_body(calls["upload"])
                if calls.get("role"):
                    op["security"] = [{"bearerAuth": []}]
                    op["description"] = ROLE_NOTE[calls["role"]]
        app.openapi_schema = schema
        return schema

    app.openapi = openapi
