import { haversineKm } from '../utils/geo.js';
import { round2 } from '../utils/http.js';

const ROAD_FACTOR = 1.3; // straight-line → typical urban road distance
const CLUSTER_KM = 0.05;

/**
 * Pure planner. stops: [{ id, latitude, longitude, addressKey }] (all geocoded).
 * preference: 'nearest_first' (greedy) | 'shortest' (greedy + 2-opt) | 'smart' (same-address grouping + 2-opt).
 * Distances are straight-line × 1.3, NOT turn-by-turn road routing.
 */
export function planRoute({ origin, stops, preference, avgSpeedKmh = 25, serviceMinutes = 3 }) {
  if (!stops.length) return { order: [], legs: [], distanceKm: 0, durationMin: 0 };

  const nodes = preference === 'smart' ? cluster(stops) : stops.map((s) => ({ latitude: s.latitude, longitude: s.longitude, members: [s] }));
  const start = origin || { latitude: nodes[0].latitude, longitude: nodes[0].longitude };
  const d = (a, b) => haversineKm(a, b);

  // Greedy nearest neighbour from the start point.
  const remaining = nodes.map((_, i) => i);
  let path = [];
  let here = start;
  while (remaining.length) {
    let best = 0;
    for (let i = 1; i < remaining.length; i += 1) if (d(here, nodes[remaining[i]]) < d(here, nodes[remaining[best]])) best = i;
    const [idx] = remaining.splice(best, 1);
    path.push(idx);
    here = nodes[idx];
  }

  if (preference !== 'nearest_first' && path.length > 2) path = twoOpt(path, nodes, start, d);

  const order = [];
  const legs = [];
  let prev = origin || null;
  let distanceKm = 0;
  for (const idx of path) {
    for (const member of nodes[idx].members) {
      const leg = prev ? round2(d(prev, member) * ROAD_FACTOR) : 0;
      legs.push({ id: member.id, distanceKm: leg, durationMin: Math.round((leg / avgSpeedKmh) * 60) });
      order.push(member.id);
      distanceKm += leg;
      prev = member;
    }
  }
  const travelMin = legs.reduce((sum, l) => sum + l.durationMin, 0);
  return { order, legs, distanceKm: round2(distanceKm), durationMin: travelMin + stops.length * serviceMinutes };
}

function cluster(stops) {
  const nodes = [];
  for (const stop of stops) {
    const home = nodes.find((n) => n.members[0].addressKey === stop.addressKey || haversineKm(n.members[0], stop) <= CLUSTER_KM);
    if (home) home.members.push(stop);
    else nodes.push({ latitude: stop.latitude, longitude: stop.longitude, members: [stop] });
  }
  return nodes;
}

function twoOpt(path, nodes, start, d) {
  const seq = [null, ...path]; // index 0 is the fixed start point
  const at = (i) => (i === 0 ? start : nodes[seq[i]]);
  const k = seq.length - 1;
  for (let pass = 0; pass < 60; pass += 1) {
    let improved = false;
    for (let i = 1; i < k; i += 1) {
      for (let j = i + 1; j <= k; j += 1) {
        const a = at(i - 1), b = at(i), c = at(j), next = j < k ? at(j + 1) : null;
        const before = d(a, b) + (next ? d(c, next) : 0);
        const after = d(a, c) + (next ? d(b, next) : 0);
        if (after + 1e-9 < before) {
          const reversed = seq.slice(i, j + 1).reverse();
          seq.splice(i, reversed.length, ...reversed);
          improved = true;
        }
      }
    }
    if (!improved) break;
  }
  return seq.slice(1);
}
