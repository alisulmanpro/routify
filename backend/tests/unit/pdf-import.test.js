import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractDeliveriesFromText } from '../../src/services/pdf-import.service.js';
import { cleanDeliveryAddress } from '../../src/services/serializers.js';

test('extracts deliveries from labelled blocks without exposing payment details', () => {
  const text = `
Tracking ID: TCS-5001
Customer Name: Bilal Ahmed
Phone: 0333-4445566
Address: House 12, Street 4, Gulshan-e-Iqbal, Karachi
Payment Type: COD
COD Amount: 3200

Tracking ID: TCS-5002
Customer Name: Sana Riaz
Phone: 0321-7778899
Address: Flat 3B, Clifton Block 2, Karachi
Payment Type: Prepaid
Order Value: 1500

Tracking ID: TCS-5003
Customer Name: Unclear Payment Case
Phone: 0300-1112223
Address: Model Town, Lahore
Note: payment on delivery maybe
`;
  const items = extractDeliveriesFromText(text);
  assert.equal(items.length, 3);
  assert.equal(items[0].trackingId, 'TCS-5001');
  assert.equal(items[0].address, 'House 12, Street 4, Gulshan-e-Iqbal, Karachi');
  for (const item of items) {
    assert.ok(!('paymentType' in item) && !('codAmount' in item) && !('orderValue' in item));
    assert.ok(!item.flags.includes('payment_needs_review'));
  }
});

test('flags a delivery block with no address', () => {
  const [item] = extractDeliveriesFromText('Tracking ID: X-1\nCustomer Name: A\nPhone: 03001234567\nPayment Type: COD\nCOD Amount: 100\n');
  assert.ok(item.flags.includes('missing_address'));
});

test('extracts deliveries from a courier table with Order ID, Customer, Phone and Delivery Address columns', () => {
  const text = `
Delivery Planner
FAKE / TEST DELIVERY ORDERS
Order ID Customer Phone Delivery Address
ORD-1001 Ali Raza 0300-0001001 House 12, Street 3, Circular Road, Narowal
ORD-1002 Usman Ahmed 0300-0001002 House 45, Mohalla Islam Pura, Narowal
`;

  const items = extractDeliveriesFromText(text);
  assert.equal(items.length, 2);
  assert.equal(items[0].trackingId, 'ORD-1001');
  assert.equal(items[0].customerName, 'Ali Raza');
  assert.equal(items[0].phone, '0300-0001001');
  assert.equal(items[0].address, 'House 12, Street 3, Circular Road, Narowal');
  assert.ok(!('paymentType' in items[0]));
});

test('strips a trailing COD amount from a table address', () => {
  const [item] = extractDeliveriesFromText(`
Order ID Customer Phone Delivery Address
ORD-1009 Fahad Aslam 0300-0001009 House 14, Main Bazar, Narowal COD PKR 1,575
`);

  assert.equal(item.address, 'House 14, Main Bazar, Narowal');
  assert.ok(!('codAmount' in item));
});

test('cleans a saved COD suffix only when its amount matches the payment record', () => {
  assert.equal(cleanDeliveryAddress('House 14, Main Bazar, Narowal COD PKR 1,575', { type: 'cod', codAmount: 1575 }), 'House 14, Main Bazar, Narowal');
  assert.equal(cleanDeliveryAddress('Flat COD 12, Narowal', { type: 'cod', codAmount: 1575 }), 'Flat COD 12, Narowal');
});
