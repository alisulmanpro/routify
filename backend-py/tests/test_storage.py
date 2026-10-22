"""P7.1: files in an S3-compatible bucket (R2), SigV4 signing, and the re-runnable migration script."""
from __future__ import annotations

import dataclasses
import sys
import uuid
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest

from app.config import env
from app.services import s3, storage_service

from .test_v2 import JPEG, route_with_stops

SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"


def test_signatures_match_the_aws_documentation_examples():
    # "Authenticating Requests: Using Query Parameters (AWS Signature Version 4)".
    query = s3.presigned_query(method="GET", host="examplebucket.s3.amazonaws.com", path="/test.txt", region="us-east-1",
                               access_key="AKIAIOSFODNN7EXAMPLE", secret=SECRET, amz_date="20130524T000000Z", expires=86400)
    assert query["X-Amz-Signature"] == "aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"
    # "Signature Calculations for the Authorization Header", GET Object example.
    sig, signed = s3.signature(method="GET", path="/test.txt", query={}, payload_hash=s3.EMPTY_SHA256, amz_date="20130524T000000Z",
                               region="us-east-1", secret=SECRET,
                               headers={"host": "examplebucket.s3.amazonaws.com", "range": "bytes=0-9",
                                        "x-amz-content-sha256": s3.EMPTY_SHA256, "x-amz-date": "20130524T000000Z"})
    assert sig == "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41" and signed == "host;range;x-amz-content-sha256;x-amz-date"


class FakeS3:
    """An in-memory bucket behind httpx: checks every request is signed for the right bucket."""

    def __init__(self):
        self.objects: dict[str, bytes] = {}
        self.requests: list[str] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        assert request.headers["authorization"].startswith("AWS4-HMAC-SHA256 Credential=TESTKEY/") and request.headers["x-amz-date"]
        path = request.url.path
        assert path.startswith("/routify-test/")
        key = path[len("/routify-test/"):]
        self.requests.append(f"{request.method} {key}")
        if request.method == "PUT":
            self.objects[key] = request.content
            return httpx.Response(200)
        if key not in self.objects:
            return httpx.Response(404)
        if request.method == "DELETE":
            del self.objects[key]
            return httpx.Response(204)
        if request.method == "HEAD":
            return httpx.Response(200, headers={"content-length": str(len(self.objects[key]))})
        return httpx.Response(200, content=self.objects[key])


@pytest.fixture
def bucket(monkeypatch):
    fake = FakeS3()
    configured = dataclasses.replace(env, STORAGE_BACKEND="s3", S3_ENDPOINT="https://acct.r2.example", S3_BUCKET="routify-test",
                                     S3_ACCESS_KEY_ID="TESTKEY", S3_SECRET_ACCESS_KEY="TESTSECRET", S3_REGION="auto")
    for module in (storage_service, s3):
        monkeypatch.setattr(module, "env", configured)
    s3.set_transport_for_tests(httpx.MockTransport(fake.handle))
    yield fake
    s3.set_transport_for_tests(None)


async def test_proof_photos_and_reports_live_in_the_bucket(client, bucket):
    from .test_api import rider

    _, auth = await rider(client, "p7-bucket@example.com")
    built = await route_with_stops(client, auth, 1)
    stop = built["stops"][0]["delivery"]["id"]
    await client.post(f"/api/v1/deliveries/{stop}/arrive", headers=auth)
    up = await client.post(f"/api/v1/deliveries/{stop}/proof", headers=auth, files={"photo": ("p.jpg", JPEG, "image/jpeg")})
    assert up.status_code == 200, up.text
    keys = [k for k in bucket.objects if k.startswith("proofs/")]
    assert len(keys) == 1 and bucket.objects[keys[0]] == JPEG
    assert not (storage_service.root() / keys[0]).exists(), "nothing is written to local disk"

    # The API's signed link answers with a short-lived link straight to the bucket (the file does not go through the API).
    res = await client.get(up.json()["data"]["proof"]["photoUrl"], follow_redirects=False)
    assert res.status_code == 307
    location = urlsplit(res.headers["location"])
    params = parse_qs(location.query)
    assert location.netloc == "acct.r2.example" and location.path == f"/routify-test/{keys[0]}"
    assert params["X-Amz-Expires"] == ["300"] and params["response-content-type"] == ["image/jpeg"] and params["X-Amz-Signature"]
    assert params["response-content-disposition"][0].startswith("inline;")

    # A report reads the photo from the bucket and stores its PDF there too.
    await client.post(f"/api/v1/deliveries/{stop}/deliver", headers=auth, json={})
    report = await client.post("/api/v1/reports/generate", headers=auth, json={"date": built["serviceDate"]})
    assert report.status_code == 201, report.text
    pdfs = [k for k in bucket.objects if k.startswith("reports/")]
    assert len(pdfs) == 1 and bucket.objects[pdfs[0]].startswith(b"%PDF-")
    assert f"GET {keys[0]}" in bucket.requests

    # Replacing the photo deletes the old object.
    await client.post(f"/api/v2/uploads/proof?stopId={stop}", headers={**auth, "Idempotency-Key": str(uuid.uuid4())},
                      files={"photo": ("q.jpg", JPEG + b"\x01", "image/jpeg")})
    assert keys[0] not in bucket.objects and len([k for k in bucket.objects if k.startswith("proofs/")]) == 1


async def test_migration_script_is_a_dry_run_unless_confirmed_and_can_run_again(client, bucket, monkeypatch, capsys):
    from scripts import migrate_files_to_s3 as migrate

    monkeypatch.setattr(migrate, "env", s3.env)
    local = {f"proofs/{uuid.uuid4()}.jpg": JPEG, f"reports/{uuid.uuid4()}.pdf": b"%PDF-1.4 test"}
    for key, data in local.items():
        path = storage_service.resolve_key(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    all_local = set(migrate.local_keys())
    assert set(local) <= all_local

    async def run(*argv: str) -> int:
        monkeypatch.setattr(sys, "argv", ["migrate", *argv])
        return await migrate.main()

    assert await run() == 0 and not bucket.objects, "dry run: nothing copied"
    assert "would copy" in capsys.readouterr().out
    assert await run("--apply") == 2 and await run("--apply", "--confirm-bucket", "other-bucket") == 2 and not bucket.objects
    assert await run("--apply", "--confirm-bucket", "routify-test") == 0
    assert all(bucket.objects[k] == v for k, v in local.items())
    puts = len([r for r in bucket.requests if r.startswith("PUT")])
    # Again (e.g. after an interruption): already there, nothing copied twice.
    assert await run("--apply", "--confirm-bucket", "routify-test") == 0
    assert len([r for r in bucket.requests if r.startswith("PUT")]) == puts
    assert "0 copied" in capsys.readouterr().out.splitlines()[-1]
