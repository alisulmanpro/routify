"""In-app purchases: the mock store end to end, and the Apple / Google adapters with the stores' signatures stubbed out."""
from __future__ import annotations

import base64
import json
import time
from datetime import datetime, timedelta
from types import SimpleNamespace

import pytest

from app.config import env
from app.db import db
from app.http import now
from app.services.billing import account_token, apple, google

from .test_api import delivery, make_admin, rider


@pytest.fixture
def stores():
    """Turns on the Apple and Google adapters for one test (their network/signature calls are stubbed per test)."""
    saved = (env.payment_stores, env.APPLE_BUNDLE_ID, env.GOOGLE_PACKAGE_NAME)
    object.__setattr__(env, "payment_stores", ("mock", "apple", "google"))
    object.__setattr__(env, "APPLE_BUNDLE_ID", "com.example.routify")
    object.__setattr__(env, "GOOGLE_PACKAGE_NAME", "com.example.routify")
    yield
    for name, value in zip(("payment_stores", "APPLE_BUNDLE_ID", "GOOGLE_PACKAGE_NAME"), saved):
        object.__setattr__(env, name, value)


async def mine(client, auth):
    return (await client.get("/api/v1/subscriptions/me", headers=auth)).json()["data"]


async def buy_mock(client, auth, product="starter.monthly"):
    return await client.post("/api/v1/subscriptions/purchases", headers=auth, json={"store": "mock", "productId": product})


async def event(client, auth, name):
    res = await client.post("/api/v1/subscriptions/mock/events", headers=auth, json={"event": name})
    assert res.status_code == 200, res.text
    return res.json()["data"]


# ---------------------------------------------------------------- mock store

async def test_store_config_lists_products_and_a_stable_account_token(client):
    body, auth = await rider(client, "store-config@example.com")
    data = (await client.get("/api/v1/subscriptions/store", headers=auth)).json()["data"]
    assert data["stores"] == ["mock"]
    assert {(p["productId"], p["planKey"], p["billingCycle"]) for p in data["products"]["mock"]} >= {("starter.monthly", "starter", "monthly"), ("pro.annual", "pro", "annual")}
    assert data["accountToken"] == account_token(body["user"]["id"])
    assert data["accountToken"] != account_token("0" * 24)


async def test_mock_purchase_lifecycle(client):
    body, auth = await rider(client, "mock-life@example.com")
    res = await buy_mock(client, auth)
    assert res.status_code == 200, res.text
    data = res.json()["data"]
    assert data["subscription"]["planKey"] == "starter" and data["subscription"]["status"] == "active"
    assert data["subscription"]["storeManaged"] is True and data["store"]["store"] == "mock" and data["store"]["testMode"] is True
    period_end = data["subscription"]["currentPeriodEnd"]

    # Store-billed plans are changed in the store, not through the manual request flow.
    assert (await client.post("/api/v1/subscriptions", headers=auth, json={"planKey": "pro", "billingCycle": "monthly"})).json()["error"]["code"] == "STORE_MANAGED"
    assert (await client.post("/api/v1/subscriptions/cancel", headers=auth)).json()["error"]["code"] == "STORE_MANAGED"

    cancelled = await event(client, auth, "cancel")
    assert cancelled["subscription"]["cancelAtPeriodEnd"] is True and cancelled["subscription"]["status"] == "active"
    renewed = await event(client, auth, "renew")
    assert renewed["subscription"]["currentPeriodEnd"] > period_end and renewed["subscription"]["cancelAtPeriodEnd"] is False

    payments = await db.payment.find_many(where={"userId": body["user"]["id"], "provider": "mock"})
    assert len(payments) == 2 and all(p.testMode and str(p.status) == "succeeded" for p in payments)

    # A failed renewal blocks new work until the payment recovers.
    await event(client, auth, "fail_renewal")
    blocked = await client.post("/api/v1/deliveries/manual", headers=auth, json=delivery("MOCK-PD-1"))
    assert blocked.status_code == 403 and blocked.json()["error"]["code"] == "SUBSCRIPTION_EXPIRED"
    assert (await event(client, auth, "recover"))["subscription"]["status"] == "active"
    assert (await client.post("/api/v1/deliveries/manual", headers=auth, json=delivery("MOCK-PD-2"))).status_code == 201

    # A refund ends access at once and marks the payment refunded; the rider can buy again.
    refunded = await event(client, auth, "refund")
    assert refunded["subscription"]["status"] == "expired" and refunded["subscription"]["storeManaged"] is False
    assert await db.payment.count(where={"userId": body["user"]["id"], "status": "refunded"}) == 1
    assert (await buy_mock(client, auth, "pro.annual")).json()["data"]["subscription"]["planKey"] == "pro"


async def test_grace_period_keeps_access(client):
    _, auth = await rider(client, "mock-grace@example.com")
    await buy_mock(client, auth)
    graced = await event(client, auth, "grace")
    assert graced["subscription"]["status"] == "active"
    assert (await client.post("/api/v1/deliveries/manual", headers=auth, json=delivery("GRACE-1"))).status_code == 201
    assert (await event(client, auth, "expire"))["subscription"]["status"] == "expired"


async def test_mock_purchase_rejects_unknown_products_and_disabled_stores(client):
    _, auth = await rider(client, "mock-bad@example.com")
    assert (await buy_mock(client, auth, "gold.monthly")).json()["error"]["code"] == "UNKNOWN_PRODUCT"
    assert (await buy_mock(client, auth, "trial.monthly")).json()["error"]["code"] == "UNKNOWN_PRODUCT"
    apple_off = await client.post("/api/v1/subscriptions/purchases", headers=auth, json={"store": "apple", "receipt": "x" * 40})
    assert apple_off.status_code == 400 and apple_off.json()["error"]["code"] == "STORE_DISABLED"
    assert (await client.post("/api/v1/billing/webhooks/apple", json={"signedPayload": "x" * 40})).json()["error"]["code"] == "STORE_DISABLED"


async def test_store_purchase_replaces_a_pending_manual_request(client):
    _, auth = await rider(client, "mock-pending@example.com")
    requested = await client.post("/api/v1/subscriptions", headers=auth, json={"planKey": "pro", "billingCycle": "monthly"})
    payment_id = requested.json()["data"]["payment"]["id"]
    await buy_mock(client, auth)
    assert str((await db.payment.find_unique(where={"id": payment_id})).status) == "failed"
    assert (await mine(client, auth))["subscription"]["pending"] is None


async def test_test_payments_never_count_as_revenue(client):
    headers, _ = await make_admin(client, "billing-admin@example.com")
    _, auth = await rider(client, "mock-revenue@example.com")
    before = (await client.get("/api/v1/admin/payments", headers=headers)).json()["totals"]
    await buy_mock(client, auth, "pro.monthly")
    listed = (await client.get("/api/v1/admin/payments", headers=headers)).json()
    assert listed["totals"] == before
    assert any(p["provider"] == "mock" and p["testMode"] for p in listed["data"])


# ---------------------------------------------------------------- Apple (signatures stubbed)

def apple_tx(original="1000000001", tx_id="2000000001", product="routify.starter.monthly", days=30, token=None, revoked=False, signed=None, price=4990):
    ms = lambda d: int(d.timestamp() * 1000)
    return SimpleNamespace(originalTransactionId=original, transactionId=tx_id, productId=product, expiresDate=ms(now() + timedelta(days=days)),
                           revocationDate=ms(now()) if revoked else None, rawEnvironment="Sandbox", price=price, currency="GBP",
                           appAccountToken=token, isUpgraded=False, signedDate=signed or ms(now()))


@pytest.fixture
def apple_payloads(monkeypatch):
    """`_decode` normally checks Apple's certificate chain; here each payload string is a key into this table."""
    table: dict[str, object] = {}
    monkeypatch.setattr(apple, "_decode", lambda method, payload: table[payload])
    return table


async def test_apple_purchase_renewal_and_refund(client, stores, apple_payloads):
    body, auth = await rider(client, "apple-rider@example.com")
    token = account_token(body["user"]["id"])
    apple_payloads["jws-buy-receipt"] = apple_tx(token=token)
    res = await client.post("/api/v1/subscriptions/purchases", headers=auth, json={"store": "apple", "receipt": "jws-buy-receipt"})
    assert res.status_code == 200, res.text
    sub = res.json()["data"]["subscription"]
    assert sub["planKey"] == "starter" and sub["status"] == "active" and sub["currency"] == "GBP" and sub["price"] == 4.99

    # Renewal notification (DID_RENEW) with renewal info: auto-renew off now, new transaction, longer period.
    renewal = SimpleNamespace(rawAutoRenewStatus=0, gracePeriodExpiresDate=None, isInBillingRetryPeriod=False)
    apple_payloads["note-renew"] = SimpleNamespace(rawNotificationType="DID_RENEW", signedDate=int(time.time() * 1000) + 1000,
                                                   data=SimpleNamespace(signedTransactionInfo="tx-renew", signedRenewalInfo="ri-renew"))
    apple_payloads["tx-renew"] = apple_tx(tx_id="2000000002", days=60, token=token)
    apple_payloads["ri-renew"] = renewal
    assert (await client.post("/api/v1/billing/webhooks/apple", json={"signedPayload": "note-renew"})).status_code == 200
    sub = (await mine(client, auth))["subscription"]
    assert sub["cancelAtPeriodEnd"] is True and sub["currentPeriodEnd"] > res.json()["data"]["subscription"]["currentPeriodEnd"]
    assert await db.payment.count(where={"userId": body["user"]["id"], "provider": "apple"}) == 2

    # The app re-sending its first (older) receipt cannot shorten the renewed period.
    period_end = sub["currentPeriodEnd"]
    await client.post("/api/v1/subscriptions/purchases", headers=auth, json={"store": "apple", "receipt": "jws-buy-receipt"})
    assert (await mine(client, auth))["subscription"]["currentPeriodEnd"] == period_end
    assert await db.payment.count(where={"userId": body["user"]["id"], "provider": "apple"}) == 2  # same transaction: no new payment

    apple_payloads["note-refund"] = SimpleNamespace(rawNotificationType="REFUND", signedDate=int(time.time() * 1000) + 2000,
                                                    data=SimpleNamespace(signedTransactionInfo="tx-refund", signedRenewalInfo=None))
    apple_payloads["tx-refund"] = apple_tx(tx_id="2000000002", days=60, token=token, revoked=True)
    await client.post("/api/v1/billing/webhooks/apple", json={"signedPayload": "note-refund"})
    assert (await mine(client, auth))["subscription"]["status"] == "expired"
    assert await db.payment.count(where={"userId": body["user"]["id"], "provider": "apple", "status": "refunded"}) == 1


async def test_apple_receipts_cannot_be_moved_between_accounts(client, stores, apple_payloads):
    owner, owner_auth = await rider(client, "apple-owner@example.com")
    _, thief_auth = await rider(client, "apple-thief@example.com")
    apple_payloads["owner-jws-receipt"] = apple_tx(original="3000000001", tx_id="3000000002", token=account_token(owner["user"]["id"]))
    apple_payloads["untagged-jws"] = apple_tx(original="3000000001", tx_id="3000000003")
    # Tagged for another account: refused.
    stolen = await client.post("/api/v1/subscriptions/purchases", headers=thief_auth, json={"store": "apple", "receipt": "owner-jws-receipt"})
    assert stolen.status_code == 409 and stolen.json()["error"]["code"] == "PURCHASE_OTHER_ACCOUNT"
    assert (await client.post("/api/v1/subscriptions/purchases", headers=owner_auth, json={"store": "apple", "receipt": "owner-jws-receipt"})).status_code == 200
    # Untagged, but already linked to the owner: still refused.
    reused = await client.post("/api/v1/subscriptions/purchases", headers=thief_auth, json={"store": "apple", "receipt": "untagged-jws"})
    assert reused.status_code == 409


async def test_apple_out_of_order_notifications_do_not_roll_back(client, stores, apple_payloads):
    body, auth = await rider(client, "apple-order@example.com")
    token = account_token(body["user"]["id"])
    apple_payloads["jws-receipt-1"] = apple_tx(original="4000000001", tx_id="4000000002", token=token)
    await client.post("/api/v1/subscriptions/purchases", headers=auth, json={"store": "apple", "receipt": "jws-receipt-1"})
    old = int((now() - timedelta(days=1)).timestamp() * 1000)
    apple_payloads["late-expired"] = SimpleNamespace(rawNotificationType="EXPIRED", signedDate=old,
                                                     data=SimpleNamespace(signedTransactionInfo="tx-old", signedRenewalInfo=None))
    apple_payloads["tx-old"] = apple_tx(original="4000000001", tx_id="4000000000", days=-1, token=token)
    await client.post("/api/v1/billing/webhooks/apple", json={"signedPayload": "late-expired"})
    assert (await mine(client, auth))["subscription"]["status"] == "active"


async def test_bad_apple_signature_is_rejected(client, stores):
    res = await client.post("/api/v1/billing/webhooks/apple", json={"signedPayload": "not.a.valid-jws-token"})
    assert res.status_code == 422 and res.json()["error"]["code"] == "INVALID_RECEIPT"


# ---------------------------------------------------------------- Google (Play API stubbed)

def play_sub(state="SUBSCRIPTION_STATE_ACTIVE", base_plan="monthly", order="GPA.1111-2222-3333-44444", days=30, token=None, linked=None, ack=True):
    data = {
        "subscriptionState": state, "testPurchase": {},
        "acknowledgementState": "ACKNOWLEDGEMENT_STATE_PENDING" if ack else "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
        "lineItems": [{"productId": "routify_pro", "expiryTime": (now() + timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S.%f") + "789Z",
                       "offerDetails": {"basePlanId": base_plan}, "latestSuccessfulOrderId": order,
                       "autoRenewingPlan": {"autoRenewEnabled": True, "recurringPrice": {"currencyCode": "EUR", "units": "9", "nanos": 990000000}}}],
    }
    if token:
        data["externalAccountIdentifiers"] = {"obfuscatedExternalAccountId": token}
    if linked:
        data["linkedPurchaseToken"] = linked
    return data


@pytest.fixture
def play(monkeypatch):
    state = {"subs": {}, "acked": []}

    async def fetch(token):
        return state["subs"][token]

    async def ack(product, token):
        state["acked"].append((product, token))

    monkeypatch.setattr(google, "fetch_subscription", fetch)
    monkeypatch.setattr(google, "acknowledge", ack)
    monkeypatch.setattr(google, "_verify_push_token", lambda authorization: None)
    return state


def push(message: dict) -> dict:
    return {"message": {"data": base64.b64encode(json.dumps({"packageName": "com.example.routify", **message}).encode()).decode(), "messageId": "1"}}


async def test_google_purchase_upgrade_and_voided_refund(client, stores, play):
    body, auth = await rider(client, "play-rider@example.com")
    token = account_token(body["user"]["id"])
    play["subs"]["tok-1-aaaaaaaaaa"] = play_sub(token=token)
    res = await client.post("/api/v1/subscriptions/purchases", headers=auth, json={"store": "google", "receipt": "tok-1-aaaaaaaaaa", "productId": "routify_pro"})
    assert res.status_code == 200, res.text
    sub = res.json()["data"]["subscription"]
    assert sub["planKey"] == "pro" and sub["billingCycle"] == "monthly" and sub["currency"] == "EUR" and sub["price"] == 9.99
    assert play["acked"] == [("routify_pro", "tok-1-aaaaaaaaaa")]

    # Switching to the annual base plan issues a new token linked to the old one (RTDN SUBSCRIPTION_PURCHASED).
    play["subs"]["tok-2-bbbbbbbbbb"] = play_sub(base_plan="annual", order="GPA.9999-0000-1111-22222", days=365, token=token, linked="tok-1-aaaaaaaaaa", ack=False)
    note = push({"subscriptionNotification": {"notificationType": 4, "purchaseToken": "tok-2-bbbbbbbbbb", "subscriptionId": "routify_pro"}})
    assert (await client.post("/api/v1/billing/webhooks/google", json=note)).status_code == 200
    sub = (await mine(client, auth))["subscription"]
    assert sub["billingCycle"] == "annual"
    old = await db.storepurchase.find_unique(where={"store_purchaseKey": {"store": "google", "purchaseKey": "tok-1-aaaaaaaaaa"}})
    assert old.status == "expired"

    voided = push({"voidedPurchaseNotification": {"purchaseToken": "tok-2-bbbbbbbbbb", "orderId": "GPA.9999-0000-1111-22222", "productType": 1}})
    await client.post("/api/v1/billing/webhooks/google", json=voided)
    assert (await mine(client, auth))["subscription"]["status"] == "expired"
    assert await db.payment.count(where={"userId": body["user"]["id"], "provider": "google", "status": "refunded"}) == 1


async def test_google_pending_and_foreign_packages(client, stores, play):
    _, auth = await rider(client, "play-pending@example.com")
    play["subs"]["tok-pending-cccc"] = play_sub(state="SUBSCRIPTION_STATE_PENDING")
    res = await client.post("/api/v1/subscriptions/purchases", headers=auth, json={"store": "google", "receipt": "tok-pending-cccc"})
    assert res.status_code == 409 and res.json()["error"]["code"] == "PURCHASE_PENDING"
    other = {"message": {"data": base64.b64encode(json.dumps({"packageName": "com.evil.app", "subscriptionNotification": {"purchaseToken": "x"}}).encode()).decode()}}
    assert (await client.post("/api/v1/billing/webhooks/google", json=other)).status_code == 200


async def test_google_webhook_requires_a_push_token(client, stores):
    res = await client.post("/api/v1/billing/webhooks/google", json=push({}))
    assert res.status_code == 401 and res.json()["error"]["code"] == "INVALID_WEBHOOK"


def test_google_timestamps_with_nanoseconds():
    from app.services.billing.base import from_rfc3339

    assert from_rfc3339("2026-01-02T03:04:05.123456789Z").microsecond == 123456
    assert from_rfc3339("2026-01-02T03:04:05Z").year == 2026


# ---------------------------------------------------------------- store-run free trials

async def test_mock_free_trial_then_first_charge(client):
    body, auth = await rider(client, "mock-trial@example.com")
    res = await client.post("/api/v1/subscriptions/purchases", headers=auth, json={"store": "mock", "productId": "pro.monthly", "trial": True})
    sub = res.json()["data"]["subscription"]
    assert sub["planKey"] == "pro" and sub["status"] == "trialing"
    assert await db.payment.count(where={"userId": body["user"]["id"]}) == 0  # nothing charged during the trial
    assert (await client.post("/api/v1/deliveries/manual", headers=auth, json=delivery("TRIAL-1"))).status_code == 201

    assert (await event(client, auth, "cancel"))["subscription"]["status"] == "trialing"  # still in the trial, just won't convert
    converted = await event(client, auth, "renew")
    assert converted["subscription"]["status"] == "active"
    assert await db.payment.count(where={"userId": body["user"]["id"], "status": "succeeded"}) == 1


async def test_apple_free_trial_is_not_revenue(client, stores, apple_payloads):
    body, auth = await rider(client, "apple-trial@example.com")
    tx = apple_tx(original="5000000001", tx_id="5000000002", product="routify.pro.monthly", token=account_token(body["user"]["id"]), price=0)
    tx.rawOfferDiscountType = "FREE_TRIAL"
    apple_payloads["trial-receipt"] = tx
    sub = (await client.post("/api/v1/subscriptions/purchases", headers=auth, json={"store": "apple", "receipt": "trial-receipt"})).json()["data"]["subscription"]
    assert sub["status"] == "trialing" and sub["planKey"] == "pro"
    assert await db.payment.count(where={"userId": body["user"]["id"]}) == 0


async def test_google_free_trial_is_not_revenue(client, stores, play):
    body, auth = await rider(client, "play-trial@example.com")
    data = play_sub(token=account_token(body["user"]["id"]))
    data["lineItems"][0]["offerPhase"] = {"freeTrial": {}}
    play["subs"]["tok-trial-dddd"] = data
    sub = (await client.post("/api/v1/subscriptions/purchases", headers=auth, json={"store": "google", "receipt": "tok-trial-dddd"})).json()["data"]["subscription"]
    assert sub["status"] == "trialing"
    assert await db.payment.count(where={"userId": body["user"]["id"]}) == 0
    assert play["acked"]  # trials must be acknowledged too, or Google cancels them


async def test_one_free_trial_per_account(client):
    _, auth = await rider(client, "mock-one-trial@example.com")
    config = (await client.get("/api/v1/subscriptions/store", headers=auth)).json()["data"]
    assert config["trialEligible"] == {"mock": True}
    await client.post("/api/v1/subscriptions/purchases", headers=auth, json={"store": "mock", "productId": "pro.monthly", "trial": True})
    await event(client, auth, "expire")
    assert (await client.get("/api/v1/subscriptions/store", headers=auth)).json()["data"]["trialEligible"] == {"mock": False}
    again = await client.post("/api/v1/subscriptions/purchases", headers=auth, json={"store": "mock", "productId": "pro.monthly", "trial": True})
    assert again.json()["data"]["subscription"]["status"] == "active"  # no second trial: charged straight away


# ---------------------------------------------------------------- no free trial without a card

async def test_new_riders_start_without_a_plan(client):
    _, auth = await rider(client, "no-plan@example.com", subscribed=False)
    sub = (await mine(client, auth))["subscription"]
    assert sub["status"] == "inactive"
    blocked = await client.post("/api/v1/deliveries/manual", headers=auth, json=delivery("NOPLAN-1"))
    assert blocked.status_code == 403 and blocked.json()["error"]["code"] == "SUBSCRIPTION_REQUIRED"


async def test_store_trial_length_follows_the_admin_setting(client):
    from app.services.settings_service import update_settings

    headers, _ = await make_admin(client, "trial-admin@example.com")
    assert (await client.put("/api/v1/admin/settings", headers=headers, json={"trialDays": 10})).status_code == 400  # only 7, 14 or 30
    try:
        assert (await client.put("/api/v1/admin/settings", headers=headers, json={"trialDays": 7})).status_code == 200
        _, auth = await rider(client, "trial-7@example.com", subscribed=False)
        config = (await client.get("/api/v1/subscriptions/store", headers=auth)).json()["data"]
        assert config["trialDays"] == 7
        assert (await client.get("/api/v1/config")).json()["data"]["trialDays"] == 7
        res = await client.post("/api/v1/subscriptions/purchases", headers=auth, json={"store": "mock", "productId": "pro.monthly", "trial": True})
        sub = res.json()["data"]["subscription"]
        days = (datetime.fromisoformat(sub["currentPeriodEnd"].replace("Z", "+00:00")) - now()).total_seconds() / 86400
        assert sub["status"] == "trialing" and 6.9 < days <= 7
        blocked_before = await client.post("/api/v1/deliveries/manual", headers=auth, json=delivery("TRIAL7-1"))
        assert blocked_before.status_code == 201  # the store trial unlocks the app
    finally:
        await update_settings({"trialDays": 14})


async def test_google_products_name_the_trial_offer(client, stores):
    _, auth = await rider(client, "offer-id@example.com", subscribed=False)
    config = (await client.get("/api/v1/subscriptions/store", headers=auth)).json()["data"]
    assert all(p["trialOfferId"] == f"free-trial-{config['trialDays']}d" for p in config["products"]["google"])



# ---------------------------------------------------------------- RevenueCat (REST API stubbed)

from app.services.billing import revenuecat  # noqa: E402

RC_AUTH = "Bearer test-webhook-secret-123456"


@pytest.fixture
def rc(monkeypatch):
    """Turns RevenueCat on and serves each rider's subscriber JSON from a dict instead of api.revenuecat.com."""
    saved = (env.payment_stores, env.REVENUECAT_SECRET_API_KEY, env.REVENUECAT_WEBHOOK_AUTH)
    object.__setattr__(env, "payment_stores", ("mock", "revenuecat"))
    object.__setattr__(env, "REVENUECAT_SECRET_API_KEY", "sk_test")
    object.__setattr__(env, "REVENUECAT_WEBHOOK_AUTH", RC_AUTH)
    subscribers: dict[str, dict] = {}

    async def fetch(app_user_id):
        return subscribers.get(app_user_id, {})

    monkeypatch.setattr(revenuecat, "fetch_subscriber", fetch)
    yield subscribers
    for name, value in zip(("payment_stores", "REVENUECAT_SECRET_API_KEY", "REVENUECAT_WEBHOOK_AUTH"), saved):
        object.__setattr__(env, name, value)


def rc_subscriber(product="monthly", days=30, period="normal", store="test_store", tx="tx-1", **extra):
    iso = (now() + timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {"entitlements": {"routify_pro": {"expires_date": iso, "product_identifier": product, "purchase_date": "2026-10-01T00:00:00Z"}},
            "subscriptions": {product: {"expires_date": iso, "period_type": period, "store": store, "is_sandbox": True,
                                        "store_transaction_id": tx, "unsubscribe_detected_at": None, "billing_issues_detected_at": None,
                                        "refunded_at": None, **extra}}}


async def rc_webhook(client, user_id, auth=RC_AUTH):
    return await client.post("/api/v1/billing/webhooks/revenuecat", headers={"Authorization": auth} if auth else {},
                             json={"api_version": "1.0", "event": {"type": "RENEWAL", "app_user_id": user_id, "id": "evt-1"}})


async def test_revenuecat_purchase_trial_renewal_and_refund(client, rc):
    body, auth = await rider(client, "rc-rider@example.com", subscribed=False)
    uid = body["user"]["id"]
    config = (await client.get("/api/v1/subscriptions/store", headers=auth)).json()["data"]
    assert config["entitlement"] == "routify_pro"
    assert {(p["productId"], p["billingCycle"]) for p in config["products"]["revenuecat"]} == {("monthly", "monthly"), ("yearly", "annual")}

    # The app says "I bought something": the server only believes RevenueCat's own record.
    assert (await client.post("/api/v1/subscriptions/purchases", headers=auth, json={"store": "revenuecat"})).json()["data"]["subscription"]["status"] == "inactive"
    rc[uid] = rc_subscriber(period="trial", days=7)
    sub = (await client.post("/api/v1/subscriptions/purchases", headers=auth, json={"store": "revenuecat"})).json()["data"]["subscription"]
    assert sub["status"] == "trialing" and sub["planKey"] == "pro" and sub["billingCycle"] == "monthly"
    assert await db.payment.count(where={"userId": uid}) == 0

    rc[uid] = rc_subscriber(product="yearly", days=365, tx="tx-2")  # trial converted to yearly, reported by webhook
    assert (await rc_webhook(client, uid)).status_code == 200
    sub = (await mine(client, auth))["subscription"]
    assert sub["status"] == "active" and sub["billingCycle"] == "annual"
    payment = await db.payment.find_first(where={"userId": uid, "provider": "revenuecat"})
    assert payment and payment.testMode  # Test Store purchases are never revenue

    rc[uid] = rc_subscriber(product="yearly", days=365, tx="tx-2", refunded_at="2026-10-14T00:00:00Z")
    await rc_webhook(client, uid)
    assert (await mine(client, auth))["subscription"]["status"] == "expired"
    assert await db.payment.count(where={"userId": uid, "status": "refunded"}) == 1


async def test_revenuecat_store_specific_product_ids_map_by_period(client, rc):
    body, auth = await rider(client, "rc-ids@example.com", subscribed=False)
    rc[body["user"]["id"]] = rc_subscriber(product="routify_pro:annual", store="play_store")
    sub = (await client.post("/api/v1/subscriptions/purchases", headers=auth, json={"store": "revenuecat"})).json()["data"]["subscription"]
    assert sub["planKey"] == "pro" and sub["billingCycle"] == "annual"


async def test_revenuecat_webhook_requires_its_authorization(client, rc):
    body, _ = await rider(client, "rc-auth@example.com", subscribed=False)
    rc[body["user"]["id"]] = rc_subscriber()
    for bad in (None, "Bearer wrong", RC_AUTH + "x"):
        res = await rc_webhook(client, body["user"]["id"], auth=bad)
        assert res.status_code == 401 and res.json()["error"]["code"] == "INVALID_WEBHOOK"
    assert not await db.storepurchase.count(where={"userId": body["user"]["id"]})
    # Anonymous / unknown ids (e.g. the dashboard's test event) are acknowledged and ignored.
    assert (await rc_webhook(client, "$RCAnonymousID:abc")).status_code == 200
    assert (await rc_webhook(client, "0123456789abcdef01234567")).status_code == 200


def test_revenuecat_needs_a_secret_key():
    import os

    from app.config import ConfigError, load_settings

    saved = {k: os.environ.get(k) for k in ("PAYMENT_STORES", "REVENUECAT_SECRET_API_KEY", "REVENUECAT_WEBHOOK_AUTH")}
    os.environ.update(PAYMENT_STORES="revenuecat", REVENUECAT_SECRET_API_KEY="test_PublicSdkKey", REVENUECAT_WEBHOOK_AUTH=RC_AUTH)
    try:
        with pytest.raises(ConfigError, match="secret key"):
            load_settings()
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def test_mock_store_in_production_needs_an_explicit_opt_in():
    import os

    from app.config import ConfigError, load_settings

    saved = {k: os.environ.get(k) for k in ("NODE_ENV", "PAYMENT_STORES", "ALLOW_MOCK_STORE", "EMAIL_PROVIDER")}
    os.environ.update(NODE_ENV="production", PAYMENT_STORES="mock", EMAIL_PROVIDER="disabled")
    try:
        os.environ.pop("ALLOW_MOCK_STORE", None)
        with pytest.raises(ConfigError, match="ALLOW_MOCK_STORE"):
            load_settings()
        os.environ["ALLOW_MOCK_STORE"] = "true"
        assert load_settings().payment_stores == ("mock",)
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
