"""P7.3: emails, report PDFs and maintenance go through the job queue; one scheduler however many workers run."""
from __future__ import annotations

from datetime import timedelta

from app import background
from app.db import db
from app.http import now
from app.services import jobs, mailer, maintenance
from app.services.mailer import EmailMessage

from .test_password_reset import Outbox


async def test_maintenance_is_queued_once_per_hour_by_any_number_of_workers(client):
    hour = now().strftime("%Y-%m-%dT%H")
    await db.job.delete_many(where={"dedupKey": f"maintenance:{hour}"})
    for _ in range(3):  # three workers checking their schedule in the same hour
        await maintenance.schedule()
    queued = await db.job.find_many(where={"dedupKey": f"maintenance:{hour}"})
    assert len(queued) == 1 and queued[0].type == "maintenance"
    await jobs.wait_idle(("maintenance",))
    assert (await db.job.find_unique(where={"id": queued[0].id})).status == "done"


class FlakyOutbox(Outbox):
    def __init__(self):
        super().__init__()
        self.failures = 1

    async def send(self, message: EmailMessage) -> None:
        if self.failures:
            self.failures -= 1
            raise mailer.EmailError("provider is down")
        await super().send(message)


async def test_a_failed_email_is_tried_again_later_not_lost(client):
    box = FlakyOutbox()
    mailer.set_mailer_for_tests(box)
    try:
        mailer.send_in_background(EmailMessage(to="retry@example.com", subject="Hello", text="Hi"))
        await background.wait_all()
        job = await db.job.find_first(where={"type": "send_email"}, order={"createdAt": "desc"})
        assert job.status == "queued" and job.runAfter > now() and job.attempts == 1 and not box.sent
        await db.job.update(where={"id": job.id}, data={"runAfter": now() - timedelta(seconds=1)})  # a minute later
        await background.wait_all()
        assert [m.to for m in box.sent] == ["retry@example.com"]
        assert (await db.job.find_unique(where={"id": job.id})).status == "done"
    finally:
        mailer.set_mailer_for_tests(None)


async def test_the_reset_job_never_holds_the_code(client):
    from .test_api import rider

    await rider(client, "p7-reset-job@example.com")
    box = Outbox()
    mailer.set_mailer_for_tests(box)
    try:
        await client.post("/api/v1/auth/forgot-password", json={"email": "p7-reset-job@example.com"})
        await background.wait_all()
        code = box.code_for("p7-reset-job@example.com")
        job = await db.job.find_first(where={"type": "password_reset_code"}, order={"createdAt": "desc"})
        assert job.status == "done" and code not in str(job.input)
    finally:
        mailer.set_mailer_for_tests(None)


async def test_report_pdfs_are_made_by_the_worker_and_its_refusals_reach_the_rider(client, monkeypatch):
    from app.errors import AppError
    from app.services import report_service

    from .test_api import rider
    from .test_v2 import route_with_stops

    _, auth = await rider(client, "p7-report-job@example.com")
    built = await route_with_stops(client, auth, 1)
    res = await client.post("/api/v1/reports/generate", headers=auth, json={"date": built["serviceDate"]})
    assert res.status_code == 201, res.text
    job = await db.job.find_first(where={"type": "report_pdf"}, order={"createdAt": "desc"})
    assert job.status == "done" and job.result == {"id": res.json()["data"]["id"]}

    async def refuse(*_args, **_kwargs):
        raise AppError(403, "PLAN_LIMIT_REACHED", "Your plan allows 0 reports per month.")

    monkeypatch.setattr(report_service, "_render_and_save", refuse)  # e.g. the limit re-check under the lock, in the worker
    res = await client.post("/api/v1/reports/generate", headers=auth, json={"date": built["serviceDate"]})
    assert res.status_code == 403 and res.json()["error"]["code"] == "PLAN_LIMIT_REACHED"


async def test_a_stopping_worker_puts_its_unfinished_jobs_back_at_once(client):
    """P7.4: not after STALE_AFTER (10 min), and the interrupted run does not count as an attempt."""
    from app.db import as_json
    from app.ids import new_id

    job_id = new_id()
    await db.job.create(data={"id": job_id, "type": "send_email", "input": as_json({}), "status": "running", "attempts": 1, "startedAt": now()})
    assert await jobs.release({job_id}) == 1
    job = await db.job.find_unique(where={"id": job_id})
    assert job.status == "queued" and job.attempts == 0 and job.startedAt is None
    await db.job.delete(where={"id": job_id})
    assert await jobs.release(set()) == 0


async def test_an_idle_worker_with_several_loops_stops_at_once(client):
    import asyncio

    from app import worker

    stop = asyncio.Event()
    task = asyncio.create_task(worker.serve(stop, concurrency=3, grace=5, poll=0.02, schedule=False))
    await asyncio.sleep(0.1)
    stop.set()
    await asyncio.wait_for(task, timeout=2)
