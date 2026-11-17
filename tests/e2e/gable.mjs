// A test photo of a gable end for "Pitch from a photo", drawn on a canvas in the page (so no image
// library is needed) and returned as PNG bytes in base64. The house is drawn turned by `tilt` degrees
// about the photo's centre, like a phone held at an angle; `turn` gives where a point of the
// untilted drawing ends up, for tapping it.
//
// gable = { W, H, L: [x, y], P: [x, y], R: [x, y], tilt }: photo size, the left eave corner, the
// peak and the right eave corner (the eave corners level), in photo pixels.

export function turn(gable, [x, y]) {
  const a = (gable.tilt * Math.PI) / 180;
  const cx = gable.W / 2;
  const cy = gable.H / 2;
  return [cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a), cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a)];
}

/** Runs in the page: page.evaluate(drawGable, gable). */
export function drawGable({ W, H, L, P, R, tilt }) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const u = (R[0] - L[0]) / 1000; // drawing unit: 1/1000 of the eave-to-eave span
  g.fillStyle = '#5f7f55';
  g.fillRect(0, 0, W, H);
  g.save();
  g.translate(W / 2, H / 2);
  g.rotate((tilt * Math.PI) / 180);
  g.translate(-W / 2, -H / 2);
  const sky = g.createLinearGradient(0, -H, 0, H);
  sky.addColorStop(0, '#5d93c9');
  sky.addColorStop(1, '#d6e5f0');
  g.fillStyle = sky;
  g.fillRect(-W, -H, 3 * W, L[1] + H + 240 * u);
  g.fillStyle = '#6e8c4c';
  g.fillRect(-W, L[1] + 240 * u, 3 * W, 2 * H);
  const wallTop = L[1] + 10 * u;
  const bottom = L[1] + 260 * u;
  const slope = (L[1] - P[1]) / ((R[0] - L[0]) / 2);
  // Siding under the roof.
  g.beginPath();
  g.moveTo(L[0] + 20 * u, bottom);
  g.lineTo(L[0] + 20 * u, wallTop);
  g.lineTo(P[0], P[1] + (10 + 20 * slope) * u);
  g.lineTo(R[0] - 20 * u, wallTop);
  g.lineTo(R[0] - 20 * u, bottom);
  g.closePath();
  g.fillStyle = '#d5d8ce';
  g.fill();
  g.save();
  g.clip();
  g.strokeStyle = 'rgba(90,96,88,.35)';
  g.lineWidth = 2 * u;
  for (let y = P[1]; y < bottom; y += 14 * u) {
    g.beginPath();
    g.moveTo(L[0], y);
    g.lineTo(R[0], y);
    g.stroke();
  }
  g.restore();
  // Rake trim along both roof edges, running past the eave corners by a short overhang.
  const over = 30 * u;
  g.lineJoin = 'miter';
  g.strokeStyle = '#34383d';
  g.lineWidth = 16 * u;
  g.beginPath();
  g.moveTo(L[0] - over, L[1] + over * slope);
  g.lineTo(P[0], P[1]);
  g.lineTo(R[0] + over, R[1] + over * slope);
  g.stroke();
  g.strokeStyle = '#f1f0ea';
  g.lineWidth = 6 * u;
  g.beginPath();
  g.moveTo(L[0], L[1] + 12 * u);
  g.lineTo(P[0], P[1] + 12 * u);
  g.lineTo(R[0], R[1] + 12 * u);
  g.stroke();
  const win = (x, y) => {
    g.fillStyle = '#f1f0ea';
    g.fillRect(x - 6 * u, y - 6 * u, 92 * u, 112 * u);
    g.fillStyle = '#4f667c';
    g.fillRect(x, y, 80 * u, 100 * u);
    g.strokeStyle = '#f1f0ea';
    g.lineWidth = 4 * u;
    g.beginPath();
    g.moveTo(x + 40 * u, y);
    g.lineTo(x + 40 * u, y + 100 * u);
    g.moveTo(x, y + 50 * u);
    g.lineTo(x + 80 * u, y + 50 * u);
    g.stroke();
  };
  win(L[0] + 70 * u, wallTop + 60 * u);
  win(R[0] - 150 * u, wallTop + 60 * u);
  g.fillStyle = '#7a3e2e';
  g.fillRect(P[0] - 35 * u, bottom - 150 * u, 70 * u, 150 * u);
  g.restore();
  return c.toDataURL('image/png').split(',')[1];
}
