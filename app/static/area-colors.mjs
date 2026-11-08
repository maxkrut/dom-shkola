/* Presentation only: conservative neighbours from the already loaded extents.
 * Intersecting/touching polygons necessarily have intersecting extents. Nearby
 * extents (about 30 m at Petersburg's latitude) also conflict across a street.
 * False neighbours cost extra tones, never equal colours for actual neighbours.
 * Compute once per metadata package, not on selection, zoom or pointer movement.
 */
export function areaNeighbours(features) {
  const graph = features.map(() => new Set());
  const order = features.map((feature, i) => ({ i, b: feature.bbox }))
    .sort((a, b) => a.b[0] - b.b[0] || a.i - b.i);
  const dx = 0.00055, dy = 0.00027;
  let active = [];
  for (const current of order) {
    active = active.filter(other => other.b[2] + dx >= current.b[0]);
    for (const other of active) {
      if (other.b[1] > current.b[3] + dy || current.b[1] > other.b[3] + dy) continue;
      graph[current.i].add(other.i);
      graph[other.i].add(current.i);
    }
    active.push(current);
  }
  return graph;
}

// Widely separated tones first, as tints and shades of the district colour.
function tone(base, slot) {
  let fraction = 0, n = slot + 1, divisor = 2;
  while (n) { fraction += (n % 2) / divisor; n = Math.floor(n / 2); divisor *= 2; }
  const amount = -0.68 + 1.38 * fraction;
  const rgb = base.slice(1).match(/../g).map(value => parseInt(value, 16));
  return '#' + rgb.map(value => Math.round(amount < 0 ? value * (1 + amount)
    : value + (255 - value) * amount).toString(16).padStart(2, '0')).join('');
}

export function buildAreaColorPlan(features, colors) {
  const graph = areaNeighbours(features), groups = new Map();
  features.forEach((feature, i) => {
    const district = feature.properties.district;
    if (!groups.has(district)) groups.set(district, []);
    groups.get(district).push(i);
  });
  const slots = features.map(() => -1), byFID = new Map(), districtTones = {};
  for (const [district, members] of [...groups].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const base = colors[district] || '#00C084';
    if (!/^#[a-f\d]{6}$/i.test(base)) throw new Error('Некорректный цвет района');
    const remaining = new Set(members), saturation = new Map(members.map(i => [i, new Set()]));
    while (remaining.size) {
      let next;
      for (const i of remaining) {
        if (next === undefined || saturation.get(i).size > saturation.get(next).size
          || (saturation.get(i).size === saturation.get(next).size
            && (graph[i].size > graph[next].size || (graph[i].size === graph[next].size
              && features[i].fid < features[next].fid)))) next = i;
      }
      let slot = 0;
      const usedRGB = new Set([...graph[next]].map(i => byFID.get(features[i].fid)));
      while (saturation.get(next).has(slot) || usedRGB.has(tone(base, slot))) slot++;
      slots[next] = slot;
      byFID.set(features[next].fid, tone(base, slot));
      remaining.delete(next);
      for (const neighbour of graph[next]) if (remaining.has(neighbour)) saturation.get(neighbour).add(slot);
    }
    districtTones[district] = Math.max(...members.map(i => slots[i])) + 1;
  }
  // Reject RGB rounding collisions as well as graph-colouring mistakes.
  let edges = 0;
  graph.forEach((neighbours, i) => {
    for (const j of neighbours) if (j > i) {
      edges++;
      if (byFID.get(features[i].fid) === byFID.get(features[j].fid)) {
        throw new Error('Соседние школьные участки получили одинаковый цвет');
      }
    }
  });
  return { byFID, districtTones, edges };
}

export function colorizeAreaFeatures(features, colors) {
  const records = features.map(feature => {
    const bbox = [Infinity, Infinity, -Infinity, -Infinity];
    const visit = coordinates => {
      if (typeof coordinates[0] === 'number') {
        bbox[0] = Math.min(bbox[0], coordinates[0]); bbox[2] = Math.max(bbox[2], coordinates[0]);
        bbox[1] = Math.min(bbox[1], coordinates[1]); bbox[3] = Math.max(bbox[3], coordinates[1]);
      } else coordinates.forEach(visit);
    };
    visit(feature.geometry.coordinates);
    return { fid: feature.properties.shared_area_key || feature.properties.school_key, bbox, properties: feature.properties };
  });
  const plan = buildAreaColorPlan(records, colors);
  return features.map((feature, i) => ({ ...feature, properties: { ...feature.properties,
    area_color: plan.byFID.get(records[i].fid) } }));
}

export function areaColorExpression(plan, fallback) {
  return plan.byFID.size ? ['match', ['get', 'fid'], ...[...plan.byFID].flat(), fallback] : fallback;
}
