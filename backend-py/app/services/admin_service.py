from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from typing import Any

from ..db import db
from ..errors import conflict, not_found
from ..http import js_round, now, page_meta, paginate, round2, today_key
from ..validation import contains_text
from .auth_service import serialize_user
from .report_service import serialize_report
from .serializers import serialize_delivery
from .subscription_service import effective_status, serialize_plan, serialize_subscription

OPEN = ("pending", "in_progress")


def day_key(offset: int = 0) -> str:
    return today_key(now() + timedelta(days=offset))


def pct(current: int, before: int) -> int:
    if before == 0:
        return 0 if current == 0 else 100
    return js_round((current - before) / before * 100)


def _rx(s: str) -> dict:
    return contains_text(s)


async def user_names(ids: list[str]) -> dict[str, str]:
    unique = list(dict.fromkeys(i for i in ids if i))
    if not unique:
        return {}
    return {u.id: u.fullName for u in await db.user.find_many(where={"id": {"in": unique}})}


async def overview(days: int = 7) -> dict:
    today = today_key()
    since = day_key(-(days - 1))
    current = now()
    month_start = datetime(current.year, current.month, 1, tzinfo=timezone.utc)
    day30 = current - timedelta(days=29)

    (rider_count, new_riders7, new_riders_prev7, active_riders24h, active_routes, deliveries_today, del7, del_prev7,
     sub_groups, volume_rows, subs_recent, payments_recent, revenue_month, recent, live_routes) = await asyncio.gather(
        db.user.count(where={"role": "rider"}),
        db.user.count(where={"role": "rider", "createdAt": {"gte": current - timedelta(days=7)}}),
        db.user.count(where={"role": "rider", "createdAt": {"gte": current - timedelta(days=14), "lt": current - timedelta(days=7)}}),
        db.user.count(where={"role": "rider", "lastActiveAt": {"gte": current - timedelta(days=1)}}),
        db.route.count(where={"status": "active"}),
        db.delivery.count(where={"serviceDate": today}),
        db.delivery.count(where={"serviceDate": {"gte": day_key(-6), "lte": today}}),
        db.delivery.count(where={"serviceDate": {"gte": day_key(-13), "lt": day_key(-6)}}),
        db.subscription.group_by(by=["planKey", "status", "billingCycle"], count=True),
        db.delivery.group_by(by=["serviceDate", "status"], where={"serviceDate": {"gte": since, "lte": today}}, count=True),
        db.subscription.find_many(where={"createdAt": {"gte": day30}}),
        db.payment.find_many(where={"status": "succeeded", "paidAt": {"gte": day30}}),
        db.payment.group_by(by=["currency"], where={"status": "succeeded", "paidAt": {"gte": month_start}}, sum={"amount": True}),
        db.delivery.find_many(order=[{"createdAt": "desc"}, {"id": "desc"}], take=8),
        db.route.find_many(where={"status": "active"}, order=[{"startedAt": "desc"}, {"id": "desc"}], take=6),
    )

    subs = {"total": 0, "active": 0, "trialing": 0, "expired": 0, "pastDue": 0, "cancelled": 0,
            "byPlan": {"trial": 0, "starter": 0, "pro": 0}, "byCycle": {"monthly": 0, "annual": 0}}
    for g in sub_groups:
        count, status = g["_count"]["_all"], str(g["status"])
        subs["total"] += count
        subs["byPlan"][str(g["planKey"])] += count
        if status == "active":
            subs["active"] += count
            subs["byCycle"][str(g["billingCycle"])] += count
        if status == "trialing":
            subs["trialing"] += count
        if status == "expired":
            subs["expired"] += count
        if status == "past_due":
            subs["pastDue"] += count
        if status == "cancelled":
            subs["cancelled"] += count

    volume = [{"date": day_key(-(days - 1 - i)), "total": 0, "delivered": 0, "failed": 0} for i in range(days)]
    by_date = {v["date"]: v for v in volume}
    for row in volume_rows:
        v = by_date.get(row["serviceDate"])
        if not v:
            continue
        count, status = row["_count"]["_all"], str(row["status"])
        v["total"] += count
        if status == "delivered":
            v["delivered"] += count
        if status == "failed":
            v["failed"] += count

    trend_days = [day_key(-(29 - i)) for i in range(30)]
    new_subs_by_day: dict[str, int] = {}
    for s in subs_recent:
        k = today_key(s.createdAt)
        new_subs_by_day[k] = new_subs_by_day.get(k, 0) + 1
    revenue_by_day: dict[str, dict] = {}
    for p in payments_recent:
        m = revenue_by_day.setdefault(today_key(p.paidAt), {})
        m[p.currency] = round2(m.get(p.currency, 0) + p.amount)

    riders = await user_names([d.riderId for d in recent] + [r.riderId for r in live_routes])
    progress = (await db.delivery.group_by(by=["routeId", "status"], where={"routeId": {"in": [r.id for r in live_routes]}}, count=True)
                if live_routes else [])

    def live(r: Any) -> dict:
        mine = [p for p in progress if p["routeId"] == r.id]
        open_count = sum(p["_count"]["_all"] for p in mine if str(p["status"]) in OPEN)
        closed = sum(p["_count"]["_all"] for p in mine if str(p["status"]) not in OPEN)
        return {"id": r.id, "rider": riders.get(r.riderId, "Unknown"), "done": closed, "total": open_count + closed, "startedAt": r.startedAt}

    return {
        "metrics": {
            "riders": rider_count, "ridersChangePct": pct(new_riders7, new_riders_prev7),
            "activeRiders24h": active_riders24h, "activeRoutes": active_routes,
            "deliveriesToday": deliveries_today, "deliveriesWeek": del7, "deliveriesChangePct": pct(del7, del_prev7),
            "subscriptionRevenueMonth": [{"currency": c["currency"], "amount": round2((c.get("_sum") or {}).get("amount") or 0)} for c in revenue_month],
        },
        "subscriptions": subs,
        "volume": volume,
        "subscriptionGrowth": [{"date": d, "newSubscriptions": new_subs_by_day.get(d, 0)} for d in trend_days],
        "revenueTrend": [{"date": d, "byCurrency": revenue_by_day.get(d, {})} for d in trend_days],
        "liveRoutes": [live(r) for r in live_routes],
        "recentDeliveries": [{**serialize_delivery(d), "riderName": riders.get(d.riderId)} for d in recent],
    }


# ---------- Riders ----------

async def list_riders(q: dict) -> tuple[list[dict], dict]:
    page, limit, skip = paginate(q)
    where: dict[str, Any] = {"role": "rider"}
    if q.get("status"):
        where["status"] = q["status"]
    if q.get("search"):
        where["OR"] = [{"fullName": _rx(q["search"])}, {"email": _rx(q["search"])}, {"phone": _rx(q["search"])}]
    users, total = await asyncio.gather(
        db.user.find_many(where=where, order=[{"createdAt": "desc"}, {"id": "desc"}], skip=skip, take=limit),
        db.user.count(where=where),
    )
    ids = [u.id for u in users]
    subs, groups = await asyncio.gather(
        db.subscription.find_many(where={"userId": {"in": ids}}) if ids else asyncio.sleep(0, []),
        db.delivery.group_by(by=["riderId"], where={"riderId": {"in": ids}}, count=True) if ids else asyncio.sleep(0, []),
    )
    sub_by_user = {s.userId: s for s in subs}
    counts = {g["riderId"]: g["_count"]["_all"] for g in groups}
    items = [{
        "id": u.id, "fullName": u.fullName, "email": u.email, "phone": u.phone, "status": str(u.status),
        "subscriptionStatus": effective_status(sub_by_user[u.id]) if u.id in sub_by_user else None,
        "deliveries": counts.get(u.id, 0), "lastActiveAt": u.lastActiveAt, "registeredAt": u.createdAt,
    } for u in users]
    return items, page_meta(page, limit, total)


async def update_rider(rider_id: str, patch: dict) -> dict:
    user = await db.user.find_first(where={"id": rider_id, "role": "rider"})
    if not user:
        raise not_found("Rider")
    user = await db.user.update(where={"id": user.id}, data=patch)
    if patch.get("status") == "suspended":
        await db.refreshtoken.update_many(where={"userId": user.id, "revokedAt": None}, data={"revokedAt": now()})
    return serialize_user(user)


# ---------- Deliveries ----------

async def decorate_deliveries(docs: list[Any]) -> list[dict]:
    riders = await user_names([d.riderId for d in docs])
    return [{**serialize_delivery(d), "riderName": riders.get(d.riderId)} for d in docs]


# ---------- Reports ----------

async def list_reports(q: dict) -> tuple[list[dict], dict]:
    page, limit, skip = paginate(q)
    where: dict[str, Any] = {}
    if q.get("riderId"):
        where["riderId"] = q["riderId"]
    if q.get("dateFrom") or q.get("dateTo"):
        where["date"] = {**({"gte": q["dateFrom"]} if q.get("dateFrom") else {}), **({"lte": q["dateTo"]} if q.get("dateTo") else {})}
    if q.get("search"):
        users = await db.user.find_many(where={"OR": [{"fullName": _rx(q["search"])}, {"email": _rx(q["search"])}]})
        where["riderId"] = {"in": [u.id for u in users]}
    reports, total = await asyncio.gather(
        db.report.find_many(where=where, order=[{"date": "desc"}, {"generatedAt": "desc"}, {"id": "desc"}], skip=skip, take=limit),
        db.report.count(where=where),
    )
    riders = await user_names([r.riderId for r in reports])
    return [serialize_report(r, riderName=riders.get(r.riderId)) for r in reports], page_meta(page, limit, total)


# ---------- Subscriptions, plans, payments ----------

async def _rider_ids_matching(search: str) -> list[str]:
    users = await db.user.find_many(where={"role": "rider", "OR": [{"fullName": _rx(search)}, {"email": _rx(search)}]})
    return [u.id for u in users]


async def list_subscriptions(q: dict) -> tuple[list[dict], dict]:
    page, limit, skip = paginate(q)
    where: dict[str, Any] = {}
    for key in ("status", "planKey", "billingCycle"):
        if q.get(key):
            where[key] = q[key]
    if q.get("search"):
        where["userId"] = {"in": await _rider_ids_matching(q["search"])}
    subs, total = await asyncio.gather(
        db.subscription.find_many(where=where, order=[{"createdAt": "desc"}, {"id": "desc"}], skip=skip, take=limit),
        db.subscription.count(where=where),
    )
    riders = await user_names([s.userId for s in subs])
    return [{**serialize_subscription(s), "riderName": riders.get(s.userId)} for s in subs], page_meta(page, limit, total)


async def list_plans() -> list[dict]:
    plans, counts = await asyncio.gather(
        db.plan.find_many(order={"monthlyPrice": "asc"}),
        db.subscription.group_by(by=["planKey"], count=True),
    )
    by_key = {str(c["planKey"]): c["_count"]["_all"] for c in counts}
    return [{**serialize_plan(p), "subscribers": by_key.get(str(p.key), 0)} for p in plans]


async def update_plan(key: str, patch: dict) -> dict:
    plan = await db.plan.find_unique(where={"key": key})
    if not plan:
        raise not_found("Plan")
    if key == "trial" and patch.get("active") is False:
        raise conflict("The free trial plan cannot be disabled", "INVALID_STATE")
    data = {k: v for k, v in patch.items() if k != "limits"}
    for k, v in (patch.get("limits") or {}).items():
        data[k] = v
    return serialize_plan(await db.plan.update(where={"key": key}, data=data) if data else plan)


def serialize_payment(p: Any, rider_name: str | None = None) -> dict:
    return {
        "id": p.id, "userId": p.userId, "riderName": rider_name, "planKey": str(p.planKey), "billingCycle": str(p.billingCycle),
        "amount": p.amount, "currency": p.currency, "status": str(p.status), "provider": p.provider, "providerRef": p.providerRef,
        "paidAt": p.paidAt, "createdAt": p.createdAt,
    }


async def list_payments(q: dict) -> tuple[list[dict], dict, list[dict]]:
    page, limit, skip = paginate(q)
    where: dict[str, Any] = {}
    if q.get("status"):
        where["status"] = q["status"]
    if q.get("riderId"):
        where["userId"] = q["riderId"]
    if q.get("search"):
        where["userId"] = {"in": await _rider_ids_matching(q["search"])}
    payments, total, totals = await asyncio.gather(
        db.payment.find_many(where=where, order=[{"createdAt": "desc"}, {"id": "desc"}], skip=skip, take=limit),
        db.payment.count(where=where),
        db.payment.group_by(by=["status", "currency"], count=True, sum={"amount": True}),
    )
    riders = await user_names([p.userId for p in payments])
    return (
        [serialize_payment(p, riders.get(p.userId)) for p in payments],
        page_meta(page, limit, total),
        [{"status": str(t["status"]), "currency": t["currency"], "count": t["_count"]["_all"], "amount": round2((t.get("_sum") or {}).get("amount") or 0)}
         for t in totals],
    )


# ---------- Audit ----------

async def list_audit_logs(q: dict) -> tuple[list[dict], dict]:
    page, limit, skip = paginate(q)
    where: dict[str, Any] = {}
    if q.get("status"):
        where["status"] = q["status"]
    if q.get("action"):
        where["action"] = _rx(q["action"])
    if q.get("search"):
        where["OR"] = [{"actorEmail": _rx(q["search"])}, {"targetId": _rx(q["search"])}, {"action": _rx(q["search"])}]
    if q.get("dateFrom") or q.get("dateTo"):
        created: dict[str, Any] = {}
        if q.get("dateFrom"):
            created["gte"] = datetime.fromisoformat(f"{q['dateFrom']}T00:00:00+00:00")
        if q.get("dateTo"):
            created["lte"] = datetime.fromisoformat(f"{q['dateTo']}T23:59:59.999000+00:00")
        where["createdAt"] = created
    logs, total = await asyncio.gather(
        db.auditlog.find_many(where=where, order=[{"createdAt": "desc"}, {"id": "desc"}], skip=skip, take=limit),
        db.auditlog.count(where=where),
    )
    items = [{"id": l.id, "createdAt": l.createdAt, "actorEmail": l.actorEmail, "action": l.action, "targetType": l.targetType,
              "targetId": l.targetId, "status": str(l.status), "ip": l.ip or None, "meta": l.meta} for l in logs]
    return items, page_meta(page, limit, total)
