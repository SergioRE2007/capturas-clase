'use strict';
// Reducción por promedio de área (equivalente a INTER_AREA; sustituye al canvas 'medium' en los tests).
// img: {width,height,data RGBA}; recorte [sx,sy,sw,sh] → RGB Uint8Array outW×outH.
function areaResize(img, sx, sy, sw, sh, outW, outH) {
  const out = new Uint8Array(outW * outH * 3), d = img.data, W = img.width;
  const fx = sw / outW, fy = sh / outH;
  for (let oy = 0; oy < outH; oy++) {
    const y0 = sy + oy * fy, y1 = y0 + fy;
    for (let ox = 0; ox < outW; ox++) {
      const x0 = sx + ox * fx, x1 = x0 + fx;
      let r = 0, g = 0, b = 0, a = 0;
      for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
          const wx = Math.min(x + 1, x1) - Math.max(x, x0), wgt = wx * wy, i = (y * W + x) * 4;
          r += d[i] * wgt; g += d[i + 1] * wgt; b += d[i + 2] * wgt; a += wgt;
        }
      }
      const k = (oy * outW + ox) * 3;
      out[k] = Math.round(r / a); out[k + 1] = Math.round(g / a); out[k + 2] = Math.round(b / a);
    }
  }
  return out;
}
module.exports = { areaResize };
