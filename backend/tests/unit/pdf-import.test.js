import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractDeliveriesFromText } from '../../src/services/pdf-import.service.js';
import { cleanDeliveryAddress } from '../../src/services/serializers.js';

test('extracts COD and prepaid deliveries and flags ambiguous payment for review', () => {
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
  assert.equal(items[0].paymentType, 'cod');
  assert.equal(items[0].codAmount, 3200);
  assert.equal(items[1].paymentType, 'prepaid');
  assert.equal(items[1].orderValue, 1500);
  assert.equal(items[2].paymentType, null, 'must never guess an ambiguous payment type');
  assert.ok(items[2].flags.includes('payment_needs_review'));
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
  assert.equal(items[0].paymentType, null);
  assert.ok(items[0].flags.includes('payment_needs_review'));
});

test('separates a trailing COD amount from a table address', () => {
  const [item] = extractDeliveriesFromText(`
Order ID Customer Phone Delivery Address
ORD-1009 Fahad Aslam 0300-0001009 House 14, Main Bazar, Narowal COD PKR 1,575
`);

  assert.equal(item.address, 'House 14, Main Bazar, Narowal');
  assert.equal(item.paymentType, 'cod');
  assert.equal(item.codAmount, 1575);
  assert.ok(!item.flags.includes('payment_needs_review'));
});

test('cleans a saved COD suffix only when its amount matches the payment record', () => {
  assert.equal(cleanDeliveryAddress('House 14, Main Bazar, Narowal COD PKR 1,575', { type: 'cod', codAmount: 1575 }), 'House 14, Main Bazar, Narowal');
  assert.equal(cleanDeliveryAddress('Flat COD 12, Narowal', { type: 'cod', codAmount: 1575 }), 'Flat COD 12, Narowal');
});
